import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertAssessment,
  getSlice,
  getMilestoneSlices,
  getAssessment,
  _getAdapter,
} from '../gsd-db.ts';
import { handleReassessRoadmap as handleReassessRoadmapWithInvocation } from '../tools/reassess-roadmap.ts';
import { internalPlanningInvocation } from '../planning-invocation.ts';

function handleReassessRoadmap(
  params: Parameters<typeof handleReassessRoadmapWithInvocation>[0],
  basePath: string,
) {
  return handleReassessRoadmapWithInvocation(params, basePath, internalPlanningInvocation());
}

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reassess-'));
  mkdirSync(join(base, '.gsd', 'phases', '01-test'), { recursive: true });
  mkdirSync(join(base, '.gsd', 'phases', '01-test'), { recursive: true });
  mkdirSync(join(base, '.gsd', 'phases', '01-test', 'slices', 'S03'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedMilestoneWithSlices(opts?: {
  s01Status?: string;
  s02Status?: string;
  s03Status?: string;
}): void {
  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice One', status: opts?.s01Status ?? 'complete', demo: 'Demo one.' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Slice Two', status: opts?.s02Status ?? 'pending', demo: 'Demo two.' });
  insertSlice({ id: 'S03', milestoneId: 'M001', title: 'Slice Three', status: opts?.s03Status ?? 'pending', demo: 'Demo three.' });
}

