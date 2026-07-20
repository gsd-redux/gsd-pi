// GSD Web — Cloud file-system client (ADR-047 web convergence).
//
// In cloud mode the file-browser API routes proxy to the gateway's internal
// fs endpoint instead of reading the Next host's local disk. Every operation
// (readdir/read/stat/write) is a POST carrying an fs channel message that the
// gateway forwards to the device's daemon; the daemon's result message comes
// back in the response's `result` field.
//
// Wire contract (must match the gateway's /internal/fs handler):
//   POST {GATEWAY_INTERNAL_URL}/internal/fs
//        Authorization: Bearer GATEWAY_INTERNAL_TOKEN
//        body {
//          userId,       // device OWNER's user id — the gateway verifies runtime ownership
//          runtimeId,    // the device id
//          projectAlias, // advertised project alias — scopes the fs request to one
//                        // project on the device (the gateway routes by it)
//          message: {
//            channel: "fs",
//            type: "fs.readdir" | "fs.read" | "fs.stat" | "fs.write",
//            requestId, path, showHidden?, content?, expectedMtime?, expectedSize?,
//          },
//        }
//        → 200 { result: <daemon fs.*.result message> }
//        → 502 { error } on gateway-level failure (device offline, timeout, unauthorized)
//   Daemon-level failures arrive as 200 with result.type === "fs.error".

import { randomUUID } from "node:crypto"
import { getCloudModeConfig } from "./cloud-mode.ts"

export interface CloudFsEntry {
  name: string
  type: "file" | "directory"
}

export interface CloudFsStat {
  size: number
  isDirectory: boolean
  isFile: boolean
}

export interface CloudFsContext {
  /** Device owner's user id — the gateway verifies runtime ownership against it. */
  owner: string
  deviceId: string
  projectAlias: string
}

/** Daemon fs.*.result message as forwarded by the gateway. */
type FsResult = Record<string, unknown> & { type?: string }

function cloudFsError(message: string, status: number): Error & { status: number } {
  const error = new Error(message) as Error & { status: number }
  error.status = status
  return error
}

