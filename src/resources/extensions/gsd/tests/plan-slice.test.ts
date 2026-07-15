// GSD Extension — Plan-slice tool integration tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  _getAdapter,
  adoptOrTransitionLifecycle,
  closeDatabase,
  executeDomainOperation,
  getGateResults,
  getSlice,
  getSliceTasks,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  projectCanonicalStatusToLegacy,
  readDomainOperationFence,
} from '../gsd-db.ts';
import { handlePlanSlice as handlePlanSliceWithInvocation } from '../tools/plan-slice.ts';
import { handlePlanTask as handlePlanTaskWithInvocation } from '../tools/plan-task.ts';
import { internalPlanningInvocation } from '../planning-invocation.ts';
import { parsePlan } from '../parsers-legacy.ts';
import { deriveState, invalidateStateCache } from '../state.ts';

function handlePlanSlice(
  params: Parameters<typeof handlePlanSliceWithInvocation>[0],
  basePath: string,
) {
  return handlePlanSliceWithInvocation(params, basePath, internalPlanningInvocation());
}

function handlePlanTask(
  params: Parameters<typeof handlePlanTaskWithInvocation>[0],
  basePath: string,
) {
  return handlePlanTaskWithInvocation(params, basePath, internalPlanningInvocation());
}

function makeTmpBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-plan-slice-')));
  mkdirSync(join(base, '.gsd', 'phases', '01-test'), { recursive: true });
  mkdirSync(join(base, 'src', 'resources', 'extensions', 'gsd', 'tools'), { recursive: true });
  writeFileSync(join(base, 'src', 'resources', 'extensions', 'gsd', 'tools', 'plan-milestone.ts'), '// fixture\n', 'utf-8');
  writeFileSync(join(base, 'src', 'resources', 'extensions', 'gsd', 'tools', 'plan-task.ts'), '// fixture\n', 'utf-8');
  writeFileSync(join(base, 'stale-input.py'), '# fixture\n', 'utf-8');
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedParentSlice(): void {
  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.' });
}

