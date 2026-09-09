// Project/App: gsd-pi
// File Purpose: Pure, vscode-import-free guards for the Copilot Chat language
// model tools in copilot-tools.ts, so their invocation contract is
// unit-testable outside the Extension Development Host.

import { resolve } from "node:path";

/** Structural subset of vscode.CancellationToken actually needed here. */
export interface CancellationSignal {
	isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export function assertEmptyToolInput(input: unknown): void {
	if (input === undefined) return;
	if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
		throw new Error("GSD project read tools do not accept input parameters. They use the active workspace project.");
	}
}

export function assertActiveWorkspaceRoot(projectRoot: string, workspaceFolderPaths: readonly string[]): void {
	if (workspaceFolderPaths.length !== 1) {
		throw new Error("GSD project read tools require exactly one workspace folder. Open the target project in its own VS Code window.");
	}
	const activeRoot = resolve(workspaceFolderPaths[0]);
	const clientRoot = resolve(projectRoot);
	if (activeRoot !== clientRoot) {
		throw new Error("GSD project read tools require the active workspace folder to match the connected GSD agent project. Restart the GSD agent for this workspace, then retry.");
	}
}

/**
 * Runs `operation` only after confirming the token was not already
 * cancelled, so an already-cancelled invocation never sends the underlying
 * request. `operation` is lazy (a thunk) precisely to keep that ordering.
 */
export async function awaitWithCancellation<T>(operation: () => Promise<T>, token: CancellationSignal): Promise<T> {
	if (token.isCancellationRequested) {
		throw new Error("GSD project read was cancelled.");
	}

	return await new Promise<T>((resolve, reject) => {
		const cancellation = token.onCancellationRequested(() => reject(new Error("GSD project read was cancelled.")));
		operation().then(resolve, reject).finally(() => cancellation.dispose());
	});
}
