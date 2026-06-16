// GSD Login Dialog Component — OAuth login flow UI
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
import type { OAuthDeviceCodeInfo } from "@gsd/pi-ai";
import { getOAuthProviders } from "@gsd/pi-ai/oauth";
import { Container, type Focusable, getEditorKeybindings, Input, Spacer, Text, truncateToWidth, type TUI } from "@gsd/pi-tui";
import { execFile } from "child_process";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

function wrapPlainText(text: string, width: number): string[] {
	const lines: string[] = [];
	const safeWidth = Math.max(1, width);
	for (let idx = 0; idx < text.length; idx += safeWidth) {
		lines.push(text.slice(idx, idx + safeWidth));
	}
	return lines.length > 0 ? lines : [""];
}

export function buildAuthUrlPresentation(url: string, terminalColumns: number): {
	displayUrl: string;
	fullUrlLines: string[];
} {
	const maxUrlWidth = Math.max(20, terminalColumns - 4);
	const displayUrl = truncateToWidth(url, maxUrlWidth);
	return {
		displayUrl,
		fullUrlLines: displayUrl === url ? [] : wrapPlainText(url, maxUrlWidth),
	};
}

function openExternalUrl(url: string): void {
	// PowerShell's Start-Process handles URLs with '&' safely; cmd /c start does not.
	if (process.platform === "win32") {
		execFile("powershell", ["-c", `Start-Process '${url.replace(/'/g, "''")}'`], () => {});
		return;
	}

	const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
	execFile(openCmd, [url], () => {});
}

/**
 * Login dialog component - replaces editor during OAuth login flow.
 *
 * Guards against stuck UI by:
 * - Rejecting any outstanding promise before creating a new one
 * - Listening on the internal AbortSignal so external cancellation cleans up
 * - Exposing a public dispose() method so the caller can force-cleanup
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private disposed = false;
	private openUrl: (url: string) => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
		providerDisplayName?: string,
		options?: { openUrl?: (url: string) => void },
	) {
		super();
		this.tui = tui;
		this.openUrl = options?.openUrl ?? openExternalUrl;

		const providerInfo = getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerDisplayName || providerInfo?.name || providerId;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("warning", `Login to ${providerName}`), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			this.submitInput();
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());

		// Wire abort signal so external cancellation rejects pending promises
		this.abortController.signal.addEventListener("abort", () => {
			this.rejectPending("Login cancelled");
		});
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/**
	 * Reject any outstanding input promise without triggering a full cancel.
	 * Safe to call multiple times.
	 */
	private rejectPending(reason: string): void {
		if (this.inputRejecter) {
			const rejecter = this.inputRejecter;
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
			rejecter(new Error(reason));
		}
	}

	private submitInput(): void {
		if (!this.inputResolver) return;
		const resolver = this.inputResolver;
		this.inputResolver = undefined;
		this.inputRejecter = undefined;
		resolver(this.input.getValue());
	}

	private cancel(): void {
		if (this.disposed) return;
		this.abortController.abort();
		// rejectPending is also called by the abort listener, but guard with
		// disposed flag and nulling to avoid double-reject
		this.rejectPending("Login cancelled");
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Force-dispose the dialog, rejecting any pending promises.
	 * Called by the parent when restoring the editor, as a safety net
	 * to ensure no promises are left dangling.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController.abort();
		this.rejectPending("Login dialog disposed");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));

		// Truncate the visible URL text so it never wraps (which would break
		// the OSC 8 hyperlink). The full URL is still the link target.
		const { displayUrl, fullUrlLines } = buildAuthUrlPresentation(url, this.tui.terminal.columns);
		const urlLink = `\x1b]8;;${url}\x07${theme.fg("accent", displayUrl)}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(urlLink, 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.contentContainer.addChild(new Text(theme.fg("dim", clickHint), 1, 0));

		if (fullUrlLines.length > 0) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("dim", "Full URL:"), 1, 0));
			for (const line of fullUrlLines) {
				this.contentContainer.addChild(new Text(theme.fg("dim", line), 1, 0));
			}
		}

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		this.openUrl(url);

		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show device code and verification URL.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", "Enter this code:"), 1, 0));
		this.contentContainer.addChild(new Text(theme.fg("accent", info.userCode), 1, 0));
		this.contentContainer.addChild(new Spacer(1));

		const { displayUrl, fullUrlLines } = buildAuthUrlPresentation(info.verificationUri, this.tui.terminal.columns);
		const urlLink = `\x1b]8;;${info.verificationUri}\x07${theme.fg("accent", displayUrl)}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(urlLink, 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.contentContainer.addChild(new Text(theme.fg("dim", clickHint), 1, 0));

		if (fullUrlLines.length > 0) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("dim", "Full URL:"), 1, 0));
			for (const line of fullUrlLines) {
				this.contentContainer.addChild(new Text(theme.fg("dim", line), 1, 0));
			}
		}

		if (info.expiresInSeconds) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("dim", `Code expires in ${Math.ceil(info.expiresInSeconds / 60)} minutes.`), 1, 0),
			);
		}

		this.openUrl(info.verificationUri);
		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		// Reject any previous pending promise before creating a new one
		this.rejectPending("Superseded by new input prompt");

		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("selectCancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string, options?: { allowEmpty?: boolean }): Promise<string> {
		// Reject any previous pending promise before creating a new one
		this.rejectPending("Superseded by new input prompt");

		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("selectCancel", "to cancel,")} ${keyHint(
					"selectConfirm",
					options?.allowEmpty ? "to submit blank" : "to submit",
				)})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("selectCancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;

		const kb = getEditorKeybindings();

		if (kb.matches(data, "selectCancel")) {
			this.cancel();
			return;
		}

		if (kb.matches(data, "selectConfirm")) {
			this.submitInput();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