function validReassessParams() {
  return {
    milestoneId: 'M001',
    completedSliceId: 'S01',
    verdict: 'confirmed',
    assessment: 'S01 completed successfully. Roadmap is on track.',
    sliceChanges: {
      modified: [
        {
          sliceId: 'S02',
          title: 'Updated Slice Two',
          risk: 'high',
          depends: ['S01'],
          demo: 'Updated demo two.',
        },
      ],
      added: [
        {
          sliceId: 'S04',
          title: 'New Slice Four',
          risk: 'low',
          depends: ['S02'],
          demo: 'Demo four.',
        },
      ],
      removed: ['S03'],
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('handleReassessRoadmap rejects invalid payloads (missing milestoneId)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices();
    const result = await handleReassessRoadmap({ ...validReassessParams(), milestoneId: '' }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed/);
    assert.match(result.error, /milestoneId/);
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap rejects missing milestone', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    // No milestone seeded
    const result = await handleReassessRoadmap(validReassessParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /not found/);
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap rejects structural violation: modifying a completed slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices({ s01Status: 'complete', s02Status: 'pending', s03Status: 'pending' });

    const result = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [{ sliceId: 'S01', title: 'Trying to modify completed S01' }],
        added: [],
        removed: [],
      },
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /completed slice/);
    assert.match(result.error, /S01/);
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap rejects structural violation: removing a completed slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices({ s01Status: 'complete', s02Status: 'pending', s03Status: 'pending' });

    const result = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [],
        added: [],
        removed: ['S01'],
      },
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /completed slice/);
    assert.match(result.error, /S01/);
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap succeeds when modifying only pending slices', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices({ s01Status: 'complete', s02Status: 'pending', s03Status: 'pending' });

    const params = validReassessParams();
    const result = await handleReassessRoadmap(params, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    // Verify assessments row exists in DB
    const assessmentPath = join('.gsd', 'phases', '01-test', '01-01-ASSESSMENT.md');
    const assessment = getAssessment(assessmentPath);
    assert.ok(assessment, 'assessment row should exist in DB');
    assert.equal(assessment['milestone_id'], 'M001');
    assert.equal(assessment['status'], 'confirmed');
    assert.equal(assessment['scope'], 'roadmap');
    assert.ok((assessment['full_content'] as string).includes('S01 completed successfully'), 'assessment content should be stored');

    // Verify S02 was updated
    const s02 = getSlice('M001', 'S02');
    assert.ok(s02, 'S02 should still exist');
    assert.equal(s02?.title, 'Updated Slice Two');
    assert.equal(s02?.risk, 'high');
    assert.equal(s02?.demo, 'Updated demo two.');

    // Removed slices retain durable identity/history but leave the active roadmap.
    const s03 = getSlice('M001', 'S03');
    assert.equal(s03?.status, 'skipped', 'S03 should be durably cancelled');

    // Verify S04 was inserted
    const s04 = getSlice('M001', 'S04');
    assert.ok(s04, 'S04 should exist as a new slice');
    assert.equal(s04?.title, 'New Slice Four');
    assert.equal(s04?.status, 'pending');

    // Verify S01 (completed) was NOT touched
    const s01 = getSlice('M001', 'S01');
    assert.ok(s01, 'S01 should still exist');
    assert.equal(s01?.status, 'complete');

    // Verify ROADMAP.md re-rendered on disk
    // Flat-phase renderer writes NN-ROADMAP.md (01-ROADMAP.md for M001)
    const roadmapPath = join(base, '.gsd', 'phases', '01-test', '01-ROADMAP.md');
    assert.ok(existsSync(roadmapPath), 'ROADMAP.md should be rendered to disk');
    const roadmapContent = readFileSync(roadmapPath, 'utf-8');
    assert.ok(roadmapContent.includes('Updated Slice Two'), 'ROADMAP.md should contain updated S02 title');

    // Verify ASSESSMENT.md exists on disk
    const assessmentDiskPath = join(base, '.gsd', 'phases', '01-test', '01-01-ASSESSMENT.md');
    assert.ok(existsSync(assessmentDiskPath), 'ASSESSMENT.md should be rendered to disk');
    const assessmentContent = readFileSync(assessmentDiskPath, 'utf-8');
    assert.ok(assessmentContent.includes('confirmed'), 'ASSESSMENT.md should contain verdict');
    assert.ok(assessmentContent.includes('S01'), 'ASSESSMENT.md should reference completed slice');
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap writes legacy-layout reassessment to S##-ASSESSMENT.md', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-reassess-legacy-'));
  mkdirSync(join(base, '.gsd', 'milestones', 'M005-3qxqd7', 'slices', 'S04'), { recursive: true });
  mkdirSync(join(base, '.gsd', 'phases', '05-3qxqd7-legacy-milestone'), { recursive: true });
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M005-3qxqd7', title: 'Legacy Milestone', status: 'active' });
    insertSlice({
      id: 'S04',
      milestoneId: 'M005-3qxqd7',
      title: 'Legacy Slice Four',
      status: 'complete',
      demo: 'Demo four.',
    });

    const result = await handleReassessRoadmap({
      milestoneId: 'M005-3qxqd7',
      completedSliceId: 'S04',
      verdict: 'confirmed',
      assessment: 'S04 completed successfully. Roadmap remains valid.',
      sliceChanges: {
        modified: [],
        added: [],
        removed: [],
      },
    }, base);

    if ('error' in result) {
      assert.fail(`unexpected error: ${result.error}`);
    }

    const correctPath = join(base, '.gsd', 'milestones', 'M005-3qxqd7', 'slices', 'S04', 'S04-ASSESSMENT.md');
    const wrongFlatNameInLegacyDir = join(base, '.gsd', 'milestones', 'M005-3qxqd7', 'slices', 'S04', '05-04-ASSESSMENT.md');
    const wrongFlatPhasePath = join(base, '.gsd', 'phases', '05-3qxqd7-legacy-milestone', '05-04-ASSESSMENT.md');
    assert.match(
      result.assessmentPath.replace(/\\/g, '/'),
      /\/\.gsd\/milestones\/M005-3qxqd7\/slices\/S04\/S04-ASSESSMENT\.md$/,
    );
    assert.ok(existsSync(correctPath), 'legacy ASSESSMENT should use S## filename inside slices/S##/');
    assert.equal(existsSync(wrongFlatNameInLegacyDir), false, 'legacy slice dir must not receive flat-phase assessment filename');
    assert.equal(existsSync(wrongFlatPhasePath), false, 'legacy reassessment must not be diverted to a coexisting flat-phase dir');

    const assessment = getAssessment('.gsd/milestones/M005-3qxqd7/slices/S04/S04-ASSESSMENT.md');
    assert.ok(assessment, 'assessment row should use the legacy-layout path');
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap cache invalidation: getMilestoneSlices reflects mutations', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices({ s01Status: 'complete', s02Status: 'pending', s03Status: 'pending' });

    const params = validReassessParams();
    const result = await handleReassessRoadmap(params, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    // After cache invalidation, DB queries should reflect mutations
    const slices = getMilestoneSlices('M001');
    const sliceIds = slices.map(s => s.id);

    // S01 should remain (completed, untouched)
    assert.ok(sliceIds.includes('S01'), 'S01 should still exist after reassess');

    // S02 should remain (modified, not removed)
    assert.ok(sliceIds.includes('S02'), 'S02 should still exist after reassess');

    // S03 remains queryable as cancelled history.
    assert.ok(sliceIds.includes('S03'), 'S03 identity should remain after removal');
    assert.equal(slices.find((slice) => slice.id === 'S03')?.status, 'skipped');

    // S04 should exist (added)
    assert.ok(sliceIds.includes('S04'), 'S04 should exist after addition');
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap rejects a duplicate structural mutation under a fresh invocation', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices({ s01Status: 'complete', s02Status: 'pending', s03Status: 'pending' });

    // First call with full mutations
    const params = validReassessParams();
    const first = await handleReassessRoadmap(params, base);
    assert.ok(!('error' in first), `first call error: ${'error' in first ? first.error : ''}`);

    // A distinct invocation is a new command, not a transport retry. Silently
    // upserting the existing S04 identity would hide stale planning input.
    const second = await handleReassessRoadmap(params, base);
    assert.ok('error' in second);
    assert.match(second.error, /existing slice S04|duplicate|reopen/i);
    assert.equal(getMilestoneSlices('M001').filter((slice) => slice.id === 'S04').length, 1);
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap rejects slice with status "done" (alias for complete)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices({ s01Status: 'done', s02Status: 'pending', s03Status: 'pending' });

    const result = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [{ sliceId: 'S01', title: 'Trying to modify done S01' }],
        added: [],
        removed: [],
      },
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /completed slice/);
    assert.match(result.error, /S01/);
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap returns structured error payloads with actionable messages', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedMilestoneWithSlices({ s01Status: 'complete', s02Status: 'complete', s03Status: 'pending' });

    // Try to modify S01 (completed)
    const modifyResult = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [{ sliceId: 'S01', title: 'x' }],
        added: [],
        removed: [],
      },
    }, base);
    assert.ok('error' in modifyResult);
    assert.ok(typeof modifyResult.error === 'string', 'error should be a string');
    assert.ok(modifyResult.error.includes('S01'), 'error should name the specific slice ID S01');

    // Try to remove S02 (completed)
    const removeResult = await handleReassessRoadmap({
      ...validReassessParams(),
      sliceChanges: {
        modified: [],
        added: [],
        removed: ['S02'],
      },
    }, base);
    assert.ok('error' in removeResult);
    assert.ok(removeResult.error.includes('S02'), 'error should name the specific slice ID S02');
  } finally {
    cleanup(base);
  }
});

