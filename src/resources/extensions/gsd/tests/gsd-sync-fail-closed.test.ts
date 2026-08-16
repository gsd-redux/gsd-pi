// Project/App: gsd-pi
// File Purpose: Proves /gsd sync preserves projection drift before canonical rendering.

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { handleSync } from "../commands-maintenance.ts";
import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "../compat/compat-marker.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import { fingerprintLegacyImportCorpusTree } from "./helpers/legacy-import-corpus.ts";

const WORKFLOW_AUTHORITY_TABLES = [
  "milestones",
  "slices",
  "tasks",
  "slice_dependencies",
  "requirements",
  "decisions",
  "memories",
  "assessments",
  "workflow_item_lifecycles",
] as const;
const temporaryDirectories = new Set<string>();

interface Notification {
  message: string;
  level: string;
}

function db(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function tableSnapshot(tables: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(tables.map((table) => [
    table,
    db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function workflowAuthoritySnapshot(): Record<string, unknown> {
  return tableSnapshot(WORKFLOW_AUTHORITY_TABLES);
}

function makeWorkspace(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-sync-fail-closed-"));
  temporaryDirectories.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Canonical milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Canonical slice",
    status: "pending",
    risk: "low",
    depends: [],
    sequence: 1,
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Canonical task",
    status: "pending",
  });
  return base;
}

function makeContext(): { ctx: ExtensionCommandContext; notifications: Notification[] } {
  const notifications: Notification[] = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

function projectionTreeSnapshot(root: string, relative = ""): string[] {
  const rows: string[] = [];
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (
      child === ".compat.json"
      || child === "gsd.db"
      || child === "gsd.db-wal"
      || child === "gsd.db-shm"
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      rows.push(`${child}/`);
      rows.push(...projectionTreeSnapshot(root, child));
    } else {
      rows.push(`${child}:${readFileSync(join(root, child)).toString("base64")}`);
    }
  }
  return rows;
}

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

test("/gsd sync preserves modeled .gsd drift before restoring the DB projection", async () => {
  const base = makeWorkspace();
  const relativePath = "phases/01-canonical/01-ROADMAP.md";
  const sourcePath = join(base, ".gsd", relativePath);
  mkdirSync(join(base, ".gsd", "phases", "01-canonical"), { recursive: true });
  const editedProjection = [
      "# M001: Edited projection",
      "",
      "**Vision:** This external edit requires an explicit authority choice.",
      "",
      "## Slices",
      "",
      "- [x] **S01: Edited projection slice** `risk:high` `depends:[]`",
      "",
    ].join("\n");
  writeFileSync(sourcePath, editedProjection);
  const siblingPath = join(base, ".gsd", "phases", "01-canonical", "01-CONTEXT.md");
  writeFileSync(siblingPath, "# Unrelated sibling projection\n");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {
      [relativePath]: { sha: "stale000000000000", entities: ["M001", "M001/S01"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "test",
  });
  const authorityBefore = workflowAuthoritySnapshot();
  const { ctx, notifications } = makeContext();

  await handleSync(ctx, base);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /Preserved external projection edits: 1/);
  assert.match(readFileSync(sourcePath, "utf8"), /Canonical milestone/);
  assert.ok(
    projectionTreeSnapshot(join(base, ".gsd", "quarantine", "projections"))
      .some((row) => row.endsWith(Buffer.from(editedProjection).toString("base64"))),
    "the quarantine retains the exact edited bytes",
  );
  assert.deepEqual(workflowAuthoritySnapshot(), authorityBefore, "projection repair does not mutate workflow authority");
});

test("/gsd sync preserves modeled active .planning drift before canonical rendering", async () => {
  const base = makeWorkspace();
  mkdirSync(join(base, ".planning"), { recursive: true });
  const planningPath = join(base, ".planning", "ROADMAP.md");
  const editedProjection = "# Roadmap\n\n## Phases\n\n- [x] 01 — Edited projection\n";
  writeFileSync(planningPath, editedProjection);
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {
        "ROADMAP.md": { sha: "stale000000000000", entities: ["M001"] },
      },
      passthrough: {},
    },
    piVersion: "test",
  });
  const authorityBefore = workflowAuthoritySnapshot();
  const { ctx, notifications } = makeContext();

  await handleSync(ctx, base);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /Preserved external projection edits: 1/);
  assert.doesNotMatch(readFileSync(planningPath, "utf8"), /Edited projection/);
  assert.ok(
    projectionTreeSnapshot(join(base, ".gsd", "quarantine", "projections"))
      .some((row) => row.endsWith(Buffer.from(editedProjection).toString("base64"))),
    "the quarantine retains the exact edited planning bytes",
  );
  assert.deepEqual(workflowAuthoritySnapshot(), authorityBefore, "projection repair does not mutate workflow authority");
});

test("/gsd sync still accepts active .planning passthrough drift", async () => {
  const base = makeWorkspace();
  const relativePath = "codebase/STACK.md";
  const sourcePath = join(base, ".planning", relativePath);
  mkdirSync(join(base, ".planning", "codebase"), { recursive: true });
  writeFileSync(sourcePath, "# Updated stack notes\n");
  writeFileSync(join(base, ".planning", "codebase", "ARCHITECTURE.md"), "# User-owned sibling notes\n");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {},
      passthrough: {
        [relativePath]: { sha: "stale000000000000", entities: [] },
      },
    },
    piVersion: "test",
  });
  const sourceBefore = readFileSync(sourcePath);
  const passthroughTreeBefore = fingerprintLegacyImportCorpusTree(join(base, ".planning", "codebase"));
  const { ctx, notifications } = makeContext();

  await handleSync(ctx, base);

  assert.deepEqual(readFileSync(sourcePath), sourceBefore, "passthrough content remains user-owned");
  assert.equal(
    fingerprintLegacyImportCorpusTree(join(base, ".planning", "codebase")),
    passthroughTreeBefore,
    "safe checksum refresh leaves the complete passthrough subtree exact",
  );
  assert.equal(
    readCompatMarker(base).planning?.passthrough[relativePath]?.sha,
    computeProjectionSha(sourceBefore.toString("utf8")),
    "safe passthrough drift refreshes its marker SHA",
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /passthrough/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /\/gsd rebuild markdown|\/gsd recover/);
});

test("/gsd sync --dry-run reports projection preservation without changing bytes or baselines", async () => {
  const base = makeWorkspace();
  const relativePath = "phases/01-canonical/01-ROADMAP.md";
  const sourcePath = join(base, ".gsd", relativePath);
  mkdirSync(join(base, ".gsd", "phases", "01-canonical"), { recursive: true });
  const editedProjection = "# Externally edited roadmap\n";
  writeFileSync(sourcePath, editedProjection);
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {
      [relativePath]: { sha: "stale000000000000", entities: ["milestone:M001"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "test",
  });
  const markerBefore = readFileSync(join(base, ".gsd", ".compat.json"));
  const { ctx, notifications } = makeContext();

  await handleSync(ctx, base, "--dry-run");

  assert.equal(readFileSync(sourcePath, "utf8"), editedProjection);
  assert.deepEqual(readFileSync(join(base, ".gsd", ".compat.json")), markerBefore);
  assert.equal(existsSync(join(base, ".gsd", "quarantine")), false);
  assert.match(notifications[0]?.message ?? "", /Projection edits to preserve: 1/);
  assert.match(notifications[0]?.message ?? "", /dry-run: no repairs, projection, or marker writes performed/);
});
