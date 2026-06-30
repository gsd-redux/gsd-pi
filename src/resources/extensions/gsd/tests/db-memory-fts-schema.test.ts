// Project/App: gsd-pi
// File Purpose: Tests for memory FTS5 schema helpers.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  MEMORIES_FTS_REBUILT_KEY,
  isMemoriesFtsAvailableSchema,
  rebuildMemoriesFtsSchemaOnce,
  tryCreateMemoriesFtsSchema,
} from "../db-memory-fts-schema.ts";
import { createDbAdapter, type DbAdapter, type DbStatement } from "../db-adapter.ts";

const _require = createRequire(import.meta.url);

class FakeStatement implements DbStatement {
  private readonly row: Record<string, unknown> | undefined;

  constructor(row: Record<string, unknown> | undefined) {
    this.row = row;
  }

  run(): unknown {
    return undefined;
  }

  get(): Record<string, unknown> | undefined {
    return this.row;
  }

  all(): Record<string, unknown>[] {
    return [];
  }
}

class FakeAdapter implements DbAdapter {
  readonly execCalls: string[] = [];
  hasFts = false;
  hasRebuildMarker = false;
  failExec = false;

  exec(sql: string): void {
    this.execCalls.push(sql);
    if (this.failExec) throw new Error("fts unavailable");
  }

  prepare(sql: string): DbStatement {
    if (sql.includes("sqlite_master")) {
      return new FakeStatement(this.hasFts ? { name: "memories_fts" } : undefined);
    }
    if (sql.includes("runtime_kv")) {
      return new FakeStatement(this.hasRebuildMarker ? { present: 1 } : undefined);
    }
    return new FakeStatement(undefined);
  }

  close(): void {}
}

function openMemoryAdapter(): { db: DbAdapter; close: () => void } {
  const sqlite = _require("node:sqlite") as { DatabaseSync: new (path: string) => unknown };
  const raw = new sqlite.DatabaseSync(":memory:");
  const db = createDbAdapter(raw);
  return { db, close: () => db.close() };
}

describe("db-memory-fts-schema", () => {
  test("creates memories_fts and insert/delete/update triggers", () => {
    const db = new FakeAdapter();

    const ok = tryCreateMemoriesFtsSchema(db);

    assert.equal(ok, true);
    assert.equal(db.execCalls.length, 4);
    assert.match(db.execCalls[0], /CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts/);
    assert.match(db.execCalls[1], /CREATE TRIGGER IF NOT EXISTS memories_ai/);
    assert.match(db.execCalls[2], /CREATE TRIGGER IF NOT EXISTS memories_ad/);
    assert.match(db.execCalls[3], /CREATE TRIGGER IF NOT EXISTS memories_au/);
  });

  test("reports unavailable FTS5 without throwing", () => {
    const db = new FakeAdapter();
    const messages: string[] = [];
    db.failExec = true;

    const ok = tryCreateMemoriesFtsSchema(db, {
      onUnavailable: (message) => messages.push(message),
    });

    assert.equal(ok, false);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /FTS5 unavailable/);
    assert.match(messages[0], /fts unavailable/);
  });

  test("checks whether the memories_fts table exists", () => {
    const db = new FakeAdapter();

    assert.equal(isMemoriesFtsAvailableSchema(db), false);

    db.hasFts = true;
    assert.equal(isMemoriesFtsAvailableSchema(db), true);
  });

  test("rebuilds the external-content index once and records a marker", () => {
    const { db, close } = openMemoryAdapter();
    try {
      db.exec("CREATE TABLE memories (seq INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL)");
      db.exec("INSERT INTO memories (content) VALUES ('pre FTS auth memory must be searchable')");

      const ok = tryCreateMemoriesFtsSchema(db);
      if (!ok) return;

      const before = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'auth'").all();
      assert.equal(before.length, 0, "external-content FTS starts empty for existing rows");

      rebuildMemoriesFtsSchemaOnce(db);

      const after = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'auth'").all();
      assert.deepEqual(after.map((row) => row["rowid"]), [1]);
      const marker = db.prepare(
        "SELECT value_json FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :key",
      ).get({ ":key": MEMORIES_FTS_REBUILT_KEY });
      assert.ok(marker, "rebuild marker should be stored");
    } finally {
      close();
    }
  });

  test("skips rebuild when marker already exists", () => {
    const db = new FakeAdapter();
    db.hasFts = true;
    db.hasRebuildMarker = true;

    rebuildMemoriesFtsSchemaOnce(db);

    assert.ok(db.execCalls.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS runtime_kv")));
    assert.ok(!db.execCalls.some((sql) => sql.includes("VALUES('rebuild')")));
  });
});