// ─── Bug #2957: Stale VALIDATION survives roadmap remediation ────────────

test('handleReassessRoadmap invalidates stale milestone-validation when roadmap changes (#2957)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    // Seed: M001 with S01-S04 all complete, plus a stale VALIDATION with needs-remediation
    insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice One', status: 'complete', demo: 'Demo' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Slice Two', status: 'complete', demo: 'Demo' });
    insertSlice({ id: 'S03', milestoneId: 'M001', title: 'Slice Three', status: 'complete', demo: 'Demo' });
    insertSlice({ id: 'S04', milestoneId: 'M001', title: 'Slice Four', status: 'complete', demo: 'Demo' });

    // Insert milestone-validation assessment with needs-remediation verdict (stale)
    const validationPath = join('.gsd', 'phases', '01-test', 'M001-VALIDATION.md');
    insertAssessment({
      path: validationPath,
      milestoneId: 'M001',
      sliceId: null,
      taskId: null,
      status: 'needs-remediation',
      scope: 'milestone-validation',
      fullContent: '---\nverdict: needs-remediation\nremediation_round: 0\n---\n\n# Validation\nNeeds remediation.',
    });

    // Verify the validation row exists before reassess
    const adapter = _getAdapter()!;
    const before = adapter.prepare(
      `SELECT * FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as Record<string, unknown> | undefined;
    assert.ok(before, 'milestone-validation row should exist before reassess');

    // Now reassess the roadmap: add remediation slice S05
    // This simulates the scenario from #2957 where validation produced needs-remediation
    // and then roadmap was reassessed to add a remediation slice
    const result = await handleReassessRoadmap({
      milestoneId: 'M001',
      completedSliceId: 'S04',
      verdict: 'on-track',
      assessment: 'S04 completed. Adding remediation slice S05.',
      sliceChanges: {
        modified: [],
        added: [
          {
            sliceId: 'S05',
            title: 'Remediation Slice',
            risk: 'low',
            depends: ['S04'],
            demo: 'Fix the issues found during validation.',
          },
        ],
        removed: [],
      },
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    // The stale milestone-validation row must be deleted after roadmap changes
    const after = adapter.prepare(
      `SELECT * FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as Record<string, unknown> | undefined;
    assert.equal(after, undefined, 'milestone-validation row should be deleted after roadmap changes — stale validation must not survive remediation (#2957)');
  } finally {
    cleanup(base);
  }
});

