/**
 * Moonshot-compatible MCP tool list schemas for Kimi Code and Moonshot API hosts.
 *
 * The MCP SDK converts Zod shapes to JSON Schema with anyOf for unions/nullable
 * fields. Moonshot rejects those patterns on tools.function.parameters.
 */

import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { sanitizeSchemaForMoonshot } from "./moonshot-schema-sanitizer.js";

const EMPTY_OBJECT_JSON_SCHEMA = { type: "object", properties: {} } as const;

type RegisteredTool = {
	enabled: boolean;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: unknown;
	execution?: unknown;
	_meta?: unknown;
};

type McpServerWithRegisteredTools = {
	server: {
		setRequestHandler: (schema: unknown, handler: () => unknown) => void;
	};
	_registeredTools: Record<string, RegisteredTool>;
};

export function toMoonshotCompatibleInputSchema(inputSchema: unknown): Record<string, unknown> {
	const inputObj = normalizeObjectSchema(inputSchema as Parameters<typeof normalizeObjectSchema>[0]);
	const rawInputSchema = inputObj
		? toJsonSchemaCompat(inputObj, {
				strictUnions: true,
				pipeStrategy: "input",
			})
		: EMPTY_OBJECT_JSON_SCHEMA;
	return sanitizeSchemaForMoonshot(rawInputSchema);
}

/**
 * Replace the MCP SDK ListTools handler so every advertised inputSchema is
 * flattened for Moonshot/Kimi grammar. Call after all tools are registered.
 */
export function installMoonshotCompatibleToolSchemas(mcpServer: McpServerWithRegisteredTools): void {
	mcpServer.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: Object.entries(mcpServer._registeredTools)
			.filter(([, tool]) => tool.enabled)
			.map(([name, tool]) => {
				const toolDefinition: Record<string, unknown> = {
					name,
					title: tool.title,
					description: tool.description,
					inputSchema: toMoonshotCompatibleInputSchema(tool.inputSchema),
					annotations: tool.annotations,
					execution: tool.execution,
					_meta: tool._meta,
				};

				if (tool.outputSchema) {
					const outputObj = normalizeObjectSchema(tool.outputSchema as Parameters<typeof normalizeObjectSchema>[0]);
					if (outputObj) {
						toolDefinition.outputSchema = sanitizeSchemaForMoonshot(
							toJsonSchemaCompat(outputObj, {
								strictUnions: true,
								pipeStrategy: "output",
							}),
						);
					}
				}

				return toolDefinition;
			}),
	}));
}