function completeTask(taskId: string, completedAt: string): void {
  for (const [lifecycleStatus, legacyStatus] of [
    ['in_progress', 'active'],
    ['completed', 'complete'],
  ] as const) {
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: `test.task.${lifecycleStatus}`,
      idempotencyKey: `test/task/${taskId}/${lifecycleStatus}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: 'test',
      sourceTransport: 'test',
      payload: { taskId, lifecycleStatus },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: 'task',
        milestoneId: 'M001',
        sliceId: 'S02',
        taskId,
        lifecycleStatus,
      });
      projectCanonicalStatusToLegacy(context, {
        entity: 'task',
        milestoneId: 'M001',
        sliceId: 'S02',
        taskId,
        status: legacyStatus,
        ...(lifecycleStatus === 'completed' ? { completedAt } : {}),
      });
      return {
        events: [{ eventType: `test.task.${lifecycleStatus}`, entityType: 'task', entityId: taskId, payload: {}, destinations: ['test'] }],
        projections: [{ projectionKey: `test/task/${taskId.toLowerCase()}`, projectionKind: 'test', rendererVersion: '1' }],
      };
    });
  }
}

function validParams() {
  return {
    milestoneId: 'M001',
    sliceId: 'S02',
    goal: 'Persist slice planning through the DB.',
    successCriteria: '- Slice plan renders from DB\n- Task plan files are regenerated',
    proofLevel: 'integration',
    integrationClosure: 'Planning handlers now write DB rows and render plan artifacts.',
    observabilityImpact: '- Validation failures return structured errors\n- Cache invalidation is proven by parse-visible state updates',
    tasks: [
      {
        taskId: 'T01',
        title: 'Write slice handler',
        description: 'Implement the slice planning handler.',
        estimate: '45m',
        files: ['src/resources/extensions/gsd/tools/plan-slice.ts'],
        verify: 'node --test src/resources/extensions/gsd/tests/plan-slice.test.ts',
        inputs: ['src/resources/extensions/gsd/tools/plan-milestone.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tools/plan-slice.ts'],
        observabilityImpact: 'Tests exercise cache invalidation and render failure paths.',
      },
      {
        taskId: 'T02',
        title: 'Write task handler',
        description: 'Implement the task planning handler.',
        estimate: '30m',
        files: ['src/resources/extensions/gsd/tools/plan-task.ts'],
        verify: 'node --test src/resources/extensions/gsd/tests/plan-task.test.ts',
        inputs: ['src/resources/extensions/gsd/tools/plan-task.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tests/plan-task.test.ts'],
        observabilityImpact: 'Task-plan renders remain parse-compatible.',
      },
    ],
  };
}

test('handlePlanSlice writes slice/task planning state and renders plan artifacts', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();

    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const slice = getSlice('M001', 'S02');
    assert.ok(slice);
    assert.equal(slice?.goal, 'Persist slice planning through the DB.');
    assert.equal(slice?.proof_level, 'integration');

    const tasks = getSliceTasks('M001', 'S02');
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]?.title, 'Write slice handler');
    assert.equal(tasks[0]?.description, 'Implement the slice planning handler.');
    assert.equal(tasks[1]?.estimate, '30m');
    assert.deepEqual(slice?.target_repositories, ['project']);
    assert.deepEqual(tasks[0]?.target_repositories, ['project']);

    const planPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    assert.ok(existsSync(planPath), 'slice plan should be rendered to disk');
    const parsedPlan = parsePlan(readFileSync(planPath, 'utf-8'));
    assert.equal(parsedPlan.goal, 'Persist slice planning through the DB.');
    assert.equal(parsedPlan.tasks.length, 2);
    assert.equal(parsedPlan.tasks[0]?.id, 'T01');

    // Flat-phase: no per-task plan files — tasks are checkboxes inside the slice plan.
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice re-dispatch preserves completed task checkboxes', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();

    const first = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);

    const adapter = _getAdapter();
    assert.ok(adapter);
    adapter.prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-07-11T00:00:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S02' AND id = 'T01'
    `).run();

    const second = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in second), `unexpected error: ${'error' in second ? second.error : ''}`);

    const planPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    const parsedPlan = parsePlan(readFileSync(planPath, 'utf-8'));
    assert.equal(parsedPlan.tasks.find((task) => task.id === 'T01')?.done, true);
    assert.equal(parsedPlan.tasks.find((task) => task.id === 'T02')?.done, false);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice persists explicit slice/task target repositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const params = validParams();
    const result = await handlePlanSlice({
      ...params,
      targetRepositories: ['project'],
      tasks: [
        { ...params.tasks[0], targetRepositories: ['project'] },
        { ...params.tasks[1], targetRepositories: ['project'] },
      ],
    }, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const slice = getSlice('M001', 'S02');
    const task = getTask('M001', 'S02', 'T01');
    assert.deepEqual(slice?.target_repositories, ['project']);
    assert.deepEqual(task?.target_repositories, ['project']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice honors configured gate-evaluation gate sets', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    writeFileSync(
      join(base, '.gsd', 'PREFERENCES.md'),
      [
        '---',
        'gate_evaluation:',
        '  enabled: true',
        '  slice_gates:',
        '    - Q3',
        '  task_gates: false',
        '---',
      ].join('\n'),
      'utf-8',
    );

    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const gateIds = getGateResults('M001', 'S02').map((gate) => gate.gate_id).sort();
    assert.deepEqual(gateIds, ['Q3', 'Q8']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects unknown target repositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      targetRepositories: ['frontend'],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: unknown targetRepositories:/);
    assert.equal(getSliceTasks('M001', 'S02').length, 0, 'invalid target repositories must not persist');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice enforces absolute path scope to declared target repositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    mkdirSync(join(base, 'frontend'), { recursive: true });
    mkdirSync(join(base, 'backend'), { recursive: true });
    writeFileSync(
      join(base, '.gsd', 'PREFERENCES.md'),
      [
        '---',
        'workspace:',
        '  mode: parent',
        '  repositories:',
        '    frontend:',
        '      path: frontend',
        '    backend:',
        '      path: backend',
        '---',
      ].join('\n'),
      'utf-8',
    );

    const badPath = join(base, 'backend', 'src', 'server.ts');
    const result = await handlePlanSlice({
      ...validParams(),
      targetRepositories: ['frontend'],
      tasks: [
        {
          ...validParams().tasks[0],
          files: [badPath],
          targetRepositories: ['frontend'],
        },
      ],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /outside allowed repository roots/);
    assert.equal(getSliceTasks('M001', 'S02').length, 0, 'invalid scoped path must not persist');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice resolves relative task IO paths against declared target repository roots', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    mkdirSync(join(base, 'frontend'), { recursive: true });
    writeFileSync(join(base, 'frontend', 'app.js'), 'export {};\n', 'utf-8');
    writeFileSync(
      join(base, '.gsd', 'PREFERENCES.md'),
      [
        '---',
        'workspace:',
        '  mode: parent',
        '  repositories:',
        '    frontend:',
        '      path: frontend',
        '---',
      ].join('\n'),
      'utf-8',
    );

    const params = validParams();
    const result = await handlePlanSlice({
      ...params,
      targetRepositories: ['frontend'],
      tasks: [
        {
          ...params.tasks[0],
          files: ['app.js'],
          inputs: ['app.js'],
          expectedOutput: ['app.js'],
          targetRepositories: ['frontend'],
        },
      ],
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.deepEqual(getSliceTasks('M001', 'S02').map((task) => task.id), ['T01']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects relative traversal outside declared target repositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    mkdirSync(join(base, 'frontend'), { recursive: true });
    mkdirSync(join(base, 'backend'), { recursive: true });
    writeFileSync(
      join(base, '.gsd', 'PREFERENCES.md'),
      [
        '---',
        'workspace:',
        '  mode: parent',
        '  repositories:',
        '    frontend:',
        '      path: frontend',
        '    backend:',
        '      path: backend',
        '---',
      ].join('\n'),
      'utf-8',
    );

    const result = await handlePlanSlice({
      ...validParams(),
      targetRepositories: ['frontend'],
      tasks: [
        {
          ...validParams().tasks[0],
          files: ['../sibling-repo/src/server.ts'],
          targetRepositories: ['frontend'],
        },
      ],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /outside allowed repository roots/);
    assert.equal(getSliceTasks('M001', 'S02').length, 0, 'relative traversal outside scope must not persist');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice exact invocation replay preserves its public result and changed reuse conflicts', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));
  try {
    seedParentSlice();
    const invocation = {
      idempotencyKey: 'plan-slice/convergence-replay',
      sourceTransport: 'pi-tool' as const,
      actorType: 'agent',
      traceId: 'plan-slice/convergence-replay',
    };
    const first = await handlePlanSliceWithInvocation(validParams(), base, invocation);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);
    assert.deepEqual(Object.keys(first).sort(), ['milestoneId', 'planPath', 'sliceId', 'taskPlanPaths']);

    const replay = await handlePlanSliceWithInvocation(validParams(), base, invocation);
    assert.deepEqual(replay, first);
    const adapter = _getAdapter();
    assert.ok(adapter);
    assert.equal(adapter.prepare(
      "SELECT COUNT(*) AS count FROM workflow_operations WHERE idempotency_key = ?",
    ).get(invocation.idempotencyKey)?.count, 1);

    const conflict = await handlePlanSliceWithInvocation(
      { ...validParams(), goal: 'Changed semantics under the same key.' },
      base,
      invocation,
    );
    assert.ok('error' in conflict);
    assert.match(conflict.error, /idempotency conflict/i);
    assert.equal(adapter.prepare(
      "SELECT COUNT(*) AS count FROM workflow_operations WHERE idempotency_key = ?",
    ).get(invocation.idempotencyKey)?.count, 1);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice renders plan artifacts under worktree-local .gsd while using project DB', async () => {
  const base = makeTmpBase();
  const worktree = join(base, '.gsd', 'worktrees', 'M001');
  mkdirSync(join(worktree, '.gsd'), { recursive: true });
  // Mirror the project's phase dir into the worktree so resolveMilestonePath
  // finds it and the renderer targets the correct flat-phase location.
  mkdirSync(join(worktree, '.gsd', 'phases', '01-test'), { recursive: true });
  mkdirSync(join(worktree, 'src', 'resources', 'extensions', 'gsd', 'tools'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'resources', 'extensions', 'gsd', 'tools', 'plan-milestone.ts'), '// fixture\n', 'utf-8');
  writeFileSync(join(worktree, 'src', 'resources', 'extensions', 'gsd', 'tools', 'plan-task.ts'), '// fixture\n', 'utf-8');
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();

    const result = await handlePlanSlice(validParams(), worktree);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const worktreePlan = join(worktree, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    const projectPlan = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    assert.ok(existsSync(worktreePlan), 'slice plan should be rendered to worktree-local .gsd');
    assert.ok(!existsSync(projectPlan), 'slice plan should not be rendered to project .gsd');
    assert.equal(result.planPath, realpathSync(worktreePlan));
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice does not regenerate unrelated completed-task summaries during planning', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Finished slice', status: 'complete', demo: 'Existing work.' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.' });
    insertTask({
      id: 'T99',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Already complete',
      status: 'complete',
      fullSummaryMd: '# T99 Summary\n\nAlready done.\n',
    });

    const unrelatedSummaryPath = join(base, '.gsd', 'phases', '01-test', 'T99-SUMMARY.md');
    assert.equal(existsSync(unrelatedSummaryPath), false, 'fixture should start without unrelated summary projection');

    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    assert.equal(existsSync(unrelatedSummaryPath), false, 'plan-slice should not flush all milestone summaries');
    assert.ok(existsSync(join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md')), 'current slice plan still renders');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice requires explicit reopen before replanning a completed task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    insertTask({
      id: 'T01',
      sliceId: 'S02',
      milestoneId: 'M001',
      title: 'Completed implementation',
      status: 'complete',
      oneLiner: 'Completed implementation',
      narrative: 'Already finished.',
      verificationResult: 'passed',
      fullSummaryMd: '# T01 Summary\n\nAlready finished.\n',
    });

    const before = getTask('M001', 'S02', 'T01');
    assert.equal(before?.status, 'complete');
    assert.ok(before?.completed_at, 'completed task should have a completion timestamp');
    assert.equal(before?.full_summary_md, '# T01 Summary\n\nAlready finished.\n');

    const result = await handlePlanSlice(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /completed task T01.*reopen/i);

    const after = getTask('M001', 'S02', 'T01');
    assert.deepEqual(after, before, 'rejected replanning must preserve completed task closeout state');
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'rejected replanning must leave no partial task inserts');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice requires explicit reopen before planning in a legacy deferred milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Deferred milestone', status: 'deferred' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.' });

    const result = await handlePlanSlice(validParams(), base);

    assert.ok('error' in result);
    assert.match(result.error, /cancelled milestone M001.*reopen/i);
    assert.equal(getSlice('M001', 'S02')?.goal, '');
    assert.deepEqual(getSliceTasks('M001', 'S02'), []);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice advances DB-derived state out of planning immediately', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();

    invalidateStateCache();
    const before = await deriveState(base);
    assert.equal(before.phase, 'planning');
    assert.equal(before.progress?.tasks?.total, 0);

    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    invalidateStateCache();
    const after = await deriveState(base);
    assert.notEqual(after.phase, 'planning');
    assert.equal(after.progress?.tasks?.total, 2);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice clears sketch flag so DB-derived state leaves refining', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.', isSketch: true });

    invalidateStateCache();
    const before = await deriveState(base);
    assert.equal(before.phase, 'refining');

    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.equal(getSlice('M001', 'S02')?.is_sketch, 0, 'planned slice must no longer be treated as a sketch');
    assert.equal(getSlice('M001', 'S02')?.goal, 'Persist slice planning through the DB.');

    invalidateStateCache();
    const after = await deriveState(base);
    assert.notEqual(after.phase, 'refining');
    assert.equal(after.progress?.tasks?.total, 2);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice commits sketch refinement when render fails before artifacts exist', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.', isSketch: true });

    // Block the rendered plan path by creating a directory where the file would go.
    // The renderer resolves M001/S02 → phases/01-test/01-02-PLAN.md; creating that
    // path as a directory causes EISDIR on write. Authority still commits and
    // projection repair can retry independently.
    mkdirSync(join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md'), { recursive: true });

    const result = await handlePlanSlice(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);
    assert.equal(getSlice('M001', 'S02')?.is_sketch, 0, 'projection failure must not compensate committed planning authority');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice leaves omitted enrichment fields empty instead of rendering placeholders', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const { successCriteria, proofLevel, integrationClosure, observabilityImpact, ...params } = validParams();
    void successCriteria;
    void proofLevel;
    void integrationClosure;
    void observabilityImpact;

    const result = await handlePlanSlice(params, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const slice = getSlice('M001', 'S02');
    assert.ok(slice);
    assert.equal(slice?.success_criteria, '');
    assert.equal(slice?.proof_level, '');
    assert.equal(slice?.integration_closure, '');
    assert.equal(slice?.observability_impact, '');

    const planPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    const content = readFileSync(planPath, 'utf-8');
    assert.doesNotMatch(content, /Not provided/i);
    assert.doesNotMatch(content, /^## Proof Level$/m);
    assert.doesNotMatch(content, /^## Integration Closure$/m);
    assert.match(content, /- Complete the planned slice outcomes\./);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice accepts metadata-only payloads without deleting existing tasks', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const first = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);
    assert.equal(getSliceTasks('M001', 'S02').length, 2);

    const second = await handlePlanSlice({
      milestoneId: 'M001',
      sliceId: 'S02',
      goal: 'Persist updated slice metadata before incremental tasks.',
      successCriteria: '- Metadata renders before task planning',
      proofLevel: 'unit',
      integrationClosure: 'Task details follow through gsd_plan_task.',
      observabilityImpact: 'Progress survives between tool calls.',
    }, base);
    assert.ok(!('error' in second), `unexpected error: ${'error' in second ? second.error : ''}`);
    assert.equal(getSlice('M001', 'S02')?.goal, 'Persist updated slice metadata before incremental tasks.');
    assert.deepEqual(getSliceTasks('M001', 'S02').map((task) => task.id), ['T01', 'T02']);

    const third = await handlePlanSlice({ ...validParams(), tasks: [] }, base);
    assert.ok(!('error' in third), `unexpected error: ${'error' in third ? third.error : ''}`);
    assert.deepEqual(getSliceTasks('M001', 'S02').map((task) => task.id), ['T01', 'T02']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice metadata-only on a fresh sketch slice keeps is_sketch set and renders no PLAN.md (#1027)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.', isSketch: true });

    // The incremental flow's first call carries metadata only (no tasks). It
    // must NOT error (renderPlanFromDb throws on a task-less slice), and it must
    // NOT clear the sketch flag — clearing it without a PLAN.md would leave the
    // slice out of refining with no plan artifact, breaking sketch/plan signaling.
    const result = await handlePlanSlice({
      milestoneId: 'M001',
      sliceId: 'S02',
      goal: 'Persist slice metadata before any tasks exist.',
    }, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
    assert.equal(getSlice('M001', 'S02')?.goal, 'Persist slice metadata before any tasks exist.');
    assert.equal(getSliceTasks('M001', 'S02').length, 0);
    assert.equal(getSlice('M001', 'S02')?.is_sketch, 1, 'sketch flag must stay set until a task-bearing plan renders');

    const planPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    assert.ok(!existsSync(planPath), 'no PLAN.md should be rendered until the first task is planned');

    invalidateStateCache();
    const after = await deriveState(base);
    assert.equal(after.phase, 'refining', 'a task-less sketch slice stays in refining');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask materializes the slice PLAN.md and clears the sketch flag on the incremental path (#1027)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.', isSketch: true });

    const sliceResult = await handlePlanSlice({
      milestoneId: 'M001',
      sliceId: 'S02',
      goal: 'Incrementally planned slice.',
      successCriteria: '- The slice plan is built up one task at a time',
    }, base);
    assert.ok(!('error' in sliceResult), `unexpected error: ${'error' in sliceResult ? sliceResult.error : ''}`);

    const taskResult = await handlePlanTask({
      milestoneId: 'M001',
      sliceId: 'S02',
      taskId: 'T01',
      title: 'First incremental task',
      description: 'Implement the first task added through gsd_plan_task.',
      estimate: '30m',
      files: ['src/resources/extensions/gsd/tools/plan-task.ts'],
      verify: 'node --test src/resources/extensions/gsd/tests/plan-task.test.ts',
      inputs: ['src/resources/extensions/gsd/tools/plan-milestone.ts'],
      expectedOutput: ['src/resources/extensions/gsd/tools/plan-task.ts'],
    }, base);
    assert.ok(!('error' in taskResult), `unexpected error: ${'error' in taskResult ? taskResult.error : ''}`);

    // The first incremental task materializes the canonical slice PLAN.md with
    // the task present, and clears the sketch flag now that a plan exists.
    const planPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    assert.ok(existsSync(planPath), 'slice PLAN.md should exist after the first task is planned');
    const parsedPlan = parsePlan(readFileSync(planPath, 'utf-8'));
    assert.equal(parsedPlan.goal, 'Incrementally planned slice.');
    assert.equal(parsedPlan.tasks.length, 1);
    assert.equal(parsedPlan.tasks[0]?.id, 'T01');
    assert.equal(getSlice('M001', 'S02')?.is_sketch, 0, 'sketch flag must clear once the first task renders a plan');

    invalidateStateCache();
    const after = await deriveState(base);
    assert.notEqual(after.phase, 'refining', 'a planned slice leaves refining');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice explains string task IO fields must be arrays', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: 'src/index.ts' as unknown as string[],
        },
      ],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: tasks\[0\]\.inputs must be an array of strings, not string/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects absolute task IO paths outside the active worktree', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const outside = join(tmpdir(), 'outside-checkout', 'index.html');
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: [outside],
          expectedOutput: [outside],
        },
      ],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /validation failed: tasks\[0\]\.inputs contains path outside allowed repository roots/);
    assert.equal(getSliceTasks('M001', 'S02').length, 0, 'invalid planning IO must not persist tasks');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects missing task input paths before persisting tasks', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: ['fixtures/missing-source.json'],
        },
      ],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /pre-execution validation failed:/);
    assert.match(result.error, /fixtures\/missing-source\.json/);
    assert.equal(getSliceTasks('M001', 'S02').length, 0, 'invalid planning IO must not persist tasks');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects task input paths created by later tasks before persisting tasks', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const params = validParams();
    const result = await handlePlanSlice({
      ...params,
      tasks: [
        {
          ...params.tasks[0],
          inputs: ['generated/report.json'],
          expectedOutput: ['generated/summary.json'],
        },
        {
          ...params.tasks[1],
          inputs: [],
          expectedOutput: ['generated/report.json'],
        },
      ],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /pre-execution validation failed:/);
    assert.match(result.error, /sequence violation/);
    assert.equal(getSliceTasks('M001', 'S02').length, 0, 'invalid task ordering must not persist tasks');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice accepts absolute task IO paths inside the active worktree', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const inside = join(base, 'index.html');
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: [inside],
          expectedOutput: [inside],
        },
      ],
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects missing parent slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    const result = await handlePlanSlice(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /missing parent slice: M001\/S02/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice surfaces render failures without changing parse-visible task-plan state for the failing task', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    // Flat-phase: per-task plan files don't exist; simulate a write failure on the slice plan
    const failingTaskPlanPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    writeFileSync(failingTaskPlanPath, '---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# Cached plan\n', 'utf-8');
    rmSync(failingTaskPlanPath, { force: true });
    mkdirSync(failingTaskPlanPath, { recursive: true });

    const result = await handlePlanSlice(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);

    assert.ok(existsSync(failingTaskPlanPath), 'failing task plan path should remain the blocking directory');
    assert.equal(getTask('M001', 'S02', 'T01')?.description, 'Implement the slice planning handler.');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice requires explicit reopen before planning a legacy deferred slice', async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'deferred', demo: 'Rendered plans exist.' });

  const result = await handlePlanSlice(validParams(), base);
  assert.ok('error' in result);
  assert.match(result.error, /cancelled slice S02.*reopen/i);

  const slice = getSlice('M001', 'S02');
  assert.ok(slice);
  assert.equal(slice?.status, 'deferred');
  assert.equal(slice?.goal, '');
});

