import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
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

test("sanitizeSchemaForMoonshot does not require fields from every object union variant", () => {
	const sanitized = sanitizeSchemaForMoonshot({
		type: "object",
		properties: {
			selection: {
				anyOf: [
					{ type: "object", properties: { milestone: { type: "string" } }, required: ["milestone"] },
					{ type: "object", properties: { project: { type: "string" } }, required: ["project"] },
				],
			},
		},
	});

	assert.deepEqual((sanitized.properties as Record<string, unknown>).selection, {
		type: "object",
		properties: {
			milestone: { type: "string" },
			project: { type: "string" },
		},
	});
});

test("createMcpServer advertises Moonshot-safe inputSchema for every tool", async (t) => {
	const sm = new SessionManager();
	const bridgePath = fileURLToPath(new URL("../test-fixtures/workflow-bridge.mjs", import.meta.url));
	// Plan 035 suppresses alias schemas by default; opt into the broad surface
	// so this test verifies every tool (canonical AND alias) is Moonshot-safe.
	const previousAdvertise = process.env.GSD_MCP_ADVERTISE_ALIASES;
	const previousHide = process.env.GSD_MCP_HIDE_ALIASES;
	const previousExecutorsModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
	const previousWriteGateModule = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
	t.after(async () => {
		if (previousAdvertise === undefined) delete process.env.GSD_MCP_ADVERTISE_ALIASES;
		else process.env.GSD_MCP_ADVERTISE_ALIASES = previousAdvertise;
		if (previousHide === undefined) delete process.env.GSD_MCP_HIDE_ALIASES;
		else process.env.GSD_MCP_HIDE_ALIASES = previousHide;
		if (previousExecutorsModule === undefined) delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
		else process.env.GSD_WORKFLOW_EXECUTORS_MODULE = previousExecutorsModule;
		if (previousWriteGateModule === undefined) delete process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
		else process.env.GSD_WORKFLOW_WRITE_GATE_MODULE = previousWriteGateModule;
		await sm.cleanup();
	});
	process.env.GSD_MCP_ADVERTISE_ALIASES = "1";
	delete process.env.GSD_MCP_HIDE_ALIASES;
	process.env.GSD_WORKFLOW_EXECUTORS_MODULE = bridgePath;
	process.env.GSD_WORKFLOW_WRITE_GATE_MODULE = bridgePath;
	const { server } = await createMcpServer(sm, { includeWorkflowTools: true });
	const mcpServer = server as unknown as McpServer;
	mcpServer.registerTool(
		"moonshot_union_probe",
		{
			description: "Exercise Moonshot schema sanitization through the advertised MCP surface.",
			inputSchema: {
				keyFiles: z.union([z.array(z.string()), z.string()]),
				mode: z.union([z.literal("build"), z.literal("query")]),
			},
		},
		async () => ({ content: [{ type: "text", text: "ok" }] }),
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "moonshot-tool-schema-test", version: "1.0.0" });
	t.after(async () => {
		await client.close();
		await server.close();
	});
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	const probe = tools.find((tool) => tool.name === "moonshot_union_probe");
	assert.ok(probe, "Moonshot compatibility probe must be advertised");
	const probeProperties = probe.inputSchema.properties;
	assert.ok(probeProperties, "Moonshot compatibility probe must advertise properties");
	assert.deepEqual(probeProperties.keyFiles, {
		type: "array",
		items: { type: "string" },
	});
	assert.deepEqual(probeProperties.mode, {
		type: "string",
		enum: ["build", "query"],
	});

	for (const tool of tools) {
		assert.equal(tool.inputSchema.type, "object", `${tool.name}: root type must be object`);
		assert.deepEqual(
			collectForbiddenUnionSchemaPaths(tool.inputSchema),
			[],
			`${tool.name}: Moonshot schema must not contain anyOf/oneOf/allOf`,
		);
	}

	assert.ok(tools.length >= 50, `expected broad MCP tool surface, got ${tools.length}`);
});
