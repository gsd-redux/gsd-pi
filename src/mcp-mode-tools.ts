import type { McpToolDef } from "./mcp-server.js";

export type WorkflowMcpAdapterToolLoader = () => Promise<McpToolDef[]>;

async function loadWorkflowMcpAdapterTools(): Promise<McpToolDef[]> {
	const { createWorkflowMcpAdapterToolDefs } = await import("@opengsd/mcp-server");
	return createWorkflowMcpAdapterToolDefs();
}

export function mergeMcpModeTools(
	baseTools: readonly McpToolDef[],
	adapterTools: readonly McpToolDef[],
): McpToolDef[] {
	const merged = [...baseTools];
	const seen = new Set(merged.map((tool) => tool.name));
	for (const tool of adapterTools) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		merged.push(tool);
	}
	return merged;
}

export async function buildMcpModeTools(
	baseTools: readonly McpToolDef[],
	loadAdapterTools: WorkflowMcpAdapterToolLoader = loadWorkflowMcpAdapterTools,
): Promise<McpToolDef[]> {
	return mergeMcpModeTools(baseTools, await loadAdapterTools());
}
