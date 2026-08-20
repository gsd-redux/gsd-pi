/**
 * session-lock-regression.test.ts — Regression tests for session lock lifecycle.
 *
 * Regression coverage for:
 *   #1257  False-positive "Session lock lost" during auto-mode
 *   #1245  Stranded .gsd.lock/ directory preventing new sessions
 *   #1251  Same root cause as #1245
 *
 * Tests the acquire → validate → release lifecycle and edge cases
 * including cross-process exclusion during re-entrant acquisition.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireSessionLock,
  getSessionLockStatus,
  validateSessionLock,
  releaseSessionLock,
  readSessionLockData,
  updateSessionLock,
  isSessionLockHeld,
  _setProperLockfileForTests,
} from '../session-lock.ts';
import { gsdRoot } from '../paths.ts';
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import { registerAutoWorker, getAutoWorker } from "../db/auto-workers.ts";
import { normalizeRealPath } from "../paths.ts";
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

function hasProperLockfile(): boolean {
  try {
    require("proper-lockfile");
    return true;
  } catch {
    return false;
  }
}

const properLockfileAvailable = hasProperLockfile();

describe('session-lock-regression', async () => {

  // ─── 1. Basic acquire/release lifecycle ───────────────────────────────
  console.log('\n=== 1. acquire → validate → release lifecycle ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const result = acquireSessionLock(base);
      assert.ok(result.acquired, 'lock acquired successfully');

      const valid = validateSessionLock(base);
      assert.ok(valid, 'lock validates after acquisition');

      assert.ok(isSessionLockHeld(base), 'isSessionLockHeld returns true');

      releaseSessionLock(base);

      // After release, the lock file should be cleaned up
      const lockFile = join(gsdRoot(base), 'auto.lock');
      assert.ok(!existsSync(lockFile), 'lock file removed after release');

      // The .gsd.lock/ directory should be cleaned up
      const lockDir = gsdRoot(base) + '.lock';
      assert.ok(!existsSync(lockDir), '.gsd.lock/ directory removed after release (#1245)');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 2. Double release is safe ────────────────────────────────────────
  console.log('\n=== 2. double release does not throw ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      acquireSessionLock(base);
      releaseSessionLock(base);
      // Second release should not throw
      let threw = false;
      try {
        releaseSessionLock(base);
      } catch {
        threw = true;
      }
      assert.ok(!threw, 'double release does not throw');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 2b. Dead lock PID is marked stopping in workers table ────────────
  console.log('\n=== 2b. dead lock PID marks worker stopping ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      openDatabase(join(base, ".gsd", "gsd.db"));
      const projectRoot = normalizeRealPath(base);
      const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
      const deadPid = 99999;
      writeFileSync(join(gsdRoot(base), "auto.lock"), JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        unitType: "starting",
        unitId: "bootstrap",
        unitStartedAt: new Date().toISOString(),
      }));
      // Align worker PID with stale lock metadata.
      _getAdapter()?.prepare("UPDATE workers SET pid = :pid WHERE worker_id = :id")
        .run({ ":pid": deadPid, ":id": workerId });

      const result = acquireSessionLock(base);
      assert.ok(result.acquired, "acquire recovers stale lock");
      assert.equal(getAutoWorker(workerId)?.status, "stopping");
      releaseSessionLock(base);
    } finally {
      try { closeDatabase(); } catch { /* noop */ }
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 3. updateSessionLock preserves lock data ─────────────────────────
  console.log('\n=== 3. updateSessionLock writes metadata ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      acquireSessionLock(base);

      updateSessionLock(base, 'execute-task', 'M001/S01/T01', '/tmp/session.json');

      const data = readSessionLockData(base);
      assert.ok(data !== null, 'lock data readable after update');
      if (data) {
        assert.deepStrictEqual(data.pid, process.pid, 'lock data has correct PID');
        assert.deepStrictEqual(data.unitType, 'execute-task', 'lock data has correct unit type');
        assert.deepStrictEqual(data.unitId, 'M001/S01/T01', 'lock data has correct unit ID');
        assert.deepStrictEqual(data.sessionFile, '/tmp/session.json', 'lock data has session file');
      }

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 4. Stale lock from dead PID → re-acquirable (#1245) ─────────────
  console.log('\n=== 4. stale lock from dead PID → re-acquirable ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      // Write a lock file with a definitely-dead PID
      const lockFile = join(gsdRoot(base), 'auto.lock');
      const staleLock = {
        pid: 99999999, // extremely unlikely to be alive
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        unitStartedAt: new Date(Date.now() - 3600000).toISOString(),
      };
      writeFileSync(lockFile, JSON.stringify(staleLock, null, 2));

      // Should be able to acquire despite the stale lock
      const result = acquireSessionLock(base);
      assert.ok(result.acquired, '#1245: stale lock from dead PID → re-acquirable');

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 5. readSessionLockData with no lock → null ───────────────────────
  console.log('\n=== 5. readSessionLockData with no lock → null ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const data = readSessionLockData(base);
      assert.deepStrictEqual(data, null, 'no lock file → null');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 6. validateSessionLock after own acquisition → true ──────────────
  console.log('\n=== 6. validateSessionLock after own acquisition → true ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      acquireSessionLock(base);

      // Multiple validations should all return true (regression for #1257)
      for (let i = 0; i < 5; i++) {
        const valid = validateSessionLock(base);
        assert.ok(valid, `#1257: validation ${i + 1} returns true for own lock`);
      }

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 7. readSessionLockData with corrupt JSON → null ──────────────────
  console.log('\n=== 7. corrupt lock file → null ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const lockFile = join(gsdRoot(base), 'auto.lock');
      writeFileSync(lockFile, 'NOT VALID JSON {{{');

      const data = readSessionLockData(base);
      assert.deepStrictEqual(data, null, 'corrupt JSON → null');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 7b. getSessionLockStatus with missing metadata → reason surfaced ──
  console.log('\n=== 7b. missing lock metadata → structured reason ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const status = getSessionLockStatus(base);
      assert.deepStrictEqual(status.valid, false, 'missing lock metadata is invalid');
      assert.deepStrictEqual(status.failureReason, 'missing-metadata', 'missing metadata reason is surfaced');
      assert.deepStrictEqual(status.expectedPid, process.pid, 'expected PID is included');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 7c. getSessionLockStatus with foreign PID → reason surfaced ───────
  console.log('\n=== 7c. foreign PID in lock file → structured reason ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const foreignPid = process.pid + 1000;
      const lockFile = join(gsdRoot(base), 'auto.lock');
      writeFileSync(lockFile, JSON.stringify({
        pid: foreignPid,
        startedAt: new Date().toISOString(),
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        unitStartedAt: new Date().toISOString(),
      }, null, 2));

      const status = getSessionLockStatus(base);
      assert.deepStrictEqual(status.valid, false, 'foreign PID lock is invalid');
      assert.deepStrictEqual(status.failureReason, 'pid-mismatch', 'PID mismatch reason is surfaced');
      assert.deepStrictEqual(status.existingPid, foreignPid, 'existing PID is included');
      assert.deepStrictEqual(status.expectedPid, process.pid, 'expected PID is included');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 7d. Releasing after ownership loss preserves newer owner ─────────
  test('releaseSessionLock preserves newer owner after PID mismatch', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => {
      rmSync(base, { recursive: true, force: true });
    });

    const acquired = acquireSessionLock(base);
    assert.ok(acquired.acquired, 'initial lock acquired');

    const lockFile = join(gsdRoot(base), 'auto.lock');
    const newerOwner = {
      pid: process.pid + 1000,
      startedAt: new Date().toISOString(),
      unitType: 'execute-task',
      unitId: 'M001/S01/T02',
      unitStartedAt: new Date().toISOString(),
    };
    writeFileSync(lockFile, JSON.stringify(newerOwner, null, 2));

    releaseSessionLock(base);

    assert.ok(existsSync(lockFile), 'foreign lock file must not be deleted by stale owner release');
    const after = JSON.parse(readFileSync(lockFile, 'utf-8'));
    assert.deepStrictEqual(after.pid, newerOwner.pid, 'newer owner PID is preserved');
    assert.deepStrictEqual(after.unitId, newerOwner.unitId, 'newer owner metadata is preserved');
  });

  // ─── 8. Acquire after release is possible ─────────────────────────────
  console.log('\n=== 8. acquire after release → re-acquirable ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const r1 = acquireSessionLock(base);
      assert.ok(r1.acquired, 'first acquisition');
      releaseSessionLock(base);

      const r2 = acquireSessionLock(base);
      assert.ok(r2.acquired, 're-acquisition after release');
      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 9. Re-entrant acquisition without explicit release ───────────────
  console.log('\n=== 9. re-entrant acquire without explicit release ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const r1 = acquireSessionLock(base);
      assert.ok(r1.acquired, 'first acquisition succeeds');

      const r2 = acquireSessionLock(base);
      assert.deepStrictEqual(r2, { acquired: true, reentrant: true }, 're-entrant acquisition succeeds');

      const valid = validateSessionLock(base);
      assert.ok(valid, 're-entrant acquisition does not corrupt validation state');

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 9b. Equivalent path spellings share re-entrant ownership ─────────
  test('canonical lock target identifies re-entry', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => {
      try { releaseSessionLock(base); } catch { /* best-effort */ }
      rmSync(base, { recursive: true, force: true });
    });

    assert.ok(acquireSessionLock(base).acquired, 'first acquisition succeeds');
    updateSessionLock(base, 'execute-task', 'M001/S01/T01');

    const equivalentBase = `${base}${sep}.`;
    const result = acquireSessionLock(equivalentBase);
    assert.deepStrictEqual(
      result,
      { acquired: true, reentrant: true },
      'realpath-equivalent base path is treated as re-entrant',
    );
    assert.deepStrictEqual(readSessionLockData(base)?.unitId, 'bootstrap', 'metadata is refreshed atomically');
    assert.ok(isSessionLockHeld(equivalentBase), 'canonical alias reports held ownership');

    releaseSessionLock(equivalentBase);
  });

  test('re-entry hands ownership to a migrated external-state lock target', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gsd-session-lock-migration-'));
    const base = join(root, 'project');
    const externalGsd = join(root, 'external-state');
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => {
      try { releaseSessionLock(base); } catch { /* best-effort */ }
      rmSync(root, { recursive: true, force: true });
    });

    assert.ok(acquireSessionLock(base).acquired, 'initial in-project lock acquired');
    const originalLockDir = join(base, '.gsd.lock');
    assert.ok(existsSync(originalLockDir), 'original physical target is locked');

    renameSync(join(base, '.gsd'), externalGsd);
    symlinkSync(
      externalGsd,
      join(base, '.gsd'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    assert.deepStrictEqual(
      acquireSessionLock(base),
      { acquired: true, reentrant: true },
      'same owner transfers the lock after external-state migration',
    );
    assert.equal(
      existsSync(originalLockDir),
      false,
      'old physical target is released after handoff',
    );
    assert.ok(existsSync(`${externalGsd}.lock`), 'new external-state target is locked');

    unlinkSync(join(externalGsd, 'auto.lock'));
    assert.deepStrictEqual(
      getSessionLockStatus(base),
      { valid: true },
      'OS ownership remains authoritative after metadata cleanup',
    );
  });

  // ─── 10. Re-entrant acquisition refreshes lock artifacts ──────────────
  console.log('\n=== 10. re-entrant acquire refreshes lock artifacts ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const r1 = acquireSessionLock(base);
      assert.ok(r1.acquired, 'first acquisition succeeds');

      const lockDir = gsdRoot(base) + '.lock';
      if (properLockfileAvailable) {
        assert.ok(existsSync(lockDir), '.gsd.lock/ exists after first acquisition');
      }

      const r2 = acquireSessionLock(base);
      assert.ok(r2.acquired, 'second acquisition succeeds');
      if (properLockfileAvailable) {
        assert.ok(existsSync(lockDir), '.gsd.lock/ exists after re-entrant acquisition');
      }
      assert.ok(validateSessionLock(base), 'lock remains valid after re-entrant acquisition');

      releaseSessionLock(base);
      assert.ok(!existsSync(lockDir), '.gsd.lock/ is removed after release');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }


  test('healthy re-entry excludes a concurrent process until explicit release', {
    skip: !properLockfileAvailable,
  }, async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-concurrency-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    const target = gsdRoot(base);
    assert.ok(acquireSessionLock(base).acquired, 'process A acquires the lock');

    const contenderScript = String.raw`
      const lockfile = require('proper-lockfile');
      const target = process.argv[1];
      let release = null;
      let running = true;
      let reportedBlocked = false;
      process.stdout.write('ready\n');
      function attempt() {
        if (!running || release) return;
        try {
          release = lockfile.lockSync(target, { realpath: false, stale: 1800000, update: 10000 });
          process.stdout.write('acquired\n');
        } catch {
          if (!reportedBlocked) {
            reportedBlocked = true;
            process.stdout.write('blocked\n');
          }
          setImmediate(attempt);
        }
      }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (command) => {
        if (command.includes('pause')) {
          running = false;
          process.stdout.write('paused\n');
        }
        if (command.includes('resume') && !release) {
          running = true;
          setImmediate(attempt);
        }
        if (command.includes('stop')) {
          running = false;
          try { if (release) release(); } catch {}
          process.exit(0);
        }
      });
      setImmediate(attempt);
    `;
    const child = spawn(process.execPath, ['-e', contenderScript, target], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const waitForOutput = (value: string, timeoutMs = 3_000): Promise<void> => new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (output.includes(value)) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 10);
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(
          `Timed out waiting for contender output ${JSON.stringify(value)}; `
          + `stdout=${JSON.stringify(output)} stderr=${JSON.stringify(stderr)}`,
        ));
      }, timeoutMs);
      if (output.includes(value)) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    });

    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const forceExit = setTimeout(() => { child.kill(); }, 500);
          const giveUp = setTimeout(() => reject(new Error('contender process did not exit')), 1_500);
          child.once('close', () => {
            clearTimeout(forceExit);
            clearTimeout(giveUp);
            resolve();
          });
          try { child.stdin.end('stop'); } catch { child.kill(); }
        });
      }
      try { releaseSessionLock(base); } catch { /* best-effort */ }
      rmSync(base, { recursive: true, force: true });
    });

    await waitForOutput('ready\n');
    await waitForOutput('blocked\n');

    for (let attempt = 0; attempt < 100; attempt++) {
      assert.deepStrictEqual(
        acquireSessionLock(base),
        { acquired: true, reentrant: true },
        `process A keeps ownership during re-entry ${attempt + 1}`,
      );
    }
    child.stdin.write('pause\n');
    await waitForOutput('paused\n');
    assert.doesNotMatch(output, /acquired/, 'process B cannot acquire during process A re-entry');

    releaseSessionLock(base);
    child.stdin.write('resume\n');
    await waitForOutput('acquired\n');
    assert.match(output, /acquired/, 'process B acquires only after process A explicitly releases');
  });

  test('getSessionLockStatus re-acquires only after onCompromised drops ownership', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-recovery-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    let held = false;
    let lockCalls = 0;
    let compromised: (() => void) | undefined;
    let lockFile = '';
    let removeMetadataOnBlockedAttempt = false;
    const fakeLockfile = {
      lockSync: (_path, options) => {
        if (held) {
          if (removeMetadataOnBlockedAttempt && lockFile) unlinkSync(lockFile);
          throw new Error('already locked');
        }
        held = true;
        lockCalls++;
        compromised = options?.onCompromised;
        return () => { held = false; };
      },
    } satisfies NonNullable<Parameters<typeof _setProperLockfileForTests>[0]>;
    const realDateNow = Date.now;
    let restoreLockfile = (): void => {};
    t.after(() => {
      Date.now = realDateNow;
      try { releaseSessionLock(base); } catch { /* best-effort */ }
      restoreLockfile();
      rmSync(base, { recursive: true, force: true });
    });

    restoreLockfile = _setProperLockfileForTests(fakeLockfile);
    assert.ok(acquireSessionLock(base).acquired, 'initial fake OS lock acquired');
    lockFile = join(gsdRoot(base), 'auto.lock');
    const lockDir = gsdRoot(base) + '.lock';
    mkdirSync(lockDir, { recursive: true });
    const metadata = readFileSync(lockFile, 'utf8');

    Date.now = () => realDateNow() + 1_800_001;
    unlinkSync(lockFile);
    compromised?.();
    writeFileSync(lockFile, metadata);
    Date.now = realDateNow;

    removeMetadataOnBlockedAttempt = true;
    assert.deepStrictEqual(
      getSessionLockStatus(base),
      {
        valid: false,
        failureReason: 'compromised',
        existingPid: process.pid,
        expectedPid: process.pid,
      },
      'recovery does not replace a lock that is still held',
    );
    assert.deepStrictEqual(lockCalls, 1, 'held lock prevents replacement acquisition');
    assert.ok(existsSync(lockDir), 'compromised recovery never removes the held lock directory');

    writeFileSync(lockFile, metadata);
    removeMetadataOnBlockedAttempt = false;
    held = false;
    assert.deepStrictEqual(
      getSessionLockStatus(base),
      { valid: true, recovered: true },
      'status validation re-acquires after compromised ownership is gone',
    );
    assert.deepStrictEqual(lockCalls, 2, 'recovery performs one replacement acquisition');
  });
});
