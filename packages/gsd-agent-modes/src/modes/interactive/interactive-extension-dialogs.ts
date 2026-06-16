// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).
// @ts-nocheck

import type { KeyId } from "@gsd/pi-tui";
import { Container, matchesKey, Spacer, Text, type Component, type TUI } from "@gsd/pi-tui";
import type { ExtensionContext, ExtensionRunner, ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions } from "@gsd/pi-coding-agent/core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { setRegisteredThemes, setTheme, Theme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { appKey } from "./components/keybinding-hints.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import type { ExtensionNotifyType } from "./interactive-notify-render.js";
import { renderBlockingErrorBanner, renderExtensionNotifyInChat } from "./interactive-notify-render.js";
import { createExtensionUIContext as buildExtensionUIContext } from "./controllers/extension-ui-controller.js";
import { MAX_WIDGET_LINES } from "./interactive-mode-class-constants.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";
import { getEditorTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { EditorComponent, EditorTheme, KeybindingsManager, OverlayHandle, OverlayOptions } from "@gsd/pi-tui";

export function createExtensionUIContext(host: InteractiveModeDelegateHost): ExtensionUIContext {
		return buildExtensionUIContext(host);
	}

	/**
	 * Show a selector for extensions.
	 */
export function showExtensionSelector(
	host: InteractiveModeDelegateHost,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
		// If a previous selector is still active, dispose it before creating a
		// new one.  This avoids leaking the previous promise and DOM state when
		// showExtensionSelector is called rapidly.
		if (host.extensionSelector) {
			hideExtensionSelector(host, );
		}

		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				hideExtensionSelector(host, );
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			host.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					hideExtensionSelector(host, );
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					hideExtensionSelector(host, );
					resolve(undefined);
				},
				{ tui: host.ui, timeout: opts?.timeout },
			);

			host.editorContainer.clear();
			host.editorContainer.addChild(host.extensionSelector);
			host.ui.setFocus(host.extensionSelector);
			host.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
export function hideExtensionSelector(host: InteractiveModeDelegateHost): void {
		host.extensionSelector?.dispose();
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.extensionSelector = undefined;
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
export async function showExtensionConfirm(host: InteractiveModeDelegateHost, 
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await host.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/**
	 * Show a text input for extensions.
	 */
export function showExtensionInput(host: InteractiveModeDelegateHost, 
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				hideExtensionInput(host, );
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			host.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					hideExtensionInput(host, );
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					hideExtensionInput(host, );
					resolve(undefined);
				},
				{ tui: host.ui, timeout: opts?.timeout, secure: opts?.secure },
			);

			host.editorContainer.clear();
			host.editorContainer.addChild(host.extensionInput);
			host.ui.setFocus(host.extensionInput);
			host.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
export function hideExtensionInput(host: InteractiveModeDelegateHost): void {
		host.extensionInput?.dispose();
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.extensionInput = undefined;
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
export function showExtensionEditor(host: InteractiveModeDelegateHost, title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			host.extensionEditor = new ExtensionEditorComponent(
				host.ui,
				host.keybindings,
				title,
				prefill,
				(value) => {
					hideExtensionEditor(host, );
					resolve(value);
				},
				() => {
					hideExtensionEditor(host, );
					resolve(undefined);
				},
			);

			host.editorContainer.clear();
			host.editorContainer.addChild(host.extensionEditor);
			host.ui.setFocus(host.extensionEditor);
			host.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
export function hideExtensionEditor(host: InteractiveModeDelegateHost): void {
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.extensionEditor = undefined;
		host.ui.setFocus(host.editor);
		host.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
export function setCustomEditorComponent(
	host: InteractiveModeDelegateHost,
	factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
): void {
		// Save text from current editor before switching
		const currentText = host.editor.getText();

		host.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(host.ui, getEditorTheme(), host.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = host.defaultEditor.onSubmit;
			newEditor.onChange = host.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = host.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(host.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && host.autocompleteProvider) {
				newEditor.setAutocompleteProvider(host.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => host.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => host.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => host.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => host.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of host.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			host.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			host.defaultEditor.setText(currentText);
			host.editor = host.defaultEditor;
		}

		// Ensure pasted image path handler is set on the active editor
		if (!host.editor.onPasteImagePath) {
			host.editor.onPasteImagePath = (filePath: string) => {
				host.handlePastedImagePath(filePath);
			};
		}

		host.editorContainer.addChild(host.editor as Component);
		host.ui.setFocus(host.editor as Component);
		host.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
export function showExtensionNotify(host: InteractiveModeDelegateHost, message: string, type?: ExtensionNotifyType): void {
		if (type === "error") {
			host.lastBlockingError = message;
			renderBlockingErrorBanner(host.blockingErrorContainer, host.lastBlockingError);
			host.ui.requestRender();
			return;
		}
		const result = renderExtensionNotifyInChat(host.chatContainer, message, type);
		if (!result.rendered) {
			// Warnings are intentionally excluded from the dim status-card path
			// but must still be visible — route them through the warning renderer.
			if (type === "warning") {
				host.showWarning(message);
			}
			return;
		}
		if (result.statusSpacer && result.statusText) {
			host.lastStatusSpacer = result.statusSpacer;
			host.lastStatusText = result.statusText;
		}
		host.ui.requestRender();
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
export async function showExtensionCustom<T>(
	host: InteractiveModeDelegateHost,
	factory: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	options?: {
		overlay?: boolean;
		overlayOptions?: OverlayOptions | (() => OverlayOptions);
		onHandle?: (handle: OverlayHandle) => void;
	},
): Promise<T> {
		const savedText = host.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			host.editorContainer.clear();
			host.editorContainer.addChild(host.editor);
			host.editor.setText(savedText);
			host.ui.setFocus(host.editor);
			host.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) host.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(host.ui, theme, host.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = host.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						host.editorContainer.clear();
						host.editorContainer.addChild(component);
						host.ui.setFocus(component);
						host.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
export function showExtensionError(host: InteractiveModeDelegateHost, extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		host.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				host.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		host.ui.requestRender();
	}
