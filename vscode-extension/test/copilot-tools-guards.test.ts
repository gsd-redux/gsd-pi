// Project/App: gsd-pi
// File Purpose: Behavioral tests for the Copilot Chat tool invocation guards
// (input validation, workspace-root matching, cancellation ordering).

import test from "node:test";
import assert from "node:assert/strict";
import {
	assertActiveWorkspaceRoot,
	assertEmptyToolInput,
	awaitWithCancellation,
	type CancellationSignal,
} from "../src/copilot-tools-guards.ts";

function makeToken(initiallyCancelled = false): CancellationSignal & { cancel(): void } {
	let cancelled = initiallyCancelled;
	let listener: (() => void) | undefined;
	return {
		get isCancellationRequested() {
			return cancelled;
		},
		onCancellationRequested(cb) {
			listener = cb;
			return { dispose: () => { listener = undefined; } };
		},
		cancel() {
			cancelled = true;
			listener?.();
		},
	};
}

test("assertEmptyToolInput accepts undefined and empty object", () => {
	assert.doesNotThrow(() => assertEmptyToolInput(undefined));
	assert.doesNotThrow(() => assertEmptyToolInput({}));
});

test("assertEmptyToolInput rejects null, arrays, non-empty objects, and primitives", () => {
	assert.throws(() => assertEmptyToolInput(null));
	assert.throws(() => assertEmptyToolInput([]));
	assert.throws(() => assertEmptyToolInput({ a: 1 }));
	assert.throws(() => assertEmptyToolInput("unexpected"));
});

test("assertActiveWorkspaceRoot rejects zero or multiple workspace folders", () => {
	assert.throws(
		() => assertActiveWorkspaceRoot("/project", []),
		/exactly one workspace folder/,
	);
	assert.throws(
		() => assertActiveWorkspaceRoot("/project", ["/project", "/other"]),
		/exactly one workspace folder/,
	);
});

test("assertActiveWorkspaceRoot rejects a mismatched single workspace folder", () => {
	assert.throws(
		() => assertActiveWorkspaceRoot("/project", ["/other"]),
		/must match the connected GSD agent project|active workspace folder to match/,
	);
});

test("assertActiveWorkspaceRoot accepts a matching workspace folder, resolving path differences", () => {
	assert.doesNotThrow(() => assertActiveWorkspaceRoot("/project", ["/project/"]));
	assert.doesNotThrow(() => assertActiveWorkspaceRoot("/project/sub/..", ["/project"]));
});

test("awaitWithCancellation never invokes a lazy operation when already cancelled", async () => {
	const token = makeToken(true);
	let invocations = 0;
	const operation = () => {
		invocations += 1;
		return Promise.resolve("unused");
	};

	await assert.rejects(() => awaitWithCancellation(operation, token), /cancelled/);
	assert.equal(invocations, 0);
});

test("awaitWithCancellation invokes the operation exactly once and resolves normally", async () => {
	const token = makeToken(false);
	let invocations = 0;
	const operation = async () => {
		invocations += 1;
		return "ok";
	};

	const result = await awaitWithCancellation(operation, token);
	assert.equal(result, "ok");
	assert.equal(invocations, 1);
});

test("awaitWithCancellation rejects on mid-flight cancellation without an unhandled rejection", async () => {
	const token = makeToken(false);
	let rejectOperation: (err: Error) => void = () => {};
	const operation = () => new Promise<string>((_resolve, reject) => {
		rejectOperation = reject;
	});

	const pending = awaitWithCancellation(operation, token);
	token.cancel();
	await assert.rejects(() => pending, /cancelled/);

	// The underlying RPC promise rejecting *after* cancellation already
	// settled the outer promise must not produce an unhandled rejection.
	rejectOperation(new Error("late rpc failure"));
});
