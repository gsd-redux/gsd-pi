import assert from "node:assert/strict";
import test from "node:test";
import {
	_resolveVerificationTimeoutMsForTest,
	_routeHostTechnicalFailureForTest,
	runPostUnitVerification,
} from "../auto-verification.ts";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../constants.ts";
import { describeHostVerificationRationale } from "../verification-verdict.ts";

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

test("routed fail rationale names the check, observed vs expected, and evidence (#1747)", () => {
	let routedRationale = "";
	_routeHostTechnicalFailureForTest({
		routeTaskFailure: (input: { rationale: string }) => {
			routedRationale = input.rationale;
			return { action: "retry", status: "applied", resumeAuthorized: false };
		},
	} as never, {
		attemptId: "attempt-1",
		resultId: "result-1",
	} as never, {
		verdictId: "verdict-1",
		evidenceId: "evidence-1",
		verdict: "fail",
		rationale: describeHostVerificationRationale({
			verdict: "fail",
			checkName: "just check-ci",
			observed: "timeout after 120000ms (exit 124)",
			expected: "exit 0 / pass",
			evidenceRef: "db://host-verification/attempt-1 (verdict verdict-1)",
			nextAction: "Raise verification_timeout_ms if this command is expected to run longer.",
		}),
	});
	assert.match(routedRationale, /just check-ci/);
	assert.match(routedRationale, /timeout after 120000ms/);
	assert.match(routedRationale, /exit 0 \/ pass/);
	assert.match(routedRationale, /evidence-1|verdict-1/);
	assert.doesNotMatch(routedRationale, /Route built-in host verification through the durable recovery policy/);
	assert.doesNotMatch(routedRationale, /Built-in host verification did not pass/);
});

test("inconclusive rationale states what would make it conclusive (#1747)", () => {
	const rationale = describeHostVerificationRationale({
		verdict: "inconclusive",
		checkName: "gsd-source-integrity",
		observed: "current source sha256:bbb",
		expected: "stored passing source sha256:aaa",
		evidenceRef: "db://host-verification/attempt-1/source-drift",
		nextAction: "To become conclusive, re-run host verification against the current source, or restore the stored revision.",
	});
	assert.match(rationale, /inconclusive/);
	assert.match(rationale, /gsd-source-integrity/);
	assert.match(rationale, /To become conclusive/);
});

test("verification_timeout_ms unset stays 120s; set value is enforced (#1759)", () => {
	assert.equal(_resolveVerificationTimeoutMsForTest(undefined), DEFAULT_COMMAND_TIMEOUT_MS);
	assert.equal(_resolveVerificationTimeoutMsForTest({}), DEFAULT_COMMAND_TIMEOUT_MS);
	assert.equal(_resolveVerificationTimeoutMsForTest({ verification_timeout_ms: 2500 }), 2500);
});
