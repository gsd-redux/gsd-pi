import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GSD_MCP_PROBE_ENV, isMcpProbeSession } from './probe-mode.js';

describe('isMcpProbeSession', () => {
  test('returns false when probe env is unset', () => {
    assert.equal(isMcpProbeSession({}), false);
  });

  test('returns true for common truthy values', () => {
    assert.equal(isMcpProbeSession({ [GSD_MCP_PROBE_ENV]: '1' }), true);
    assert.equal(isMcpProbeSession({ [GSD_MCP_PROBE_ENV]: 'true' }), true);
    assert.equal(isMcpProbeSession({ [GSD_MCP_PROBE_ENV]: 'yes' }), true);
  });

  test('returns false for other values', () => {
    assert.equal(isMcpProbeSession({ [GSD_MCP_PROBE_ENV]: '0' }), false);
    assert.equal(isMcpProbeSession({ [GSD_MCP_PROBE_ENV]: 'false' }), false);
  });
});
