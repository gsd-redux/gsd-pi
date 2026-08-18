// Tests for the Phase H first vertical slice — registering newly-discovered
// GitHub Copilot models into the runtime `models-catalog.json` overlay.
// Mirrors the fixture/harness style of `src/tests/update-models-cmd.test.ts`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COPILOT_OVERLAY_PLACEHOLDER_CONTEXT_WINDOW,
  COPILOT_OVERLAY_PLACEHOLDER_MAX_TOKENS,
  mergeIntoModelsCatalogOverlay,
  readModelsCatalogOverlay,
  registerCopilotModelsInOverlay,
  synthesizeCopilotOverlayEntry,
  writeModelsCatalogOverlay,
} from "../copilot-overlay-writer.js";
import type { CopilotModelRecord } from "../copilot-model-catalog.js";

function record(id: string, name = id): CopilotModelRecord {
  return { id, name, tool_call: true, registryId: `github-copilot/${id}` };
}

test("synthesizeCopilotOverlayEntry produces a schema-valid, clearly-placeholdered entry", () => {
  const entry = synthesizeCopilotOverlayEntry(record("brand-new-model", "Brand New Model"));

  assert.equal(entry.id, "brand-new-model");
  assert.equal(entry.name, "Brand New Model");
  assert.equal(entry.api, "openai-completions");
  assert.equal(entry.provider, "github-copilot");
  assert.equal(entry.baseUrl, "https://api.individual.githubcopilot.com");
  assert.equal(entry.reasoning, false, "reasoning is an unknown placeholder, never guessed true");
  assert.deepEqual(entry.input, ["text"]);
  assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(entry.contextWindow, COPILOT_OVERLAY_PLACEHOLDER_CONTEXT_WINDOW);
  assert.equal(entry.maxTokens, COPILOT_OVERLAY_PLACEHOLDER_MAX_TOKENS);
  assert.equal(entry.headers?.["User-Agent"], "GitHubCopilotChat/0.35.0");
});

test("synthesizeCopilotOverlayEntry falls back to id when name is blank", () => {
  const entry = synthesizeCopilotOverlayEntry({ id: "no-name-model", name: "", tool_call: true });
  assert.equal(entry.name, "no-name-model");
});

test("mergeIntoModelsCatalogOverlay: starting from nothing produces a valid overlay with only github-copilot", () => {
  const merged = mergeIntoModelsCatalogOverlay(null, [synthesizeCopilotOverlayEntry(record("new-model"))]);

  assert.equal(merged.version, 1);
  assert.ok(typeof merged.fetchedAt === "string" && !Number.isNaN(Date.parse(merged.fetchedAt)));
  assert.deepEqual(Object.keys(merged.models), ["github-copilot"]);
  assert.deepEqual(Object.keys(merged.models["github-copilot"]), ["new-model"]);
});

test("mergeIntoModelsCatalogOverlay never touches unrelated providers", () => {
  const existing = {
    version: 1 as const,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "https://example.com/catalog.json",
    models: {
      anthropic: {
        "claude-opus-4-6": synthesizeCopilotOverlayEntry(record("claude-opus-4-6")) as any,
      },
      "github-copilot": {
        "existing-model": synthesizeCopilotOverlayEntry(record("existing-model")),
      },
    },
  };

  const merged = mergeIntoModelsCatalogOverlay(existing, [synthesizeCopilotOverlayEntry(record("new-model"))]);

  assert.ok(merged.models.anthropic["claude-opus-4-6"], "unrelated provider entry must survive untouched");
  assert.ok(merged.models["github-copilot"]["existing-model"], "existing copilot entry must survive");
  assert.ok(merged.models["github-copilot"]["new-model"], "new copilot entry must be added");
});

test("mergeIntoModelsCatalogOverlay never downgrades an existing entry (e.g. a richer models.dev-sourced one)", () => {
  const richEntry = {
    ...synthesizeCopilotOverlayEntry(record("gpt-5.4")),
    reasoning: true,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    contextWindow: 400_000,
  };
  const existing = {
    version: 1 as const,
    models: { "github-copilot": { "gpt-5.4": richEntry } },
  };

  const merged = mergeIntoModelsCatalogOverlay(existing, [synthesizeCopilotOverlayEntry(record("gpt-5.4"))]);

  assert.deepEqual(
    merged.models["github-copilot"]["gpt-5.4"],
    richEntry,
    "a placeholder synth must never overwrite a richer existing entry for the same model id",
  );
});

