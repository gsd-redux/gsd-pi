/**
 * Regression test for #3674 — block direct writes to gsd.db
 *
 * When gsd_complete_task was unavailable, agents fell back to shell-based
 * sqlite3 writes, corrupting the WAL-backed database. The fix extends
 * write-intercept to block file writes and bash commands targeting gsd.db.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedStateFile, isBashWriteToStateFile } from '../write-intercept.ts';

describe('isBlockedStateFile blocks gsd.db paths (#3674)', () => {
  test('blocks .gsd/gsd.db', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/gsd.db'));
  });

  test('blocks .gsd/gsd.db-wal', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/gsd.db-wal'));
  });

  test('blocks .gsd/gsd.db-shm', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/gsd.db-shm'));
  });

  test('blocks resolved symlink path under .gsd/projects/', () => {
    assert.ok(isBlockedStateFile('/home/user/.gsd/projects/myproj/gsd.db'));
  });

  test('still blocks STATE.md', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/STATE.md'));
  });

  test('does not block other .gsd files', () => {
    assert.ok(!isBlockedStateFile('/project/.gsd/DECISIONS.md'));
  });
});

describe('isBashWriteToStateFile blocks DB shell commands (#3674)', () => {
  test('blocks sqlite3 targeting gsd.db', () => {
    assert.ok(isBashWriteToStateFile('sqlite3 .gsd/gsd.db "INSERT INTO ..."'));
  });

  test('blocks better-sqlite3 targeting gsd.db', () => {
    assert.ok(isBashWriteToStateFile('node -e "require(\'better-sqlite3\')(\'.gsd/gsd.db\')"'));
  });

  test('blocks shell redirect to gsd.db', () => {
    assert.ok(isBashWriteToStateFile('echo data > .gsd/gsd.db'));
  });

  test('blocks cp to gsd.db', () => {
    assert.ok(isBashWriteToStateFile('cp backup.db .gsd/gsd.db'));
  });

  test('blocks mv to gsd.db', () => {
    assert.ok(isBashWriteToStateFile('mv temp.db .gsd/gsd.db'));
  });

  test('does not block reading gsd.db with cat', () => {
    assert.ok(!isBashWriteToStateFile('cat .gsd/gsd.db'));
  });
});

describe('isBashWriteToStateFile allows read-only access (#2200)', () => {
  test('allows sqlite3 -readonly SELECT inspection', () => {
    assert.ok(!isBashWriteToStateFile('sqlite3 -readonly .gsd/gsd.db "SELECT count(*) FROM tasks"'));
  });

  test('allows sqlite3 --readonly .schema inspection', () => {
    assert.ok(!isBashWriteToStateFile('sqlite3 --readonly .gsd/gsd.db ".schema"'));
  });

  test('allows -readonly at any option position', () => {
    assert.ok(!isBashWriteToStateFile('sqlite3 -batch -readonly .gsd/gsd.db ".tables"'));
    assert.ok(!isBashWriteToStateFile('sqlite3 -csv -header -readonly .gsd/gsd.db "SELECT 1"'));
    assert.ok(!isBashWriteToStateFile('sqlite3 --batch --readonly .gsd/gsd.db ".schema"'));
  });

  test('allows copying gsd.db out (db is the source, not the target)', () => {
    assert.ok(!isBashWriteToStateFile('cp .gsd/gsd.db /tmp/copy.db'));
  });

  test('allows copying a quoted gsd.db path out', () => {
    assert.ok(!isBashWriteToStateFile('cp ".gsd/gsd.db" /tmp/copy.db'));
  });

  test('allows grepping the source tree for the file names', () => {
    assert.ok(!isBashWriteToStateFile('grep -rn "gsd.db" src/'));
    assert.ok(!isBashWriteToStateFile('grep -rn "gsd.db|STATE.md" src/'));
  });

  test('allows grep alternation whose \\| is not a shell redirect', () => {
    assert.ok(!isBashWriteToStateFile('grep -rln "gsd.db\\|STATE.md.*blocked" src/'));
  });
});

describe('isBashWriteToStateFile still blocks genuine writes (#2200 controls)', () => {
  test('blocks overwrite and append redirects to STATE.md', () => {
    assert.ok(isBashWriteToStateFile('echo x > .gsd/STATE.md'));
    assert.ok(isBashWriteToStateFile('echo x >> .gsd/STATE.md'));
  });

  test('blocks cp/mv targeting STATE.md', () => {
    assert.ok(isBashWriteToStateFile('cp x .gsd/STATE.md'));
    assert.ok(isBashWriteToStateFile('mv x .gsd/STATE.md'));
  });

  test('blocks cp/mv targeting quoted STATE.md paths', () => {
    assert.ok(isBashWriteToStateFile('cp x ".gsd/STATE.md"'));
    assert.ok(isBashWriteToStateFile("mv x '.gsd/STATE.md'"));
  });

  test('blocks tee to STATE.md', () => {
    assert.ok(isBashWriteToStateFile('echo x | tee .gsd/STATE.md'));
  });

  test('blocks sed -i on STATE.md', () => {
    assert.ok(isBashWriteToStateFile('sed -i s/pending/running/ .gsd/STATE.md'));
  });

  test('blocks append redirect to gsd.db', () => {
    assert.ok(isBashWriteToStateFile('echo x >> .gsd/gsd.db'));
  });

  test('blocks dd writing gsd.db', () => {
    assert.ok(isBashWriteToStateFile('dd if=/dev/zero of=.gsd/gsd.db'));
  });

  test('blocks cp/mv targeting gsd.db in compound commands', () => {
    assert.ok(isBashWriteToStateFile('cp a b && cp c .gsd/gsd.db'));
    assert.ok(isBashWriteToStateFile('cp x .gsd/gsd.db; echo done'));
  });

  test('blocks cp/mv targeting quoted gsd.db paths', () => {
    assert.ok(isBashWriteToStateFile('cp x ".gsd/gsd.db"'));
    assert.ok(isBashWriteToStateFile('cp a b && mv c ".gsd/gsd.db-wal"'));
  });

  test('blocks sqlite3 without -readonly, even for SELECT text', () => {
    // Without -readonly the CLI executes arbitrary SQL (multi-statement strings
    // can write), so SELECT/.dump/.schema text alone does not exempt it.
    assert.ok(isBashWriteToStateFile('sqlite3 .gsd/gsd.db "INSERT INTO ..."'));
    assert.ok(isBashWriteToStateFile('sqlite3 .gsd/gsd.db "SELECT 1"'));
  });

  test('blocks sqlite3 with other flags but no -readonly', () => {
    assert.ok(isBashWriteToStateFile('sqlite3 -batch .gsd/gsd.db "DELETE FROM tasks"'));
  });
});
