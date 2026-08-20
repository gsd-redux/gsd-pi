import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { CURSOR_AGENT_MODELS, resolveCursorAgentModels, type CursorAgentModel } from "./models.js";
import { isCursorAgentReady, readCursorAgentListModels } from "./readiness.js";
import { streamViaCursorAgent } from "./stream-adapter.js";

const PROVIDER_ID = "cursor-agent";

function registerCursorProvider(pi: ExtensionAPI, models: CursorAgentModel[]): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Cursor Agent",
		authMode: "externalCli",
		api: "cursor-stream-json",
		baseUrl: "local://cursor-agent",
		isReady: isCursorAgentReady,
		streamSimple: streamViaCursorAgent,
		models,
	});
}

export function probeAndRegisterCursorModels(
	pi: ExtensionAPI,
	readList: () => string | null = readCursorAgentListModels,
): CursorAgentModel[] {
	const models = resolveCursorAgentModels(readList());
	try {
		pi.unregisterProvider(PROVIDER_ID);
	} catch {
		// First registration has nothing to replace.
	}
	registerCursorProvider(pi, models);
	return models;
}

export default function cursorCli(pi: ExtensionAPI): void {
	if (process.env.GSD_CURSOR_DISABLE === "1") return;

	registerCursorProvider(pi, CURSOR_AGENT_MODELS);

	pi.on("session_start", () => {
		probeAndRegisterCursorModels(pi);
	});
}
