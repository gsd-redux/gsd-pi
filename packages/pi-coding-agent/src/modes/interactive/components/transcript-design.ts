// Project/App: GSD-2
// File Purpose: Shared recommended transcript rendering primitives for assistant, tool, command, footer, and auto-mode TUI surfaces.

import { style, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme, type ThemeBg, type ThemeColor } from "../theme/theme.js";
import { formatTimestamp, type TimestampFormat } from "./timestamp.js";
import { alignRight, roundedPanel } from "./tui-style-kit.js";

export type StatusTone = "running" | "success" | "error" | "warning" | "muted";

/** Conversation/system surfaces that the chat frame distinguishes by color. */
export type FrameTone = "assistant" | "user" | "compaction" | "skill";

export function chatMessageWidth(width: number): number {
	return Math.max(24, Math.min(width, Math.floor(width * 0.72)));
}

function trimOuterBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim().length === 0) start++;
	while (end > start && lines[end - 1].trim().length === 0) end--;
	return lines.slice(start, end);
}

function toneColor(tone: StatusTone): ThemeColor {
	switch (tone) {
		case "running": return "toolRunning";
		case "success": return "border";
		case "error": return "toolError";
		case "warning": return "warning";
		case "muted":
		default: return "toolMuted";
	}
}

export function rightAlign(left: string, right: string, width: number): string {
	return alignRight(left, right, width);
}

/**
 * Render a copy-clean content surface (ADR 0001): a titled top rule, body
 * lines emitted with no border column or leading glyph, and a closing rule.
 * Selecting a body line in the terminal copies only its content.
 *
 * This is the target surface for transcript messages, tool output, and
 * summaries. Migration steps 3–5 move existing renderers onto it.
 */
export function openSurface(
	lines: string[],
	width: number,
	opts: { title: string; right?: string; tone: StatusTone; paddingX?: number },
): string[] {
	const tc = toneColor(opts.tone);
	let surface = style()
		.border("open")
		.title(opts.title, (text) => theme.fg("borderAccent", text))
		.borderColor((text) => theme.fg(tc, text));
	if (opts.right) {
		surface = surface.titleRight(opts.right, (text) => theme.fg(tc, text));
	}
	if (opts.paddingX !== undefined) {
		surface = surface.paddingX(opts.paddingX);
	}
	return surface.render(lines, Math.max(20, width));
}

/**
 * Render a framed system/conversation surface (compaction notices, skill
 * invocations) as a copy-clean open surface (ADR 0001): a titled top rule
 * and body lines with no border column. Replaces the former chat-frame.ts.
 */
export function renderChatFrame(
	contentLines: string[],
	width: number,
	opts: {
		label: string;
		tone: FrameTone;
		timestamp?: number;
		timestampFormat: TimestampFormat;
		showTimestamp?: boolean;
	},
): string[] {
	const outerWidth = Math.max(20, width);
	const isPurple = opts.tone === "compaction" || opts.tone === "skill";
	const frameColor: ThemeColor = opts.tone === "user" ? "border" : isPurple ? "customMessageLabel" : "borderAccent";
	const bodyColor: ThemeColor =
		opts.tone === "user" ? "userMessageText" : isPurple ? "customMessageText" : "assistantMessageText";

	// A label may carry a " - " splitting a bold name from a dim detail.
	const dashIdx = opts.label.indexOf(" - ");
	const titleStyled =
		dashIdx >= 0
			? theme.fg(frameColor, theme.bold(opts.label.slice(0, dashIdx))) + theme.fg("dim", opts.label.slice(dashIdx))
			: theme.fg(frameColor, theme.bold(opts.label));
	const rightRaw =
		opts.showTimestamp === false || !opts.timestamp ? "" : formatTimestamp(opts.timestamp, opts.timestampFormat);

	const source = trimOuterBlankLines(contentLines);
	const body = (source.length > 0 ? source : [""]).map((line) => theme.fg(bodyColor, line));

	let surface = style()
		.border("open")
		.borderColor((text) => theme.fg(frameColor, text))
		.title(titleStyled);
	if (rightRaw) {
		surface = surface.titleRight(theme.fg("dim", rightRaw));
	}
	return surface.render(body, outerWidth);
}

export function renderAssistantRail(
	lines: string[],
	width: number,
	opts: { label: string; meta?: string; railColor?: ThemeColor } = { label: "GSD" },
): string[] {
	const railColor = opts.railColor ?? "borderAccent";
	const source = trimOuterBlankLines(lines);
	// Conversation turns omit the closing rule — the next turn's top rule
	// separates them, which keeps a long transcript from filling with lines.
	let surface = style()
		.border("open")
		.bottomRule(false)
		.borderColor((text) => theme.fg(railColor, text))
		.title(theme.fg(railColor, theme.bold(opts.label)));
	if (opts.meta) {
		surface = surface.titleRight(theme.fg("dim", opts.meta));
	}
	// Inset the assistant block by two columns, as the rail did before the
	// migration. The indent sits outside the tint; the tinted block fills
	// the remaining width. Background colour is an SGR code, not a glyph, so
	// it never lands in a copy selection — body lines stay copy-clean.
	const indent = "  ";
	const innerWidth = Math.max(20, width - indent.length);
	return surface
		.render(source.length > 0 ? source : [""], innerWidth)
		.map((line) => indent + theme.bg("customMessageBg", line));
}