test("writeModelsCatalogOverlay writes atomically and leaves no temp-file leftovers", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const path = join(tmp, "models-catalog.json");

  const overlay = mergeIntoModelsCatalogOverlay(null, [synthesizeCopilotOverlayEntry(record("m1"))]);
  writeModelsCatalogOverlay(path, overlay);

  const onDisk = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual(onDisk, overlay);

  const leftovers = readdirSync(tmp).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "atomic write must leave no temp files");
});

test("readModelsCatalogOverlay returns null for a missing file", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.equal(readModelsCatalogOverlay(join(tmp, "does-not-exist.json")), null);
});

test("readModelsCatalogOverlay returns null for a malformed/invalid file", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const path = join(tmp, "models-catalog.json");

  writeFileSync(path, "not json");
  assert.equal(readModelsCatalogOverlay(path), null, "malformed JSON must not throw");

  writeFileSync(path, JSON.stringify({ version: 1, models: {} }));
  assert.equal(readModelsCatalogOverlay(path), null, "empty catalog must fail isModelsCatalog validation");
});

test("registerCopilotModelsInOverlay: safe containment quarantines remote-only models instead of persisting placeholders", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");

  const first = registerCopilotModelsInOverlay(overlayPath, [record("model-a"), record("model-b")]);
  assert.deepEqual(first.registeredIds, [], "remote-only entries are quarantined, never registered as concrete metadata");
  assert.deepEqual(first.quarantined.map((model) => model.id).sort(), ["model-a", "model-b"]);
  assert.equal(first.overlayPath, overlayPath);
  assert.equal(readModelsCatalogOverlay(overlayPath), null, "no placeholder metadata may be written to the on-disk overlay");

  const second = registerCopilotModelsInOverlay(overlayPath, [record("model-a"), record("model-c")]);
  assert.deepEqual(second.registeredIds, [], "the safe path never materializes remote-only models as registered");
  assert.deepEqual(second.quarantined.map((model) => model.id).sort(), ["model-a", "model-c"]);
  assert.equal(readModelsCatalogOverlay(overlayPath), null, "repeated quarantine checks must not write any placeholder overlay");
});

test("registerCopilotModelsInOverlay does not clobber a pre-existing overlay written by gsd update --models", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-copilot-overlay-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const overlayPath = join(tmp, "models-catalog.json");
  mkdirSync(tmp, { recursive: true });

  const preexisting = {
    version: 1,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "https://raw.githubusercontent.com/open-gsd/gsd-pi/main/packages/pi-ai/src/models.generated.json",
    models: {
      anthropic: { "claude-opus-4-6": { ...synthesizeCopilotOverlayEntry(record("claude-opus-4-6")), provider: "anthropic" } },
      "github-copilot": { "gpt-5.4": synthesizeCopilotOverlayEntry(record("gpt-5.4")) },
    },
  };
  writeFileSync(overlayPath, JSON.stringify(preexisting, null, 2));

  const result = registerCopilotModelsInOverlay(overlayPath, [record("gpt-5.4"), record("brand-new")]);
  assert.deepEqual(result.registeredIds, [], "existing authoritative entries and remote-only candidates are not written to disk");
  assert.deepEqual(result.quarantined.map((model) => model.id).sort(), ["brand-new"]);

  const onDisk = readModelsCatalogOverlay(overlayPath);
  assert.deepEqual(onDisk, preexisting, "pre-existing overlay must be left intact and never overwritten with placeholders");
  assert.ok(onDisk?.models.anthropic["claude-opus-4-6"], "unrelated provider from gsd update --models survives");
  assert.ok(onDisk?.models["github-copilot"]["gpt-5.4"], "existing copilot entry survives");
  assert.equal(onDisk?.models["github-copilot"]["brand-new"], undefined, "remote-only model stays quarantined and is never materialized");
});
