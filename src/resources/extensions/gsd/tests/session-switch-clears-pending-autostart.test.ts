// gsd-pi — A fresh conversation (/clear, /new) must clear pending auto-start.
//
// The discuss→auto handoff entry lives in-memory and is consumed on agent_end
// of the live interview. Once the milestone CONTEXT artifact is saved, the
// guided-flow staleness heuristic (which requires the CONTEXT file to be
// absent) can never fire — so a discussion interrupted by /clear left an
// immortal entry and every subsequent /gsd dead-ended on "Discussion already
// in progress — answer the question above" with no question above.
//
// session_switch with reason "new" means the conversation that contained the
// interview is gone; the entry must go with it. Reason "resume" restores the
// interview transcript, so the entry must survive.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  setPendingAutoStart,
  clearPendingAutoStart,
  _getPendingAutoStart,
} from "../pending-auto-start.ts";

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-session-switch-pas-"));
  const milestoneDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  // The post-CONTEXT state that made the entry immortal before the fix.
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001 Context\n");
  return dir;
}

function fakeCtx(base: string): any {
  return {
    cwd: base,
    ui: {
      notify: () => undefined,
      setWidget: () => undefined,
      setStatus: () => undefined,
    },
  };
}

function armPendingAutoStart(base: string): void {
  setPendingAutoStart(base, {
    basePath: base,
    milestoneId: "M001",
    ctx: { ui: { notify: () => undefined } } as any,
    pi: { sendMessage: () => undefined } as any,
  });
}

describe("session_switch clears pending auto-start on conversation reset", () => {
  let base: string;
  const handlers = new Map<string, Function>();

  beforeEach(() => {
    clearPendingAutoStart();
    base = makeProjectDir();
    handlers.clear();
    registerHooks({ on(event: string, handler: Function) { handlers.set(event, handler); } } as any, []);
  });

  afterEach(() => {
    clearPendingAutoStart();
    rmSync(base, { recursive: true, force: true });
  });

  async function fireSessionSwitch(reason: "new" | "resume"): Promise<void> {
    const handler = handlers.get("session_switch");
    assert.ok(handler, "session_switch handler should be registered");
    try {
      await handler({ type: "session_switch", reason, previousSessionFile: undefined }, fakeCtx(base));
    } catch {
      // The handler also performs session plumbing (MCP prep, service tier
      // sync) that may throw against the minimal fake ctx. Pending auto-start
      // is cleared before that plumbing runs, so the assertions below remain
      // valid either way.
    }
  }

  it('reason "new" (/clear, /new) drops the entry even after CONTEXT was saved', async () => {
    armPendingAutoStart(base);
    assert.ok(_getPendingAutoStart(base), "entry should be armed");

    await fireSessionSwitch("new");

    assert.equal(
      _getPendingAutoStart(base),
      null,
      "a fresh conversation destroyed the interview — the handoff entry must not outlive it",
    );
  });

  it('reason "resume" keeps the entry (the interview transcript is restored)', async () => {
    armPendingAutoStart(base);

    await fireSessionSwitch("resume");

    assert.ok(
      _getPendingAutoStart(base),
      "resuming restores the interview — the in-flight handoff must survive",
    );
  });
});
