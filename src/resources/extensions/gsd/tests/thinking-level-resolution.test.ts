/**
 * Per-phase thinking level resolution — behavior tests for ADR-026 (#497).
 *
 * Verifies the (model, thinking) pairing, the hybrid inline/block precedence,
 * sibling-chain fallback, and static validation through exported runtime APIs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveThinkingLevelForUnit, resolveModelWithFallbacksForUnit } from "../preferences-models.ts";
import { validatePreferences } from "../preferences-validation.ts";

function withPreferences<T>(frontmatter: string[], fn: () => T): T {
  const oldHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-thinking-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "preferences.md"), ["---", "token_profile: burn-max", ...frontmatter, "---", ""].join("\n"));
    return fn();
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("inline models.<phase>.thinking resolves for that phase", () => {
  withPreferences(
    ["models:", "  planning:", "    model: planning-model", "    thinking: xhigh"],
    () => {
      assert.equal(resolveThinkingLevelForUnit("plan-milestone"), "xhigh");
      // Model still resolves normally alongside the paired thinking.
      assert.equal(resolveModelWithFallbacksForUnit("plan-milestone")?.primary, "planning-model");
    },
  );
});

test("separate thinking block resolves without a model pin", () => {
  withPreferences(["thinking:", "  execution: low"], () => {
    assert.equal(resolveThinkingLevelForUnit("execute-task"), "low");
    // No model configured — model resolution stays undefined.
    assert.equal(resolveModelWithFallbacksForUnit("execute-task"), undefined);
  });
});

test("inline thinking on a model-less models entry resolves", () => {
  // `models.planning: { thinking: high }` with no model — inline thinking must
  // be honored even though the entry pins no model (resolveWinningPhase skips it).
  withPreferences(["models:", "  planning:", "    thinking: high"], () => {
    assert.equal(resolveThinkingLevelForUnit("plan-milestone"), "high");
    // Model resolution still yields nothing for that phase.
    assert.equal(resolveModelWithFallbacksForUnit("plan-milestone"), undefined);
  });
});

test("inline thinking wins over the block for the same phase", () => {
  withPreferences(
    [
      "models:",
      "  planning:",
      "    model: planning-model",
      "    thinking: high",
      "thinking:",
      "  planning: low",
    ],
    () => {
      assert.equal(resolveThinkingLevelForUnit("plan-slice"), "high");
    },
  );
});

test("a bare-string model bucket is complemented by the block for the same phase", () => {
  withPreferences(
    ["models:", "  execution: execution-model", "thinking:", "  execution: high"],
    () => {
      assert.equal(resolveModelWithFallbacksForUnit("execute-task")?.primary, "execution-model");
      assert.equal(resolveThinkingLevelForUnit("execute-task"), "high");
    },
  );
});

test("a claimed model bucket does not inherit a sibling's thinking", () => {
  // discuss has its own model (claims the bucket) but no thinking; planning has
  // thinking. discuss must NOT borrow planning's thinking — the pair is anchored
  // to the resolved model phase.
  withPreferences(
    [
      "models:",
      "  discuss: discuss-model",
      "  planning:",
      "    model: planning-model",
      "    thinking: xhigh",
    ],
    () => {
      assert.equal(resolveModelWithFallbacksForUnit("discuss-milestone")?.primary, "discuss-model");
      assert.equal(resolveThinkingLevelForUnit("discuss-milestone"), undefined);
    },
  );
});

test("with no model configured, the thinking block follows the sibling chain", () => {
  // discuss-milestone's chain is [discuss, planning]; only planning is set in
  // the block, so discuss inherits it.
  withPreferences(["thinking:", "  planning: high"], () => {
    assert.equal(resolveThinkingLevelForUnit("discuss-milestone"), "high");
  });
});

test("execution_simple inherits the execution block when its own is unset", () => {
  withPreferences(["thinking:", "  execution: medium"], () => {
    assert.equal(resolveThinkingLevelForUnit("execute-task-simple"), "medium");
  });
});

test("thinking.execution_simple resolves for execute-task-simple even when model falls through to execution", () => {
  // models.execution wins the model chain for execute-task-simple (no execution_simple model).
  // thinking.execution_simple is explicitly set and must be found — it must not
  // be shadowed by the winning model phase (execution).
  withPreferences(
    ["models:", "  execution: execution-model", "thinking:", "  execution_simple: low"],
    () => {
      assert.equal(resolveModelWithFallbacksForUnit("execute-task-simple")?.primary, "execution-model");
      assert.equal(resolveThinkingLevelForUnit("execute-task-simple"), "low");
    },
  );
});

test("returns undefined when nothing is configured", () => {
  withPreferences(["models:", "  planning: planning-model"], () => {
    assert.equal(resolveThinkingLevelForUnit("execute-task"), undefined);
    assert.equal(resolveThinkingLevelForUnit("plan-milestone"), undefined);
  });
});

test("validation warns on an illegal thinking level in the block", () => {
  const result = validatePreferences({ thinking: { planning: "ultra" } } as never);
  assert.ok(result.warnings.some((w) => w.includes("thinking.planning") && w.includes("not a valid thinking level")));
  // Invalid entry is dropped, not kept.
  assert.equal(result.preferences.thinking, undefined);
});

test("validation warns on an unknown phase key in the block", () => {
  const result = validatePreferences({ thinking: { plannning: "high" } } as never);
  assert.ok(result.warnings.some((w) => w.includes("unknown thinking phase") && w.includes("plannning")));
});

test("validation warns on AND strips an illegal inline models thinking level", () => {
  const result = validatePreferences({
    models: { planning: { model: "m", thinking: "ultra" } },
  } as never);
  assert.ok(result.warnings.some((w) => w.includes("models.planning.thinking") && w.includes("not a valid thinking level")));
  // The bad thinking field must be stripped so it can't reach the resolver,
  // while the rest of the model config survives.
  const planning = (result.preferences.models as Record<string, { model?: string; thinking?: string }>).planning;
  assert.equal(planning.thinking, undefined);
  assert.equal(planning.model, "m");
});

test("an empty-string model is treated as unconfigured (no {primary: ''})", () => {
  withPreferences(["models:", '  planning: ""'], () => {
    assert.equal(resolveModelWithFallbacksForUnit("plan-milestone"), undefined);
  });
});

test("an empty-string model falls through the sibling chain", () => {
  withPreferences(["models:", '  discuss: ""', "  planning: planning-model"], () => {
    // discuss is empty → chain falls through to planning.
    assert.equal(resolveModelWithFallbacksForUnit("discuss-milestone")?.primary, "planning-model");
  });
});

test("a model-less object entry is unconfigured and falls through to a sibling", () => {
  withPreferences(
    ["models:", "  discuss:", "    provider: anthropic", "  planning: planning-model"],
    () => {
      // discuss has no `model` → skipped → planning wins.
      assert.equal(resolveModelWithFallbacksForUnit("discuss-milestone")?.primary, "planning-model");
    },
  );
});

test("a sole model-less object entry yields undefined (no {primary: undefined})", () => {
  withPreferences(["models:", "  planning:", "    provider: anthropic"], () => {
    assert.equal(resolveModelWithFallbacksForUnit("plan-milestone"), undefined);
  });
});

test("validation drops a phase left hollow after stripping invalid thinking", () => {
  const result = validatePreferences({ models: { planning: { thinking: "bad" } } } as never);
  assert.ok(result.warnings.some((w) => w.includes("models.planning.thinking")));
  // No model remained after stripping → phase dropped entirely, not stored as {}.
  assert.equal((result.preferences.models as Record<string, unknown>).planning, undefined);
});

test("validation accepts a valid thinking block", () => {
  const result = validatePreferences({ thinking: { planning: "xhigh", execution: "low" } } as never);
  assert.deepEqual(result.preferences.thinking, { planning: "xhigh", execution: "low" });
  assert.equal(result.errors.length, 0);
});
