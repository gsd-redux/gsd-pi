import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export interface HermesInstallOptions {
  hermesHome: string
  pluginSource: string
  project?: string
  dryRun: boolean
  skipPip: boolean
  skipEnable: boolean
}

export interface HermesInstallResult {
  pluginTarget: string
  configPath: string
  actions: string[]
  warnings: string[]
}

const PLUGIN_NAME = 'open-gsd-hermes'

export async function runHermesIntegrationCommand(argv: string[]): Promise<number> {
  const sub = argv[3]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printHermesHelp()
    return 0
  }
  if (sub !== 'install') {
    process.stderr.write(`[gsd] Unknown hermes command: ${sub}\n`)
    printHermesHelp(process.stderr)
    return 1
  }

  let options: HermesInstallOptions
  try {
    options = parseHermesInstallArgs(argv.slice(4))
  } catch (err) {
    process.stderr.write(`[gsd] hermes install: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  try {
    const result = installHermesPlugin(options)
    for (const action of result.actions) process.stdout.write(`✓ ${action}\n`)
    for (const warning of result.warnings) process.stderr.write(`[gsd] Warning: ${warning}\n`)
    process.stdout.write(`\nHermes plugin installed at: ${result.pluginTarget}\n`)
    process.stdout.write(`Config path: ${result.configPath}\n`)
    process.stdout.write('Next: restart Hermes/gateway, then run `hermes plugins list` and `/gsd status`.\n')
    return 0
  } catch (err) {
    process.stderr.write(`[gsd] hermes install failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

export function parseHermesInstallArgs(args: string[]): HermesInstallOptions {
  let hermesHome = process.env.HERMES_HOME || join(homedir(), '.hermes')
  let pluginSource = process.env.GSD_HERMES_PLUGIN_SOURCE || findBundledHermesPluginSource()
  let project: string | undefined
  let dryRun = false
  let skipPip = false
  let skipEnable = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = () => {
      const value = args[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--hermes-home') hermesHome = next()
    else if (arg === '--plugin-source') pluginSource = next()
    else if (arg === '--project') project = next()
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--skip-pip') skipPip = true
    else if (arg === '--skip-enable') skipEnable = true
    else throw new Error(`unknown option: ${arg}`)
  }

  return {
    hermesHome: expandHome(hermesHome),
    pluginSource: expandHome(pluginSource),
    project: project ? resolve(expandHome(project)) : undefined,
    dryRun,
    skipPip,
    skipEnable,
  }
}

export function installHermesPlugin(options: HermesInstallOptions): HermesInstallResult {
  const source = resolve(options.pluginSource)
  if (!existsSync(join(source, 'plugin.yaml'))) {
    throw new Error(`plugin source does not contain plugin.yaml: ${source}`)
  }

  const hermesHome = resolve(options.hermesHome)
  const pluginRoot = join(hermesHome, 'plugins')
  const pluginTarget = join(pluginRoot, PLUGIN_NAME)
  const configPath = join(hermesHome, 'gsd.yaml')
  const actions: string[] = []
  const warnings: string[] = []

  if (!options.dryRun) {
    mkdirSync(pluginRoot, { recursive: true })
    if (existsSync(pluginTarget)) {
      rmSync(pluginTarget, { recursive: true, force: true })
    }
    cpSync(source, pluginTarget, {
      recursive: true,
      filter: (src) => !src.includes('__pycache__') && !src.includes('.pytest_cache'),
    })
  }
  actions.push(`${options.dryRun ? 'Would copy' : 'Copied'} ${PLUGIN_NAME} into Hermes plugin directory`)

  const config = renderGsdYaml(options.project)
  if (!existsSync(configPath)) {
    if (!options.dryRun) writeFileSync(configPath, config, 'utf8')
    actions.push(`${options.dryRun ? 'Would create' : 'Created'} ${configPath}`)
  } else if (!readFileSync(configPath, 'utf8').includes('gsd:')) {
    warnings.push(`${configPath} exists but does not contain a gsd: section; merge the sample config from ${pluginTarget}/docs/setup.md`)
  } else {
    actions.push(`Left existing ${configPath} unchanged`)
  }

  if (!options.skipPip) {
    const python = findHermesPython(hermesHome)
    const pipArgs = ['-m', 'pip', 'install', '-e', pluginTarget]
    if (options.dryRun) {
      actions.push(`Would run ${python} ${pipArgs.join(' ')}`)
    } else {
      const pip = spawnSync(python, pipArgs, { stdio: 'pipe', encoding: 'utf8' })
      if (pip.status !== 0) {
        warnings.push(`Python package install failed with ${python}; Hermes may not import the plugin until you run: ${python} ${pipArgs.join(' ')}`)
        if (pip.stderr.trim()) warnings.push(pip.stderr.trim().split('\n').slice(-3).join(' | '))
      } else {
        actions.push('Installed Python package into Hermes environment')
      }
    }
  }

  if (!options.skipEnable) {
    if (options.dryRun) {
      actions.push(`Would run HERMES_HOME=${hermesHome} hermes plugins enable ${PLUGIN_NAME}`)
    } else {
      const enable = spawnSync('hermes', ['plugins', 'enable', PLUGIN_NAME], {
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, HERMES_HOME: hermesHome },
      })
      if (enable.status !== 0) {
        warnings.push(`Could not auto-enable plugin; run manually: HERMES_HOME=${hermesHome} hermes plugins enable ${PLUGIN_NAME}`)
      } else {
        actions.push('Enabled plugin in Hermes')
      }
    }
  }

  return { pluginTarget, configPath, actions, warnings }
}

function renderGsdYaml(project: string | undefined): string {
  const defaultProject = project ?? '~/code/myapp'
  return `# open-gsd-hermes configuration. Edit paths for your machine.\ngsd:\n  cli_path: gsd\n  mcp_server_path: gsd-mcp-server\n  credential_source: gsd\n  default_project: ${defaultProject}\n  poll_interval_seconds: 12\n  cache_ttl_seconds: 45\n  notification_level: normal\n  bindings: {}\n`
}

function findHermesPython(hermesHome: string): string {
  const suffix = process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')
  const bundled = join(hermesHome, 'hermes-agent', 'venv', suffix)
  if (existsSync(bundled)) return bundled
  return process.env.PYTHON || 'python3'
}

function findBundledHermesPluginSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(process.cwd(), 'integrations/hermes'),
    resolve(here, '../integrations/hermes'),
    resolve(here, '../../integrations/hermes'),
  ]
  const found = candidates.find((candidate) => existsSync(join(candidate, 'plugin.yaml')))
  return found ?? candidates[0]
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

function printHermesHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write('Usage: gsd hermes install [options]\n')
  stream.write('\nInstall the bundled open-gsd-hermes plugin into a Hermes Agent home.\n\n')
  stream.write('Options:\n')
  stream.write('  --hermes-home <path>    Hermes home (default: $HERMES_HOME or ~/.hermes)\n')
  stream.write('  --project <path>        Default GSD project to write into gsd.yaml\n')
  stream.write('  --plugin-source <path>  Override bundled integrations/hermes source\n')
  stream.write('  --skip-pip             Copy plugin only; do not pip install editable package\n')
  stream.write('  --skip-enable          Do not run hermes plugins enable\n')
  stream.write('  --dry-run              Print intended actions without writing\n')
}
