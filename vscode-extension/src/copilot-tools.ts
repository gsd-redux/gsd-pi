// Project/App: gsd-pi
// File Purpose: Copilot Chat language model tools backed by the existing GSD RPC client.

import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";
import { assertActiveWorkspaceRoot, assertEmptyToolInput, awaitWithCancellation } from "./copilot-tools-guards.js";

interface EmptyToolInput {
	[key: string]: never;
}

function toJsonToolResult(value: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2)),
	]);
}

function assertEmptyInput(input: unknown): void {
	assertEmptyToolInput(input);
}

function assertWorkspaceRootMatchesClient(projectRoot: string): void {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	assertActiveWorkspaceRoot(projectRoot, workspaceFolders.map((folder) => folder.uri.fsPath));
}

function readConfirmationMessages(title: string, detail: string): vscode.LanguageModelToolConfirmationMessages {
	return {
		title,
		message: new vscode.MarkdownString(`${detail}\n\nThe result is read-only, but it will be sent to the active chat/model context.`),
	};
}

export class ProjectProgressTool implements vscode.LanguageModelTool<EmptyToolInput> {
	constructor(private readonly client: GsdClient) {}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: "Reading GSD project progress",
			confirmationMessages: readConfirmationMessages(
				"Read GSD project progress",
				"Read the current GSD project progress from the active workspace.",
			),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<EmptyToolInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		assertEmptyInput(options.input);
		assertWorkspaceRootMatchesClient(this.client.projectRoot);
		if (!this.client.isConnected) {
			throw new Error("GSD agent is not connected. Start the GSD agent, then retry the project progress read.");
		}
		return toJsonToolResult(await awaitWithCancellation(() => this.client.getProjectProgress(), token));
	}
}

export class ProjectSnapshotTool implements vscode.LanguageModelTool<EmptyToolInput> {
	constructor(private readonly client: GsdClient) {}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: "Reading GSD project snapshot",
			confirmationMessages: readConfirmationMessages(
				"Read GSD project snapshot",
				"Read the bounded GSD project snapshot from the active workspace.",
			),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<EmptyToolInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		assertEmptyInput(options.input);
		assertWorkspaceRootMatchesClient(this.client.projectRoot);
		if (!this.client.isConnected) {
			throw new Error("GSD agent is not connected. Start the GSD agent, then retry the project snapshot read.");
		}
		return toJsonToolResult(await awaitWithCancellation(() => this.client.getProjectSnapshot(), token));
	}
}

export function registerCopilotTools(context: vscode.ExtensionContext, client: GsdClient): void {
	if (typeof vscode.lm.registerTool !== "function") {
		return;
	}
	context.subscriptions.push(
		vscode.lm.registerTool("gsd_project_progress", new ProjectProgressTool(client)),
		vscode.lm.registerTool("gsd_project_snapshot", new ProjectSnapshotTool(client)),
	);
}
