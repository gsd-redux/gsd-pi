// GSD — status-guards unit tests

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isClosedStatus,
  isFutureMilestoneStatus,
  isDeferredStatus,
  isInactiveStatus,
  isSkippedForDispatch,
} from '../status-guards.ts';

test('isClosedStatus: "complete" returns true', () => {
  assert.equal(isClosedStatus('complete'), true);
});

test('isClosedStatus: "done" returns true', () => {
  assert.equal(isClosedStatus('done'), true);
});

test('isClosedStatus: "skipped" returns true', () => {
  assert.equal(isClosedStatus('skipped'), true);
});

test('isClosedStatus: "closed" returns true', () => {
  assert.equal(isClosedStatus('closed'), true);
});

test('isClosedStatus: "pending" returns false', () => {
  assert.equal(isClosedStatus('pending'), false);
});

test('isClosedStatus: "in_progress" returns false', () => {
  assert.equal(isClosedStatus('in_progress'), false);
});

test('isClosedStatus: "active" returns false', () => {
  assert.equal(isClosedStatus('active'), false);
});

test('isClosedStatus: "" (empty string) returns false', () => {
  assert.equal(isClosedStatus(''), false);
});

test('isFutureMilestoneStatus includes future milestone aliases', () => {
  assert.equal(isFutureMilestoneStatus('pending'), true);
  assert.equal(isFutureMilestoneStatus('queued'), true);
  assert.equal(isFutureMilestoneStatus('planned'), true);
});

test('isFutureMilestoneStatus excludes active and closed milestones', () => {
  assert.equal(isFutureMilestoneStatus('active'), false);
  assert.equal(isFutureMilestoneStatus('complete'), false);
  assert.equal(isFutureMilestoneStatus('parked'), false);
});

// ─── isDeferredStatus ──────────────────────────────────────────────────────

test('isDeferredStatus is true only for "deferred"', () => {
  assert.equal(isDeferredStatus('deferred'), true);
  assert.equal(isDeferredStatus('complete'), false);
  assert.equal(isDeferredStatus('pending'), false);
  assert.equal(isDeferredStatus('skipped'), false);
});

// ─── isInactiveStatus (closed OR deferred) ─────────────────────────────────

test('isInactiveStatus covers every closed status', () => {
  for (const s of ['complete', 'done', 'skipped', 'closed']) {
    assert.equal(isInactiveStatus(s), true, `${s} should count as inactive`);
  }
});

test('isInactiveStatus also covers deferred', () => {
  assert.equal(isInactiveStatus('deferred'), true);
});

test('isInactiveStatus excludes runnable statuses', () => {
  for (const s of ['pending', 'active', 'planned', 'queued', '']) {
    assert.equal(isInactiveStatus(s), false, `${s} should not count as inactive`);
  }
});

// ─── isSkippedForDispatch (closed, parked, or deferred) ────────────────────

test('isSkippedForDispatch covers closed, parked, and deferred', () => {
  for (const s of ['complete', 'done', 'skipped', 'closed', 'parked', 'deferred']) {
    assert.equal(isSkippedForDispatch(s), true, `${s} should be skipped for dispatch ordering`);
  }
});

test('isSkippedForDispatch does NOT skip pending/active/planned', () => {
  for (const s of ['pending', 'active', 'planned', 'queued']) {
    assert.equal(isSkippedForDispatch(s), false, `${s} should block dispatch ordering`);
  }
});
