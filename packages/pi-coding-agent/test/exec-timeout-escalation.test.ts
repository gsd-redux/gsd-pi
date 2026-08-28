/**
 * execCommand timeout escalation. Regression test for the dead SIGKILL
 * escalation: `subprocess.killed` is true the moment kill() is called, so the
 * old escalation check never fired and a SIGTERM-immune child hung the
 * promise forever despite the caller passing `timeout`.
 */
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.js";

describe("execCommand timeout", () => {
	it("resolves normally for a fast command", async () => {
		const res = await execCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd());
		expect(res.code).toBe(0);
		expect(res.killed).toBe(false);
	});

	it("propagates the exit code", async () => {
		const res = await execCommand(process.execPath, ["-e", "process.exit(7)"], process.cwd());
		expect(res.code).toBe(7);
	});

	// A child that installs a no-op SIGTERM handler must still be SIGKILLed by
	// the escalation timer, so the promise settles shortly after the 5s grace.
	it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		const timeoutMs = 300;
		const started = Date.now();
		const res = await Promise.race([
			execCommand(
				process.execPath,
				["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);"],
				process.cwd(),
				{ timeout: timeoutMs },
			),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("execCommand never settled — SIGKILL escalation did not fire")), 15_000),
			),
		]);
		const elapsed = Date.now() - started;
		expect(res.killed).toBe(true);
		expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
		expect(elapsed).toBeLessThan(10_000);
	});
});
