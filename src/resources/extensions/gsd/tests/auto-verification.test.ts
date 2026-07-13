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
