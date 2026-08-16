/**
 * `gsd read` — JSON read seam for integrations (Hermes 6c).
 *
 *   gsd read progress --json --project /path
 *   gsd read roadmap --json --project /path [--milestone M001]
 *   gsd read memory --json --project /path --query "auth"
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from '@mariozechner/jiti'
import { graphQuery } from '@opengsd/mcp-server/readers/graph'
import { resolveGsdRoot } from '@opengsd/mcp-server/readers/paths'
import { readRoadmap } from '@opengsd/mcp-server/readers/roadmap'
import { readProgress } from '@opengsd/mcp-server/readers/state'
import { resolveBundledGsdExtensionModule } from './bundled-resource-path.js'
import { resolveGsdAgentExtensionsDir, shouldUseAgentExtensionsDir } from './headless-query.js'

export const INTEGRATION_VERSION = 1

// Extension modules are .ts files loaded via jiti (not compiled to .js) — the
// same constraint as headless-query (#1137). Used only for the read-only
// schema-version preflight below.
const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false })
const agentExtensionsDir = resolveGsdAgentExtensionsDir()
const { useAgentDir } = shouldUseAgentExtensionsDir({ env: process.env })
const gsdExtensionPath = (...segments: string[]) => {
  if (!useAgentDir) return resolveBundledGsdExtensionModule(import.meta.url, segments.join('/'))
  const requested = join(agentExtensionsDir, ...segments)
  if (existsSync(requested)) return requested
  if (segments.length === 1 && segments[0].endsWith('.ts')) {
    const jsPath = join(agentExtensionsDir, segments[0].replace(/\.ts$/, '.js'))
    if (existsSync(jsPath)) return jsPath
  }
  return requested
}

/**
 * Detect the engine's typed refuse-newer error (db/engine.ts
 * SchemaTooNewError) by its stable `name` contract — the error crosses a
 * jiti module-instance boundary to reach this seam.
 */
export function isSchemaTooNewErrorLike(err: unknown): err is Error {
  return err instanceof Error && err.name === 'GSDSchemaTooNewError'
}

/**
 * Injectable seam for the schema-version preflight — mirrors the
 * runHeadlessQuery(basePath, modules) pattern: production uses the
 * jiti-loaded extension modules; tests inject the same pieces loaded
 * through their own module graph.
 */
export interface ReadCliSchemaPreflight {
  openIsolatedDatabase: (path: string) => {
    prepare(sql: string): { get(): Record<string, unknown> | undefined }
    close(): void
  } | null
  supportedSchemaVersion: number
  createSchemaTooNewError: (currentVersion: number, supportedVersion: number) => Error
}

async function loadSchemaPreflight(): Promise<ReadCliSchemaPreflight> {
  const dbWorkspaceModule = await jiti.import(gsdExtensionPath('db-workspace.ts'), {}) as any
  const engineModule = await jiti.import(gsdExtensionPath('db/engine.ts'), {}) as any
  if (typeof dbWorkspaceModule.openWorkflowDatabaseIsolated !== 'function'
    || typeof engineModule.SCHEMA_VERSION !== 'number'
    || typeof engineModule.SchemaTooNewError !== 'function') {
    throw new Error('selected GSD extensions do not support schema-version preflight; synchronize the extension bundle')
  }
  return {
    openIsolatedDatabase: dbWorkspaceModule.openWorkflowDatabaseIsolated,
    supportedSchemaVersion: engineModule.SCHEMA_VERSION,
    createSchemaTooNewError: (currentVersion, supportedVersion) =>
      new engineModule.SchemaTooNewError(currentVersion, supportedVersion),
  }
}

/**
 * Read-only schema-version preflight. The markdown readers below never open
 * gsd.db, so without this guard `gsd read` would silently serve stale/empty
 * projections for a project cut over by a newer gsd-pi (T003 spike: silent
 * divergence). Opens the DB through the engine's isolated READ-ONLY path —
 * no migration, no global-handle side effects — and throws SchemaTooNewError
 * when the recorded schema version is newer than this binary supports. A
 * missing or unreadable DB keeps the existing degraded markdown behavior.
 */
export async function assertProjectDbSchemaSupported(
  dbPath: string,
  preflight?: ReadCliSchemaPreflight,
): Promise<void> {
  if (!existsSync(dbPath)) return
  const pf = preflight ?? await loadSchemaPreflight()
  const db = pf.openIsolatedDatabase(dbPath)
  if (!db) return
  try {
    const hasVersionTable = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get()
    if (!hasVersionTable) return
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()
    const currentVersion = typeof row?.v === 'number' ? row.v : 0
    if (currentVersion > pf.supportedSchemaVersion) {
      throw pf.createSchemaTooNewError(currentVersion, pf.supportedSchemaVersion)
    }
  } finally {
    db.close()
  }
}

export type ReadKind = 'progress' | 'roadmap' | 'memory'

export interface ReadEnvelope<T = unknown> {
  integration_version: number
  kind: ReadKind
  projectDir: string
  data: T
}

export interface ReadCliOptions {
  kind: ReadKind
  project: string
  milestone?: string
  query?: string
  json: boolean
}

function parseReadArgs(argv: string[]): ReadCliOptions | null {
  const readIndex = argv.indexOf('read', 2)
  if (readIndex === -1) return null
  const args = argv.slice(readIndex + 1)
  if (args.length < 1) return null
  const kind = args[0] as ReadKind
  if (!['progress', 'roadmap', 'memory'].includes(kind)) return null

  let project: string | undefined
  let milestone: string | undefined
  let query: string | undefined
  let json = false

  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') json = true
    else if (a === '--project' && i + 1 < args.length) project = args[++i]
    else if (a === '--milestone' && i + 1 < args.length) milestone = args[++i]
    else if (a === '--query' && i + 1 < args.length) query = args[++i]
  }

  if (!project) return null
  return { kind, project, milestone, query, json }
}

export async function runReadCli(argv: string[], preflight?: ReadCliSchemaPreflight): Promise<number> {
  const opts = parseReadArgs(argv)
  if (!opts) {
    process.stderr.write(
      'Usage: gsd read <progress|roadmap|memory> --json --project <path> [--milestone M001] [--query text]\n',
    )
    return 1
  }

  const projectDir = resolve(opts.project)
  let gsdRoot: string
  try {
    gsdRoot = resolveGsdRoot(projectDir)
  } catch (err) {
    process.stderr.write(
      `[gsd read] ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  try {
    await assertProjectDbSchemaSupported(join(gsdRoot, 'gsd.db'), preflight)
  } catch (err) {
    if (isSchemaTooNewErrorLike(err)) {
      // Version skew must refuse loudly: exact engine message, non-zero exit —
      // never serve a degraded all-zero payload with exit 0.
      process.stderr.write(`[gsd] ${err.message}\n`)
      return 1
    }
    throw err
  }

  let data: unknown
  switch (opts.kind) {
    case 'progress':
      data = readProgress(projectDir)
      break
    case 'roadmap':
      data = readRoadmap(projectDir, opts.milestone)
      break
    case 'memory': {
      const term = opts.query?.trim() || ''
      if (term.length < 2) {
        process.stderr.write('[gsd read] memory requires --query with at least 2 characters\n')
        return 1
      }
      data = await graphQuery(projectDir, term)
      break
    }
    default:
      return 1
  }

  const envelope: ReadEnvelope = {
    integration_version: INTEGRATION_VERSION,
    kind: opts.kind,
    projectDir,
    data,
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
  } else {
    process.stdout.write(JSON.stringify(envelope.data, null, 2) + '\n')
  }
  return 0
}
