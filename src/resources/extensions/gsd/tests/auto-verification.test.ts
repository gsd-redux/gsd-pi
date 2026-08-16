import assert from "node:assert/strict";
import test from "node:test";
import {
	_routeHostTechnicalFailureForTest,
	runPostUnitVerification,
} from "../auto-verification.ts";

function createVerificationContext(currentUnit: { type: string; id: string } | null) {
	return {
		s: {
			currentUnit,
		},
		ctx: {
			ui: {
				notify() {
					throw new Error("notify should not be called for pass-through units");
				},
			},
		},
		pi: {},
	};
}

test("post-unit verification continues when no host-owned verification is needed", async () => {
	let paused = false;
	const pauseAuto = async () => {
		paused = true;
	};

	assert.equal(await runPostUnitVerification(createVerificationContext(null) as never, pauseAuto), "continue");
	assert.equal(
		await runPostUnitVerification(
			createVerificationContext({ type: "plan-slice", id: "M001-S001" }) as never,
			pauseAuto,
		),
		"continue",
	);
	assert.equal(paused, false);
});

test("built-in verification retries a replayed authorized abort", () => {
	const outcome = _routeHostTechnicalFailureForTest({
		routeTaskFailure: () => ({
			action: "abort",
			status: "replayed",
			resumeAuthorized: true,
		}),
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
	});

	assert.equal(outcome, "retry");
});

test("terminal abort surfaces its recoveryActionId to the caller (#1593)", () => {
	const surfaced: string[] = [];
	const outcome = _routeHostTechnicalFailureForTest({
		routeTaskFailure: () => ({
			action: "abort",
			status: "applied",
			resumeAuthorized: false,
			recoveryActionId: "8f1d0c2e-6a44-4b19-9e77-2c3d5f0a1b62",
		}),
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
	}, "verification-failed", (id) => surfaced.push(id));

	assert.equal(outcome, "abort");
	assert.deepEqual(surfaced, ["8f1d0c2e-6a44-4b19-9e77-2c3d5f0a1b62"]);
});

test("a replayed authorized abort does not surface a recoveryActionId (#1593)", () => {
	const surfaced: string[] = [];
	const outcome = _routeHostTechnicalFailureForTest({
		routeTaskFailure: () => ({
			action: "abort",
			status: "replayed",
			resumeAuthorized: true,
			recoveryActionId: "8f1d0c2e-6a44-4b19-9e77-2c3d5f0a1b62",
		}),
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
	}, "verification-failed", (id) => surfaced.push(id));

	assert.equal(outcome, "retry");
	assert.deepEqual(surfaced, []);
});