test('handleReassessRoadmap deletes flat-phase compatibility validation files when roadmap changes (#2957)', async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, '.gsd', 'gsd.db'));

  insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice One', status: 'complete', demo: 'Demo' });

  const legacyValidationPath = join(base, '.gsd', 'phases', '01-test', 'M001-VALIDATION.md');
  const canonicalValidationPath = join(base, '.gsd', 'phases', '01-test', '01-VALIDATION.md');
  const staleValidation = '---\nverdict: pass\n---\n\n# Stale validation\n';
  writeFileSync(legacyValidationPath, staleValidation, 'utf-8');
  writeFileSync(canonicalValidationPath, staleValidation, 'utf-8');
  insertAssessment({
    path: legacyValidationPath,
    milestoneId: 'M001',
    sliceId: null,
    taskId: null,
    status: 'pass',
    scope: 'milestone-validation',
    fullContent: staleValidation,
  });

  const result = await handleReassessRoadmap({
    milestoneId: 'M001',
    completedSliceId: 'S01',
    verdict: 'confirmed',
    assessment: 'S01 completed. Adding S02 changes roadmap structure.',
    sliceChanges: {
      modified: [],
      added: [
        {
          sliceId: 'S02',
          title: 'New Slice Two',
          risk: 'low',
          depends: ['S01'],
          demo: 'Demo two.',
        },
      ],
      removed: [],
    },
  }, base);

  assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);
  assert.equal(existsSync(legacyValidationPath), false, 'stale compatibility validation artifact should be deleted');
  assert.equal(existsSync(canonicalValidationPath), false, 'canonical validation artifact should not remain after reassess');
});

test('handleReassessRoadmap does NOT invalidate validation when no roadmap structural changes (#2957)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    // Seed: M001 with slices, plus a validation with pass verdict
    insertMilestone({ id: 'M001', title: 'Test Milestone', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice One', status: 'complete', demo: 'Demo' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Slice Two', status: 'pending', demo: 'Demo' });

    // Insert milestone-validation assessment with pass verdict
    const validationPath = join('.gsd', 'phases', '01-test', 'M001-VALIDATION.md');
    insertAssessment({
      path: validationPath,
      milestoneId: 'M001',
      sliceId: null,
      taskId: null,
      status: 'pass',
      scope: 'milestone-validation',
      fullContent: '---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nAll good.',
    });

    // Reassess with no structural changes (empty added/modified/removed)
    const result = await handleReassessRoadmap({
      milestoneId: 'M001',
      completedSliceId: 'S01',
      verdict: 'confirmed',
      assessment: 'S01 completed. No changes needed.',
      sliceChanges: {
        modified: [],
        added: [],
        removed: [],
      },
    }, base);

    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    // Validation should still exist when no structural changes occurred
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      `SELECT * FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`,
    ).get() as Record<string, unknown> | undefined;
    assert.ok(row, 'milestone-validation row should survive when no structural changes occurred');
  } finally {
    cleanup(base);
  }
});
