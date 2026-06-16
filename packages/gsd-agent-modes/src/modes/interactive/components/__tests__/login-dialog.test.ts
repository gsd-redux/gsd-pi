import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	EditorKeybindingsManager,
	setEditorKeybindings,
	TUI,
	type Terminal,
} from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { buildAuthUrlPresentation, LoginDialogComponent } from "../login-dialog.js";

function makeTerminal(): Terminal {
	return {
		isTTY: true,
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	};
}

function plain(component: LoginDialogComponent): string {
	return component.render(80).join("\n").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("LoginDialogComponent", () => {
	test("shows the full OAuth URL when the hyperlink label is truncated", () => {
		const presentation = buildAuthUrlPresentation(
			"https://auth.example.com/device?code=ABCD-1234&callback=oauth&state=needs-full-visibility",
			52,
		);

		assert.notEqual(
			presentation.displayUrl,
			"https://auth.example.com/device?code=ABCD-1234&callback=oauth&state=needs-full-visibility",
			"narrow terminals should still truncate the hyperlink label",
		);
		assert.ok(presentation.fullUrlLines.length > 1, "truncated URLs should expose wrapped full-url lines");
		assert.match(presentation.fullUrlLines[0] ?? "", /https:\/\/auth\.example\.com\/device\?code=ABCD-1234&/);
		assert.match(
			presentation.fullUrlLines[presentation.fullUrlLines.length - 1] ?? "",
			/state=needs-full-visibility/,
		);
	});

	test("submits an empty prompt through the configured confirm binding", async () => {
		initTheme("dark", false);
		setEditorKeybindings(new EditorKeybindingsManager({ selectConfirm: "ctrl+s" }));

		try {
			const dialog = new LoginDialogComponent(new TUI(makeTerminal()), "github-copilot", () => {}, undefined, {
				openUrl: () => {},
			});
			const result = dialog.showPrompt("GitHub Enterprise URL/domain (blank for github.com)", "company.ghe.com", {
				allowEmpty: true,
			});

			dialog.handleInput("\x13");

			assert.equal(await result, "");
		} finally {
			setEditorKeybindings(new EditorKeybindingsManager());
		}
	});

	test("renders device-code login details and opens the verification URL", () => {
		initTheme("dark", false);
		let openedUrl: string | undefined;
		const dialog = new LoginDialogComponent(new TUI(makeTerminal()), "github-copilot", () => {}, undefined, {
			openUrl: (url) => {
				openedUrl = url;
			},
		});

		dialog.showDeviceCode({
			userCode: "ABCD-EFGH",
			verificationUri: "https://github.com/login/device",
			expiresInSeconds: 900,
		});

		const output = plain(dialog);
		assert.match(output, /Enter this code:/);
		assert.match(output, /ABCD-EFGH/);
		assert.match(output, /https:\/\/github\.com\/login\/device/);
		assert.match(output, /Code expires in 15 minutes/);
		assert.equal(openedUrl, "https://github.com/login/device");
	});
});
