import assert from "node:assert/strict";
import test from "node:test";
import { invokeProjectProgressRead } from "./rpc-mode.js";

test("project progress read forwards the active session CWD and request ID", async () => {
	let receivedInput: unknown;
	const response = await invokeProjectProgressRead(
		async (input) => {
			receivedInput = input;
			return { phase: "execute" };
		},
		"request-123",
		"/workspace/project",
	);

	assert.deepEqual(receivedInput, { cwd: "/workspace/project" });
	assert.deepEqual(response, {
		id: "request-123",
		type: "response",
		command: "get_project_progress",
		success: true,
		data: { phase: "execute" },
	});
});

test("project progress read preserves provenance metadata", async () => {
	const response = await invokeProjectProgressRead(
		async () => ({
			phase: "execute",
			readMetadata: { source: "database", authority: "db-authoritative" },
		}),
		"request-789",
		"/workspace/project",
	);

	assert.deepEqual(response, {
		id: "request-789",
		type: "response",
		command: "get_project_progress",
		success: true,
		data: {
			phase: "execute",
			readMetadata: { source: "database", authority: "db-authoritative" },
		},
	});
});

test("project progress read remains valid when an older producer omits readMetadata", async () => {
	const response = await invokeProjectProgressRead(
		async () => ({ phase: "execute" }),
		"request-999",
		"/workspace/project",
	);

	assert.equal(response.success, true);
	assert.deepEqual(response.data, { phase: "execute" });
	assert.equal((response.data as { readMetadata?: unknown }).readMetadata, undefined);
});

test("project progress reader failures preserve the request ID", async () => {
	const response = await invokeProjectProgressRead(
		async () => {
			throw new Error("database unavailable");
		},
		"request-456",
		"/workspace/project",
	);

	assert.deepEqual(response, {
		id: "request-456",
		type: "response",
		command: "get_project_progress",
		success: false,
		error: "database unavailable",
	});
});