test('handlePlanSlice reruns idempotently and refreshes parse-visible state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    writeFileSync(join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md'), '# S02: Cached\n\n**Goal:** old value\n\n## Tasks\n\n- [ ] **T01: Cached task**\n', 'utf-8');

    const first = await handlePlanSlice(validParams(), base);
    assert.ok(!('error' in first));

    const second = await handlePlanSlice({
      ...validParams(),
      goal: 'Updated goal from rerun.',
      tasks: [
        { ...validParams().tasks[0], description: 'Updated slice handler description.' },
        validParams().tasks[1],
      ],
    }, base);
    assert.ok(!('error' in second));

    const parsedAfter = parsePlan(readFileSync(join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md'), 'utf-8'));
    assert.equal(parsedAfter.goal, 'Updated goal from rerun.');
    const task = getTask('M001', 'S02', 'T01');
    assert.equal(task?.description, 'Updated slice handler description.');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice durably cancels omitted pending tasks when replanning a smaller task set', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const fourTaskPlan = {
      ...validParams(),
      tasks: [
        ...validParams().tasks,
        { ...validParams().tasks[0], taskId: 'T03', title: 'Third task' },
        { ...validParams().tasks[0], taskId: 'T04', title: 'Stale task', inputs: ['stale-input.py'] },
      ],
    };

    const first = await handlePlanSlice(fourTaskPlan, base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);
    insertTask({ id: 'T05', sliceId: 'S02', milestoneId: 'M001', title: 'Legacy-only stale task', status: 'pending' });
    // In flat-phase mode tasks are checkboxes in the slice plan; no per-task plan files.
    const slicePlanPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    assert.ok(existsSync(slicePlanPath), 'initial plan should exist');
    assert.match(readFileSync(slicePlanPath, 'utf-8'), /T04/, 'initial plan should contain T04');

    const second = await handlePlanSlice({
      ...validParams(),
      tasks: fourTaskPlan.tasks.filter((task) => task.taskId !== 'T04'),
    }, base);
    assert.ok(!('error' in second), `unexpected error: ${'error' in second ? second.error : ''}`);

    assert.deepEqual(getSliceTasks('M001', 'S02').map((task) => [task.id, task.status]), [
      ['T01', 'pending'],
      ['T02', 'pending'],
      ['T03', 'pending'],
      ['T04', 'skipped'],
      ['T05', 'skipped'],
    ]);
    assert.equal(getGateResults('M001', 'S02', 'task').some((gate) => gate.task_id === 'T04'), true, 'cancelled task gates remain durable history');
    const adapter = _getAdapter();
    assert.ok(adapter);
    assert.deepEqual(adapter.prepare(`
      SELECT lifecycle_status, state_version
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S02' AND task_id = 'T04'
    `).get(), { lifecycle_status: 'cancelled', state_version: 1 });
    assert.deepEqual(adapter.prepare(`
      SELECT lifecycle_status, state_version
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S02' AND task_id = 'T05'
    `).get(), { lifecycle_status: 'cancelled', state_version: 1 });
    assert.doesNotMatch(readFileSync(slicePlanPath, 'utf-8'), /T04/, 'omitted T04 should be removed from plan');

    const beforeReopenAttempt = {
      tasks: getSliceTasks('M001', 'S02'),
      operations: adapter.prepare('SELECT operation_id FROM workflow_operations ORDER BY resulting_revision').all(),
      lifecycles: adapter.prepare(`
        SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id, last_project_revision
        FROM workflow_item_lifecycles ORDER BY item_kind, task_id
      `).all(),
    };
    const rejectedReinclude = await handlePlanSlice(fourTaskPlan, base);
    assert.ok('error' in rejectedReinclude);
    assert.match(rejectedReinclude.error, /cancelled task T04.*reopen/i);
    assert.deepEqual({
      tasks: getSliceTasks('M001', 'S02'),
      operations: adapter.prepare('SELECT operation_id FROM workflow_operations ORDER BY resulting_revision').all(),
      lifecycles: adapter.prepare(`
        SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id, last_project_revision
        FROM workflow_item_lifecycles ORDER BY item_kind, task_id
      `).all(),
    }, beforeReopenAttempt, 'reusing a cancelled task identity must leave no operation or hierarchy residue');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects omitted completed tasks without changing slice or task state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const fourTaskPlan = {
      ...validParams(),
      tasks: [
        ...validParams().tasks,
        { ...validParams().tasks[0], taskId: 'T03', title: 'Third task' },
        { ...validParams().tasks[0], taskId: 'T04', title: 'Stale task', inputs: ['stale-input.py'] },
      ],
    };

    const first = await handlePlanSlice(fourTaskPlan, base);
    assert.ok(!('error' in first), `unexpected error: ${'error' in first ? first.error : ''}`);
    // In flat-phase mode tasks are checkboxes in the slice plan; no per-task plan files.
    const slicePlanPathR = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    assert.ok(existsSync(slicePlanPathR), 'initial plan should exist');
    assert.match(readFileSync(slicePlanPathR, 'utf-8'), /T04/, 'initial plan should contain T04');

    completeTask('T04', '2026-05-12T00:00:00.000Z');
    const tasksBefore = getSliceTasks('M001', 'S02');
    const gatesBefore = getGateResults('M001', 'S02', 'task');

    const second = await handlePlanSlice({
      ...validParams(),
      goal: 'Rejected replan should not persist.',
      tasks: fourTaskPlan.tasks.filter((task) => task.taskId !== 'T04'),
    }, base);
    assert.deepEqual(second, { error: 'cannot remove completed task T04' });

    assert.equal(getSlice('M001', 'S02')?.goal, 'Persist slice planning through the DB.');
    assert.deepEqual(getSliceTasks('M001', 'S02'), tasksBefore);
    assert.deepEqual(getGateResults('M001', 'S02', 'task'), gatesBefore);
    assert.match(readFileSync(slicePlanPathR, 'utf-8'), /T04/, 'completed task T04 should remain in plan after rejected replan');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice preserves an unowned combined PLAN when only cancelled tasks remain', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    insertTask({ id: 'T99', sliceId: 'S02', milestoneId: 'M001', title: 'Cancelled task', status: 'skipped' });
    const planPath = join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md');
    writeFileSync(planPath, '# S02: Stale\n\n<tasks>\n- [ ] **T99**: Cancelled task\n</tasks>\n', 'utf8');

    const result = await handlePlanSlice({
      milestoneId: 'M001',
      sliceId: 'S02',
      goal: 'Keep cancellation history without active work.',
    }, base);

    assert.deepEqual(result, {
      milestoneId: 'M001',
      sliceId: 'S02',
      planPath: '',
      taskPlanPaths: [],
    });
    assert.equal(existsSync(planPath), true, 'manual PLAN must not be removed without writer provenance');
    assert.equal(getTask('M001', 'S02', 'T99')?.status, 'skipped', 'projection cleanup must retain task authority');
  } finally {
    cleanup(base);
  }
});