async function cloudFsRequest(
  type: "fs.readdir" | "fs.read" | "fs.stat" | "fs.write",
  context: CloudFsContext,
  message: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<FsResult> {
  const { gatewayInternalUrl, gatewayInternalToken } = getCloudModeConfig()

  const url = new URL(gatewayInternalUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/internal/fs`
  url.search = ""

  const response = await fetchFn(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gatewayInternalToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: context.owner,
      runtimeId: context.deviceId,
      projectAlias: context.projectAlias,
      message: {
        channel: "fs",
        type,
        requestId: randomUUID(),
        ...message,
      },
    }),
  })

  if (!response.ok) {
    // Gateway-level failure (device offline, timeout, unauthorized) — pass the message through.
    let text = `fs ${type} failed (HTTP ${response.status})`
    try {
      const body = (await response.json()) as { error?: string }
      if (typeof body.error === "string" && body.error) {
        text = body.error
      }
    } catch {
      // Keep the HTTP-status message.
    }
    throw cloudFsError(text, response.status)
  }

  const body = (await response.json()) as { result?: FsResult }
  const result = body.result
  if (!result || typeof result !== "object") {
    throw cloudFsError(`fs ${type} response missing result`, 502)
  }

  // Daemon-level failure: a missing path maps to 404 so callers can treat it
  // like a local ENOENT; anything else is a daemon-side error.
  if (result.type === "fs.error") {
    const text = typeof result.error === "string" && result.error ? result.error : `fs ${type} failed`
    const status = /ENOENT|no such file or directory/i.test(text) ? 404 : 500
    throw cloudFsError(text, status)
  }

  return result
}

export async function cloudFsReaddir(
  context: CloudFsContext,
  path: string,
  fetchFn?: typeof fetch,
): Promise<CloudFsEntry[]> {
  const result = await cloudFsRequest("fs.readdir", context, { path, showHidden: false }, fetchFn)
  if (!Array.isArray(result.entries)) return []
  const entries: CloudFsEntry[] = []
  for (const entry of result.entries as Array<Record<string, unknown>>) {
    if (typeof entry?.name !== "string") continue
    // Symlinks render as files — the tree only recurses into real directories,
    // which also avoids following links that point outside the project root.
    entries.push({ name: entry.name, type: entry.type === "directory" ? "directory" : "file" })
  }
  return entries
}

export interface CloudFsReadResult {
  content: string
  mtime: number | null
}

export async function cloudFsReadFile(
  context: CloudFsContext,
  path: string,
  fetchFn?: typeof fetch,
): Promise<CloudFsReadResult> {
  const result = await cloudFsRequest("fs.read", context, { path }, fetchFn)
  if (typeof result.content !== "string") {
    throw new Error("fs read response missing content")
  }
  return {
    content: result.content,
    mtime: typeof result.mtime === "number" ? result.mtime : null,
  }
}

export async function cloudFsStat(
  context: CloudFsContext,
  path: string,
  fetchFn?: typeof fetch,
): Promise<CloudFsStat> {
  const result = await cloudFsRequest("fs.stat", context, { path }, fetchFn)
  // fs.stat reports a missing path as exists:false rather than an fs.error.
  if (result.exists === false) {
    throw cloudFsError(`File not found: ${path}`, 404)
  }
  return {
    size: typeof result.size === "number" ? result.size : 0,
    isDirectory: result.fileType === "directory",
    isFile: result.fileType === "file",
  }
}

export interface CloudFsWriteResult {
  success: boolean
  conflict: boolean
  currentContent: string | null
  currentMtime: number | null
}

export async function cloudFsWriteFile(
  context: CloudFsContext,
  path: string,
  content: string,
  expectedMtime: number | null = null,
  fetchFn?: typeof fetch,
): Promise<CloudFsWriteResult> {
  const result = await cloudFsRequest(
    "fs.write",
    context,
    { path, content, expectedMtime, expectedSize: null },
    fetchFn,
  )
  return {
    success: result.success === true,
    conflict: result.conflict === true,
    currentContent: typeof result.currentContent === "string" ? result.currentContent : null,
    currentMtime: typeof result.currentMtime === "number" ? result.currentMtime : null,
  }
}

// ─── Directory trees ─────────────────────────────────────────────────────────

export interface CloudFsTreeNode {
  name: string
  type: "file" | "directory"
  children?: CloudFsTreeNode[]
}

export interface CloudFsTreeOptions {
  /** Directory names to skip (e.g. node_modules) at every level. */
  skipDirs?: Set<string>
  /** Maximum recursion depth; defaults to 6. */
  maxDepth?: number
}

/**
 * Recursively build a file tree under `prefix` via the relay. Dotfiles are
 * skipped, missing directories yield an empty list, and entries are sorted
 * directories-first then by name — matching the local file-browser tree.
 */
export async function buildCloudFsTree(
  context: CloudFsContext,
  prefix: string,
  options: CloudFsTreeOptions = {},
  fetchFn?: typeof fetch,
): Promise<CloudFsTreeNode[]> {
  const maxDepth = options.maxDepth ?? 6

  async function walk(dir: string, depth: number): Promise<CloudFsTreeNode[]> {
    if (depth >= maxDepth) return []

    let entries: CloudFsEntry[]
    try {
      entries = await cloudFsReaddir(context, dir, fetchFn)
    } catch (err) {
      if ((err as { status?: number }).status === 404) return []
      throw err
    }

    const nodes: CloudFsTreeNode[] = []
    const dirNodes: CloudFsTreeNode[] = []
    const dirChildren: Promise<CloudFsTreeNode[]>[] = []

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (entry.type === "directory") {
        if (options.skipDirs?.has(entry.name)) continue
        const node: CloudFsTreeNode = { name: entry.name, type: "directory", children: [] }
        dirNodes.push(node)
        const childPrefix = dir ? `${dir}/${entry.name}` : entry.name
        dirChildren.push(walk(childPrefix, depth + 1))
      } else {
        nodes.push({ name: entry.name, type: "file" })
      }
    }

    const children = await Promise.all(dirChildren)
    for (let i = 0; i < dirNodes.length; i++) {
      dirNodes[i].children = children[i]
      nodes.push(dirNodes[i])
    }

    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return nodes
  }

  return walk(prefix, 0)
}
