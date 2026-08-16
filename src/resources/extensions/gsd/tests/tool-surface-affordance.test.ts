// Project/App: gsd-pi
// File Purpose: The Tool Surface must advertise the tokens the contract enforces.
//
// Every HARD BLOCK observed in the auto-mode acceptance runs was a near-miss on a
// token the agent could not see until it was rejected — `gsd_uat_exec` for
// `gsd_exec`, subagent `"review"` for `"reviewer"`, `bash` for `gsd_exec`. The
// contract was enforced but not advertised: 15 of the 24 units with an enforced
// `allowedGsdTools` list had no tool guidance at all.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { composeToolAffordanceReminder, composeToolSurfaceInstructions } from "../unit-context-composer.ts";
import { UNIT_TOOL_CONTRACTS } from "../unit-tool-contracts.ts";
import { resolveManifest } from "../unit-context-manifest.ts";

const UNITS = Object.keys(UNIT_TOOL_CONTRACTS);

/** Budget for the derived affordance line. It rides in every unit prompt of every run. */
const DERIVED_LINE_BUDGET_CHARS = 400;

describe("tool surface advertises the enforced contract", () => {
  test("every unit with a tool contract names each allowed GSD tool", () => {
    const gaps: string[] = [];
    for (const unit of UNITS) {
      const surface = composeToolSurfaceInstructions(unit, { renderMode: "standalone" });
      const missing = UNIT_TOOL_CONTRACTS[unit]!.allowedGsdTools.filter(
        (tool) => !surface.includes(`\`${tool}\``),
      );
      if (missing.length > 0) gaps.push(`${unit}: ${missing.join(", ")}`);
    }
    assert.deepEqual(gaps, [], `units not advertising their allowed GSD tools:\n${gaps.join("\n")}`);
  });

  test("allowed subagent tokens are named verbatim where the policy declares them", () => {
    const gaps: string[] = [];
    for (const unit of UNITS) {
      const policy = resolveManifest(unit)?.tools;
      const allowed = policy && "allowedSubagents" in policy ? policy.allowedSubagents ?? [] : [];
      if (allowed.length === 0) continue;
      const surface = composeToolSurfaceInstructions(unit, { renderMode: "standalone" });
      const missing = allowed.filter((agent) => !surface.includes(`\`${agent}\``));
      if (missing.length > 0) gaps.push(`${unit}: ${missing.join(", ")}`);
    }
    assert.deepEqual(gaps, [], `units not advertising their allowed subagents:\n${gaps.join("\n")}`);
  });

  test("the derived affordance line stays within its token budget", () => {
    const over: string[] = [];
    for (const unit of UNITS) {
      const surface = composeToolSurfaceInstructions(unit, { renderMode: "standalone" });
      const derived = surface
        .split("\n")
        .find((line) => line.startsWith("GSD lifecycle tools available here:")) ?? "";
      if (derived.length > DERIVED_LINE_BUDGET_CHARS) over.push(`${unit}: ${derived.length} chars`);
    }
    assert.deepEqual(over, [], `derived tool line over ${DERIVED_LINE_BUDGET_CHARS} chars:\n${over.join("\n")}`);
  });

  test("the surface does not claim the list is exhaustive", () => {
    // Generic tools (read, grep) are unaffected by allowedGsdTools; wording that
    // implies otherwise would suppress legitimate tool use.
    for (const unit of UNITS) {
      const surface = composeToolSurfaceInstructions(unit, { renderMode: "standalone" });
      assert.equal(
        /only tools you may use|the only tools/i.test(surface),
        false,
        `${unit}: surface implies the GSD list is the complete tool set`,
      );
    }
  });
});

describe("guidance prose agrees with the enforced contract", () => {
  // Pins the property I had to verify by hand twice while diagnosing: a tool the
  // prose tells a unit to *use* must actually be allowed. Prohibitions ("do not
  // call X") legitimately name forbidden tools, so only positive mentions count.
  test("tools named positively in guidance are in the unit's allow-list", () => {
    const drift: string[] = [];
    for (const unit of UNITS) {
      const allowed = new Set(UNIT_TOOL_CONTRACTS[unit]!.allowedGsdTools as readonly string[]);
      const surface = composeToolSurfaceInstructions(unit, { renderMode: "standalone" });
      for (const sentence of surface.split(/(?<=[.!?])\s+/)) {
        if (/\bdo not\b|\bnot available\b|\bunavailable\b|\bbelongs to\b|\bis not\b/i.test(sentence)) continue;
        if (sentence.startsWith("GSD lifecycle tools available here:")) continue;
        for (const tool of sentence.match(/gsd_[a-z_]+/g) ?? []) {
          if (!allowed.has(tool)) drift.push(`${unit}: "${tool}" recommended but not allowed`);
        }
      }
    }
    assert.deepEqual(drift, [], `guidance recommends forbidden tools:\n${drift.join("\n")}`);
  });
});

describe("tail reminder puts the affordance where the model acts", () => {
  // Run 9 proved the `## Tool Surface` section alone is not enough: it lands at
  // char 627 of validate-milestone's 14,358-char prompt — 4% in, with 13,731
  // characters after it — and the unit still reached for `bash`, `gsd_uat_exec`,
  // and subagent "review". These assertions pin the position, not just presence.
  test("reminder names the allowed tokens for a unit with a contract", () => {
    const reminder = composeToolAffordanceReminder("validate-milestone");
    for (const tool of UNIT_TOOL_CONTRACTS["validate-milestone"]!.allowedGsdTools) {
      assert.ok(reminder.includes(`\`${tool}\``), `reminder omits ${tool}`);
    }
    assert.ok(reminder.includes("`reviewer`"), "reminder omits allowed subagent tokens");
    assert.ok(/near-miss/i.test(reminder), "reminder should warn that variants are rejected");
    // Run 13 regression: the reminder is a name-reference, not a menu. Phrasing it
    // as "available here" invited validate-milestone to call gsd_reassess_roadmap
    // and grow a completed milestone a new slice, and the run stopped terminating.
    assert.ok(
      /does not mean this unit needs it/i.test(reminder),
      "reminder must not read as an invitation to use every listed tool",
    );
  });

  test("reminder is a single compact line — the prompt tail is expensive", () => {
    for (const unit of UNITS) {
      const reminder = composeToolAffordanceReminder(unit);
      if (!reminder) continue;
      assert.equal(reminder.includes("\n"), false, `${unit}: reminder must stay one line`);
      assert.ok(reminder.length <= 640, `${unit}: reminder is ${reminder.length} chars`);
    }
  });

  test("units without a tool contract get no reminder", () => {
    assert.equal(composeToolAffordanceReminder("definitely-not-a-unit"), "");
  });
});