test('regression: validateTasks surfaces clean per-field errors for non-array IO inputs', async () => {
  // Regression for the bug fixed in PR #5872: an earlier refactor on main
  // (0b0e1a901) re-added validateStringArray() calls inside validateTasks
  // without re-adding its import. The catch around validateParams swallowed
  // the ReferenceError into a generic "validation failed: validateStringArray
  // is not defined" message, so silent runtime breakage was possible.
  //
  // Exercise every validateStringArray call site (files, inputs, expectedOutput)
  // so a future missing-import would surface as a per-field assertion failure
  // here, not a deep ReferenceError that's easy to mis-diagnose.
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();

    for (const field of ['files', 'inputs', 'expectedOutput'] as const) {
      const result = await handlePlanSlice({
        ...validParams(),
        tasks: [{
          ...validParams().tasks[0],
          [field]: 'not-an-array' as unknown as string[],
        }],
      }, base);
      assert.ok('error' in result, `${field}: expected validation error, got success`);
      assert.match(
        result.error,
        new RegExp(`tasks\\[0\\]\\.${field} must be an array`),
        `${field}: expected per-field validation message, got: ${result.error}`,
      );
      assert.doesNotMatch(
        result.error,
        /is not defined/,
        `${field}: validation surfaced ReferenceError — likely a missing import in plan-slice.ts`,
      );
      assert.equal(getSliceTasks('M001', 'S02').length, 0, `${field}: invalid input must not persist`);
    }
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice skips prose and sentinel input values in planning path scope', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [{
        ...validParams().tasks[0],
        inputs: ['Current enum shape in codebase', 'None'],
        expectedOutput: ['src/resources/extensions/gsd/planning-path-scope.ts'],
      }],
    }, base);

    assert.ok(!('error' in result), `expected success, got: ${(result as { error?: string }).error}`);
    assert.equal(getSliceTasks('M001', 'S02').length, 1);
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice rejects prose expectedOutput entries before path-scope validation', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [{
        ...validParams().tasks[0],
        expectedOutput: ['Browser UI supports due-date add/edit flows and mixed-list urgency rendering.'],
      }],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /expectedOutput must contain only file paths/);
    assert.doesNotMatch(result.error, /outside allowed repository roots/);
    assert.equal(getSliceTasks('M001', 'S02').length, 0, 'invalid output contract must not persist tasks');
  } finally {
    cleanup(base);
  }
});

test('handlePlanSlice resolves relative task IO paths against worktree roots', async () => {
  const base = makeTmpBase();
  const worktree = join(base, '.gsd', 'worktrees', 'M001');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  writeFileSync(join(worktree, 'index.html'), '<html></html>', 'utf-8');
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [{
        ...validParams().tasks[0],
        files: ['index.html'],
        inputs: ['index.html'],
        expectedOutput: ['index.html'],
      }],
    }, worktree);

    assert.ok(!('error' in result), `expected success, got: ${(result as { error?: string }).error}`);
  } finally {
    cleanup(base);
  }
});