export function renderUserRail(
	lines: string[],
	width: number,
	opts: { label: string; meta?: string },
): string[] {
	const source = trimOuterBlankLines(lines);
	const body = (source.length > 0 ? source : [""]).map((line) =>
		theme.fg("userMessageText", line.trimEnd()),
	);
	let surface = style()
		.border("open")
		.bottomRule(false)
		.borderColor((text) => theme.fg("border", text))
		.title(theme.fg("border", theme.bold(opts.label)));
	if (opts.meta) {
		surface = surface.titleRight(theme.fg("dim", opts.meta));
	}
	return surface
		.render(body, Math.max(20, width))
		.map((line) => theme.bg("userMessageBg", line));
}

/**
 * Render a single titled rule line — the collapsed form of a tool/command
 * card on the "open" surface. `title` and `right` must be pre-styled.
 */
function openRuleLine(title: string, right: string, width: number, tone: ThemeColor): string {
	let surface = style()
		.border("open")
		.borderColor((text) => theme.fg(tone, text))
		.title(title);
	if (right) {
		surface = surface.titleRight(right);
	}
	// render([]) yields [topRule, emptyBody, bottomRule] — we want the rule.
	return surface.render([], Math.max(20, width))[0];
}

export function renderTranscriptCard(
	lines: string[],
	width: number,
	opts: {
		title: string;
		right?: string;
		tone: StatusTone;
		footerLeft?: string;
		footerRight?: string;
	},
): string[] {
	const outerWidth = Math.max(20, width);
	const tone = toneColor(opts.tone);
	const body = [...lines];
	if (opts.footerLeft || opts.footerRight) {
		body.push("");
		body.push(
			rightAlign(theme.fg("dim", opts.footerLeft ?? ""), theme.fg("dim", opts.footerRight ?? ""), outerWidth),
		);
	}
	let surface = style()
		.border("open")
		.borderColor((text) => theme.fg(tone, text))
		.title(theme.fg("borderAccent", opts.title));
	if (opts.right) {
		surface = surface.titleRight(theme.fg(tone, opts.right));
	}
	return surface.render(body, outerWidth);
}

export function renderToolLineCard(
	title: string,
	target: string | undefined,
	width: number,
	opts: { status: string; tone: StatusTone; hidden?: boolean; titlePrefix?: string; bg?: ThemeBg },
): string[] {
	const tone = toneColor(opts.tone);
	const titleText = `${opts.titlePrefix ?? ""}${theme.fg("borderAccent", title)}${
		target ? ` ${theme.fg("text", target)}` : ""
	}`;
	const statusText = opts.hidden ? `${opts.status} · output hidden · ctrl+o expand` : opts.status;
	const right = theme.fg(opts.tone === "success" ? "success" : tone, statusText);
	const rule = openRuleLine(titleText, right, width, tone);
	return [opts.bg ? theme.bg(opts.bg, rule) : rule];
}

export function renderCommandCard(
	command: string,
	width: number,
	opts: { status: string; tone: StatusTone; progress?: string },
): string[] {
	const tone = toneColor(opts.tone);
	const titleText = `${theme.fg("accent", "$")} ${theme.fg("text", command)}`;
	const statusText = opts.progress
		? `${opts.progress} ${opts.status}`
		: `${opts.status} · output hidden · ctrl+o expand`;
	const right = theme.fg(opts.tone === "success" ? "success" : tone, statusText);
	return [openRuleLine(titleText, right, width, tone)];
}

export function renderProgressBar(done: number, total: number, width: number, tone: StatusTone = "success"): string {
	const clampedWidth = Math.max(0, width);
	const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
	const filled = Math.round(pct * clampedWidth);
	return (
		theme.fg(toneColor(tone), "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(clampedWidth - filled))
	);
}

export function renderFooterStrip(leftSegments: string[], right: string, width: number): string[] {
	const outerWidth = Math.max(20, width);
	const innerWidth = Math.max(1, outerWidth - 2);
	const sep = theme.fg("dim", "  │  ");
	const rightStyled = theme.fg("dim", right);
	const rightWidth = visibleWidth(rightStyled);
	const leftBudget = right ? Math.max(1, innerWidth - rightWidth - 3) : innerWidth;
	const left = truncateToWidth(leftSegments.filter(Boolean).join(sep), leftBudget, "");
	const content = rightAlign(left, rightStyled, innerWidth);
	return roundedPanel([content], outerWidth);
}
