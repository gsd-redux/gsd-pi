import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { sanitizeSchemaForMoonshot } from "./moonshot-schema-sanitizer.js";
import { SessionManager } from "./session-manager.js";
import { createMcpServer } from "./server.js";

function collectForbiddenUnionSchemaPaths(value: unknown, path = "$"): string[] {
	if (value === null || typeof value !== "object") return [];
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => collectForbiddenUnionSchemaPaths(item, `${path}[${index}]`));
	}

	const violations: string[] = [];
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (key === "anyOf" || key === "oneOf" || key === "allOf") violations.push(`${path}.${key}`);
		violations.push(...collectForbiddenUnionSchemaPaths(nested, `${path}.${key}`));
	}
	return violations;
}

test("sanitizeSchemaForMoonshot flattens zod union workflow fields", () => {
	const schema = z.object({
		milestoneId: z.string(),
		keyFiles: z.union([z.array(z.string()), z.string()]).optional(),
		mode: z.union([z.literal("build"), z.literal("query")]),
	});

	const raw = toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: "input" });
	assert.ok(JSON.stringify(raw).includes("anyOf"), "zod unions should produce anyOf before sanitization");

	const sanitized = sanitizeSchemaForMoonshot(raw);
	assert.equal(sanitized.type, "object");
	assert.deepEqual(collectForbiddenUnionSchemaPaths(sanitized), []);
	const keyFilesSchema = (sanitized.properties as Record<string, unknown>).keyFiles;
	assert.deepEqual(keyFilesSchema, { type: "array", items: { type: "string" } });
	const modeSchema = (sanitized.properties as Record<string, unknown>).mode;
	assert.deepEqual(modeSchema, { type: "string", enum: ["build", "query"] });
});

test("createMcpServer advertises Moonshot-safe inputSchema for every tool", async () => {
	const sm = new SessionManager();
	// Plan 035 suppresses alias schemas by default; opt into the broad surface
	// so this test verifies every tool (canonical AND alias) is Moonshot-safe.
	const previousAdvertise = process.env.GSD_MCP_ADVERTISE_ALIASES;
	const previousHide = process.env.GSD_MCP_HIDE_ALIASES;
	process.env.GSD_MCP_ADVERTISE_ALIASES = "1";
	delete process.env.GSD_MCP_HIDE_ALIASES;
	const { server } = await createMcpServer(sm, { includeWorkflowTools: true }).finally(() => {
		if (previousAdvertise === undefined) delete process.env.GSD_MCP_ADVERTISE_ALIASES;
		else process.env.GSD_MCP_ADVERTISE_ALIASES = previousAdvertise;
		if (previousHide === undefined) delete process.env.GSD_MCP_HIDE_ALIASES;
		else process.env.GSD_MCP_HIDE_ALIASES = previousHide;
	});

	const registeredTools =
		(server as { _registeredTools?: Record<string, { enabled: boolean; inputSchema?: unknown }> })._registeredTools ??
		{};
	let toolCount = 0;

	for (const [name, tool] of Object.entries(registeredTools)) {
		if (!tool.enabled) continue;
		toolCount += 1;

		const obj = normalizeObjectSchema(tool.inputSchema as Parameters<typeof normalizeObjectSchema>[0]);
		const raw = obj
			? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: "input" })
			: { type: "object", properties: {} };
		const sanitized = sanitizeSchemaForMoonshot(raw);

		assert.equal(sanitized.type, "object", `${name}: root type must be object`);
		assert.deepEqual(
			collectForbiddenUnionSchemaPaths(sanitized),
			[],
			`${name}: Moonshot schema must not contain anyOf/oneOf/allOf`,
		);
	}

	assert.ok(toolCount >= 50, `expected broad MCP tool surface, got ${toolCount}`);
});
