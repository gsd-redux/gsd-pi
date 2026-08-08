// GSD Extension — state contract v1 tests
// Tests buildStateContract routing and the .gsd/state.json write alongside the manifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from '../gsd-db.ts';
import { writeManifest, flushManifest } from '../workflow-manifest.ts';
import { buildStateContract } from '../state-contract.ts';
import type { MilestoneRow } from '../db-milestone-artifact-rows.ts';
import type { SliceRow } from '../db-task-slice-rows.ts';

const NOW = '2026-08-08T00:00:00.000Z';

function milestone(overrides: Partial<MilestoneRow>): MilestoneRow {
  return {
    id: 'M001',
    title: 'Hardening',
    status: 'active',
    depends_on: [],
    created_at: NOW,
    completed_at: null,
    vision: '',
    success_criteria: [],
    key_risks: [],
    proof_strategy: [],
    verification_contract: '',
    verification_integration: '',
    verification_operational: '',
    verification_uat: '',
    definition_of_done: [],
    requirement_coverage: '',
    boundary_map_markdown: '',
    sequence: 1,
    ...overrides,
  };
}

function slice(overrides: Partial<SliceRow>): SliceRow {
  return {
    milestone_id: 'M001',
    id: 'S1',
    title: 'Slice one',
    status: 'pending',
    risk: '',
    depends: [],
    demo: '',
    created_at: NOW,
    completed_at: null,
    full_summary_md: '',
    full_uat_md: '',
    goal: '',
    success_criteria: '',
    proof_level: '',
    integration_closure: '',
    observability_impact: '',
    target_repositories: [],
    sequence: 1,
    replan_triggered_at: null,
    is_sketch: 0,
    sketch_scope: '',
    ...overrides,
  };
}

test('state-contract: no active milestone routes to start', () => {
  const doc = buildStateContract([milestone({ status: 'complete' })], [], NOW);
  assert.equal(doc.contract, '1.0.0');
  assert.equal(doc.flavor, 'pi');
  assert.equal(doc.milestone, null);
  assert.deepEqual(doc.phases, []);
  assert.equal(doc.next.command, '/gsd');
  assert.equal(doc.updated_at, NOW);
});

test('state-contract: queued milestone counts as active (canonical non-terminal rule)', () => {
  const doc = buildStateContract([milestone({ status: 'complete' }), milestone({ id: 'M002', title: 'Next', status: 'queued' })], [], NOW);
  assert.equal(doc.milestone, 'M002 — Next');
  assert.equal(doc.next.label, 'Plan M002');
});

test('state-contract: active milestone maps slices to phases with status vocabulary', () => {
  const doc = buildStateContract(
    [milestone({ id: 'M002', title: 'M002: Reservations', status: 'active' })],
    [
      slice({ milestone_id: 'M002', id: 'S1', title: 'Schema', status: 'done', sequence: 1 }),
      slice({ milestone_id: 'M002', id: 'S2', title: 'Reader', status: 'in-progress', sequence: 2 }),
      slice({ milestone_id: 'M002', id: 'S3', title: 'Upstream', status: 'planned', sequence: 3 }),
      slice({ milestone_id: 'OTHER', id: 'S9', title: 'Elsewhere', status: 'pending', sequence: 1 }),
    ],
    NOW,
  );
  assert.equal(doc.milestone, 'M002 — Reservations');
  assert.deepEqual(doc.phases, [
    { number: 1, name: 'Schema', status: 'complete' },
    { number: 2, name: 'Reader', status: 'in_progress' },
    { number: 3, name: 'Upstream', status: 'pending' },
  ]);
  assert.deepEqual(doc.next, {
    command: '/gsd auto',
    label: 'Continue Reader',
    reason: 'Slice 2 in progress',
  });
});

test('state-contract: all slices closed routes to complete milestone', () => {
  const doc = buildStateContract(
    [milestone({ status: 'active' })],
    [slice({ status: 'complete' }), slice({ id: 'S2', status: 'skipped', sequence: 2 })],
    NOW,
  );
  assert.equal(doc.next.label, 'Complete M001');
});

test('state-contract: pending slice with none in progress routes to start slice', () => {
  const doc = buildStateContract(
    [milestone({ status: 'active' })],
    [slice({ status: 'complete' }), slice({ id: 'S2', title: 'Next up', status: 'pending', sequence: 2 })],
    NOW,
  );
  assert.deepEqual(doc.next, { command: '/gsd auto', label: 'Start Next up', reason: 'Slice 2 is next' });
});

test('state-contract: writeManifest also writes .gsd/state.json', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-state-contract-'));
  t.after(() => {
    closeDatabase();
    fs.rmSync(base, { recursive: true, force: true });
  });
  openDatabase(path.join(base, 'test.db'));

  insertMilestone({ id: 'M001', title: 'Hardening', status: 'active' });
  insertSlice({ id: 'S1', milestoneId: 'M001', title: 'Schema', status: 'in_progress', sequence: 1 });
  writeManifest(base);
  await flushManifest(base);
  const doc = JSON.parse(fs.readFileSync(path.join(base, '.gsd', 'state.json'), 'utf-8'));
  assert.equal(doc.contract, '1.0.0');
  assert.equal(doc.flavor, 'pi');
  assert.equal(doc.milestone, 'M001 — Hardening');
  assert.deepEqual(doc.phases, [{ number: 1, name: 'Schema', status: 'in_progress' }]);
  assert.equal(doc.next.command, '/gsd auto');
  assert.ok(typeof doc.updated_at === 'string' && doc.updated_at.length > 0);
});

test('state-contract: flushManifest drains all writes before reporting a failure', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-state-contract-flush-'));
  let releaseContractWrite: (() => void) | undefined;
  t.after(async () => {
    releaseContractWrite?.();
    await flushManifest(base).catch(() => {});
    closeDatabase();
    fs.rmSync(base, { recursive: true, force: true });
  });
  openDatabase(path.join(base, 'test.db'));

  const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
  let markContractWriteStarted: (() => void) | undefined;
  const contractWriteStarted = new Promise<void>((resolve) => {
    markContractWriteStarted = resolve;
  });
  const contractWriteBlocked = new Promise<void>((resolve) => {
    releaseContractWrite = resolve;
  });
  let contractWriteCompleted = false;
  type WriteFileArgs = Parameters<typeof fs.promises.writeFile>;
  t.mock.method(
    fs.promises,
    'writeFile',
    async (filePath: WriteFileArgs[0], data: WriteFileArgs[1], options: WriteFileArgs[2]) => {
      const target = String(filePath);
      if (target.includes('state-manifest.json.tmp.')) {
        throw new Error('manifest write failed');
      }
      if (target.includes('state.json.tmp.')) {
        markContractWriteStarted?.();
        await contractWriteBlocked;
        contractWriteCompleted = true;
      }
      return originalWriteFile(filePath, data, options);
    },
  );

  writeManifest(base);
  const flush = flushManifest(base);
  const flushOutcome = flush.then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  );
  await contractWriteStarted;
  const outcomeBeforeRelease = await Promise.race([
    flushOutcome,
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  releaseContractWrite?.();

  assert.equal(outcomeBeforeRelease, 'pending');
  await assert.rejects(flush, /manifest write failed/);
  assert.equal(contractWriteCompleted, true);
});
