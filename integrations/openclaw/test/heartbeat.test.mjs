import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('heartbeat receives factual project context without a skill or scheduled prompt', async (t) => {
  assert.ok(process.env.OPENCLAW_BIN, 'Set OPENCLAW_BIN to the isolated OpenClaw host');
  const require = createRequire(await realpath(process.env.OPENCLAW_BIN));
  const sdk = new Map(['plugin-entry', 'gateway-runtime', 'agent-scope-runtime', 'routing']
    .map((name) => [`openclaw/plugin-sdk/${name}`, require.resolve(`openclaw/plugin-sdk/${name}`)]));
  // Resolve the public SDK from the same host as the installed-artifact test.
  const loader = registerHooks({ resolve(specifier, context, next) {
    return next(sdk.get(specifier) ?? specifier, context);
  } });
  t.after(() => loader.deregister());
  const { default: plugin } = await import('../dist/index.js');
  const root = await mkdtemp(join(tmpdir(), 'gsd-openclaw-heartbeat-'));
  const hooks = new Map();
  let service;
  const records = [{ controllerId: 'open-gsd-openclaw.projects', flowId: 'flow-1', stateJson: { projectDir: '/fixture', phase: 'executing' } },
    { controllerId: 'another-plugin', flowId: 'private', stateJson: { projectDir: '/other' } }];
  const cfg = { agents: { defaults: { workspace: root } }, mcp: { servers: { gsd: { env: { GSD_HOME: root } } } } };
  plugin.register({
    config: cfg, logger: { warn: assert.fail },
    registerService: (value) => { service = value; },
    on: (name, handler) => hooks.set(name, handler),
    runtime: {
      tasks: { managedFlows: { bindSession: () => ({ list: () => records }) } },
      agent: { resolveAgentWorkspaceDir: () => root, session: { listSessionEntries: () => [] } },
      system: { enqueueSystemEvent: assert.fail, requestHeartbeat: assert.fail },
    },
  });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  service.start({ config: cfg });
  const contribute = hooks.get('heartbeat_prompt_contribution');
  const context = JSON.parse(contribute({ sessionKey: 'agent:main:main' }).appendContext);
  assert.deepEqual(context.projects, [{ flowId: 'flow-1', projectDir: '/fixture', phase: 'executing' }]);
  assert.equal(contribute({ sessionKey: 'agent:other:main' }), undefined, 'operator data stays with its owner');
  records[0].endedAt = Date.now();
  assert.equal(contribute({ sessionKey: 'agent:main:main' }), undefined);
  await service.stop();
  assert.equal(contribute({ sessionKey: 'agent:main:main' }), undefined, 'a stopped service contributes no stale context');
});
