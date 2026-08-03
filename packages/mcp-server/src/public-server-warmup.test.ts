import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpServer, SessionManager } from './index.js';

test('createMcpServer fails closed when explicitly enabling workflow tools', async (t) => {
  const previousExecutorsModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
  const sessionManager = new SessionManager();
  process.env.GSD_WORKFLOW_EXECUTORS_MODULE = 'data:text/javascript,export default {}';

  t.after(async () => {
    if (previousExecutorsModule === undefined) {
      delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    } else {
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = previousExecutorsModule;
    }
    await sessionManager.cleanup();
  });

  await assert.rejects(
    () => createMcpServer(sessionManager, { includeWorkflowTools: true }),
    /GSD_WORKFLOW_EXECUTORS_MODULE only supports file: URLs or filesystem paths/,
  );
});
