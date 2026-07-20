// GSD Web — Cloud file-system client (ADR-047 web convergence).
//
// In cloud mode the file-browser API routes proxy to the gateway's internal
// fs endpoint instead of reading the Next host's local disk. Read operations
// (readdir/read/stat) use GET; the write operation uses POST. All requests
// carry the internal token and the device id from the cloud session cookie.
//
// Wire contract (must match the gateway's /internal/fs handler):
//   GET  {GATEWAY_INTERNAL_URL}/internal/fs?deviceId=&projectAlias=&op=readdir|read|stat&path=
//        → readdir: { entries: [{ name, type: "file" | "directory" }] }
//        → read:    { content: string }
//        → stat:    { size: number, isDirectory: boolean, isFile: boolean }
//   POST {GATEWAY_INTERNAL_URL}/internal/fs
//        body { deviceId, projectAlias, op: "write", path, content }
//        → { success: true }
//   Errors: non-2xx with an optional { error: string } body.

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
  deviceId: string
  projectAlias: string
}

function buildFsUrl(op: string, context: CloudFsContext, path: string): string {
  const { gatewayInternalUrl } = getCloudModeConfig()
  const url = new URL(gatewayInternalUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/internal/fs`
  url.search = ""
  url.searchParams.set("deviceId", context.deviceId)
  url.searchParams.set("projectAlias", context.projectAlias)
  url.searchParams.set("op", op)
  url.searchParams.set("path", path)
  return url.toString()
}

async function cloudFsRequest<T>(
  op: "readdir" | "read" | "stat" | "write",
  context: CloudFsContext,
  path: string,
  content?: string,
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const { gatewayInternalUrl, gatewayInternalToken } = getCloudModeConfig()

  let url: string
  let init: RequestInit
  if (op === "write") {
    const writeUrl = new URL(gatewayInternalUrl)
    writeUrl.pathname = `${writeUrl.pathname.replace(/\/+$/, "")}/internal/fs`
    writeUrl.search = ""
    url = writeUrl.toString()
    init = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gatewayInternalToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceId: context.deviceId,
        projectAlias: context.projectAlias,
        op,
        path,
        content,
      }),
    }
  } else {
    url = buildFsUrl(op, context, path)
    init = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${gatewayInternalToken}`,
      },
    }
  }

  const response = await fetchFn(url, init)
  if (!response.ok) {
    let message = `fs ${op} failed (HTTP ${response.status})`
    try {
      const body = (await response.json()) as { error?: string }
      if (typeof body.error === "string" && body.error) {
        message = body.error
      }
    } catch {
      // Keep the HTTP-status message.
    }
    const error = new Error(message) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return (await response.json()) as T
}

export async function cloudFsReaddir(
  context: CloudFsContext,
  path: string,
  fetchFn?: typeof fetch,
): Promise<CloudFsEntry[]> {
  const body = await cloudFsRequest<{ entries?: CloudFsEntry[] }>("readdir", context, path, undefined, fetchFn)
  return Array.isArray(body.entries) ? body.entries : []
}

export async function cloudFsReadFile(
  context: CloudFsContext,
  path: string,
  fetchFn?: typeof fetch,
): Promise<string> {
  const body = await cloudFsRequest<{ content?: string }>("read", context, path, undefined, fetchFn)
  if (typeof body.content !== "string") {
    throw new Error("fs read response missing content")
  }
  return body.content
}

export async function cloudFsStat(
  context: CloudFsContext,
  path: string,
  fetchFn?: typeof fetch,
): Promise<CloudFsStat> {
  return await cloudFsRequest<CloudFsStat>("stat", context, path, undefined, fetchFn)
}

export async function cloudFsWriteFile(
  context: CloudFsContext,
  path: string,
  content: string,
  fetchFn?: typeof fetch,
): Promise<void> {
  await cloudFsRequest<{ success?: boolean }>("write", context, path, content, fetchFn)
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
