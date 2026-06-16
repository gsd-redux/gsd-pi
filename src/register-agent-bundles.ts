import { isBunBinary } from '@gsd/pi-coding-agent/config.js'
import { registerExtensionBundledModules } from '@gsd/pi-coding-agent/core/extensions/loader.js'

let registered = false

/**
 * Register GSD agent packages for extension virtual module resolution.
 *
 * The eager `@gsd/agent-core` and `@gsd/agent-modes` barrels are only consumed
 * by the Bun-binary extension loader (which has no filesystem and resolves
 * bundled packages through `virtualModules`). On the Node/dev path the loader
 * resolves those same specifiers by file path via `getAliases()`, so importing
 * the full barrels at startup there is ~400ms of wasted module loading.
 * Load them only when actually needed (Bun), keeping Node startup lean.
 */
export async function registerAgentBundles(): Promise<void> {
  if (registered) return
  registered = true
  if (!isBunBinary) return
  const [agentCore, agentModes] = await Promise.all([
    import('@gsd/agent-core'),
    import('@gsd/agent-modes'),
  ])
  registerExtensionBundledModules({
    '@gsd/agent-core': agentCore,
    '@gsd/agent-modes': agentModes,
  })
}
