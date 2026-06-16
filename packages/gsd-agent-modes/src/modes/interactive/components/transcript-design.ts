// Project/App: gsd-pi
// File Purpose: Shared recommended transcript rendering primitives for assistant, tool, command, footer, and auto-mode TUI surfaces.

import { alignRight, isImageLine, padRight, style, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme, type ThemeBg, type ThemeColor } from "@gsd/pi-coding-agent/theme/theme.js";
import { formatTimestamp, type TimestampFormat } from "./timestamp.js";

export type StatusTone = "running" | "success" | "error" | "warning" | "muted";
export type TuiTone = "default" | "accent" | "success" | "warning" | "error" | "muted";
export type TuiBreakpoint = "compact" | "regular" | "wide";

/** Conversation/system surfaces that the chat frame distinguishes by color. */
export type FrameTone = "assistant" | "user" | "compaction" | "skill";

export function chatMessageWidth(width: number): number {
	return Math.max(24, Math.min(width, Math.floor(width * 0.72)));
}

/** Outer indent for user turns and tool/work cards in the connected transcript. */
export const TRANSCRIPT_CARD_INDENT = 4;
const RUNNING_RAIL_FRAME_MS = 70;
const RUNNING_RAIL_TRAIL = 5;
const HORIZONTAL_RAIL = "─";
const HORIZONTAL_RAIL_HEAD = "━";

// Whether the "running" rail sweeps (animates) or renders as a static rule. User
// setting `terminal.toolRailAnimation` (default on). When off, running cards show
// a static rail and ToolExecutionComponent does not arm its re-render timer, so a
// long-running tool costs zero idle CPU. Module-level (not per-card) because every
// running card shares the one preference; the interactive mode sets it at startup
// and when the setting is toggled.
let railAnimationEnabled = true;
export function setRailAnimationEnabled(enabled: boolean): void {
	railAnimationEnabled = enabled;
}
export function isRailAnimationEnabled(): boolean {
	return railAnimationEnabled;
}

export function headerLabel(text: string): string {
	return text.toUpperCase();
}

function styledHeader(text: string, color: ThemeColor): string {
	return theme.fg(color, theme.bold(headerLabel(text)));
}

function indentSpaces(cols: number): string {
	return cols > 0 ? " ".repeat(cols) : "";
}

function connectedRuleFill(width: number, indent = TRANSCRIPT_CARD_INDENT): string {
	return "─".repeat(Math.max(16, Math.min(40, width - indent - 1)));
}

function runningRailFrame(): number {
	return Math.floor(Date.now() / RUNNING_RAIL_FRAME_MS);
}

function trianglePosition(frame: number, maxPosition: number): number {
	const max = Math.max(0, maxPosition);
	if (max === 0) return 0;
	const period = max * 2;
	const step = frame % period;
	return step <= max ? step : period - step;
}

function renderRailText(text: string, railColor: ThemeColor, sweepFrame?: number): string {
	if (sweepFrame === undefined) return theme.fg(railColor, text);

	const railCells = Array.from(text).filter((char) => char === HORIZONTAL_RAIL).length;
	const head = trianglePosition(sweepFrame, railCells - 1);
	let railIndex = -1;
	let rendered = "";

	for (const char of text) {
		if (char !== HORIZONTAL_RAIL) {
			rendered += theme.fg(railColor, char);
			continue;
		}

		railIndex++;
		const distance = Math.abs(railIndex - head);
		if (distance === 0) {
			rendered += theme.fg(railColor, theme.bold(HORIZONTAL_RAIL_HEAD));
		} else if (distance <= RUNNING_RAIL_TRAIL) {
			rendered += theme.fg(railColor, HORIZONTAL_RAIL_HEAD);
		} else {
			rendered += theme.fg(railColor, HORIZONTAL_RAIL);
		}
	}
	return rendered;
}

export function renderChatTurnBridge(
	width: number,
	fromIndent = TRANSCRIPT_CARD_INDENT,
	railColor: ThemeColor = "borderAccent",
): string[] {
	const bridge = indentSpaces(fromIndent) + "╰──────╮";
	return [padLine(theme.fg(railColor, bridge), width)];
}

/** Bridge from a left-pegged assistant turn down into the next indented user turn. */
export function renderChatTurnBridgeToUser(
	width: number,
	railColor: ThemeColor = "border",
): string[] {
	const bridge = "╰──────╮";
	return [padLine(theme.fg(railColor, bridge), width)];
}

export function renderConnectedCard(
	width: number,
	title: string,
	bodyLines: string[],
	opts: {
		indent?: number;
		titleRight?: string;
		railColor?: ThemeColor;
		titleColor?: ThemeColor;
		bodyBg?: ThemeBg;
		closeBottom?: boolean;
		railSweep?: boolean;
	} = {},
): string[] {
	const indent = opts.indent ?? TRANSCRIPT_CARD_INDENT;
	const prefix = indentSpaces(indent);
	const railColor = opts.railColor ?? "borderAccent";
	const sweepFrame = opts.railSweep && railAnimationEnabled ? runningRailFrame() : undefined;
	const rail = (text: string) => renderRailText(text, railColor, sweepFrame);
	const resolvedTitleColor =
		opts.titleColor ??
		(title.includes("✕") ? "error" : title.includes("✓") ? "success" : railColor);
	const titleStyled = theme.fg(resolvedTitleColor, theme.bold(headerLabel(title)));
	const lead = prefix + rail("╭─ ") + titleStyled;
	let topLine = lead;
	if (opts.titleRight) {
		const available = width - visibleWidth(lead) - 1;
		const rightWidth = visibleWidth(opts.titleRight);
		if (rightWidth + 5 <= available) {
			const fill = Math.max(1, available - rightWidth - 2);
			topLine = lead + rail(" " + "─".repeat(fill) + " ") + opts.titleRight;
		} else {
			const clippedRight = truncateToWidth(opts.titleRight, Math.max(8, available - 5), "");
			const fill = Math.max(1, available - visibleWidth(clippedRight) - 2);
			topLine = lead + rail(" " + "─".repeat(fill) + " ") + clippedRight;
		}
	}
	const paintBody = (line: string) => {
		// Image (Kitty/iTerm2) sequence lines carry raw terminal graphics escapes and
		// rely on exact column/row positioning. Prepend the SAME left offset normal
		// body lines get (card indent + 3 spaces) so the image aligns under the card
		// text rather than hugging column 0, but do NOT padRight/truncate — trailing
		// padding or clipping after the sequence would corrupt the placement. The
		// leading spaces simply advance the cursor before the image draws.
		if (isImageLine(line)) {
			return prefix + "   " + line;
		}
		const innerWidth = Math.max(1, width - indent);
		const inner = padRight("   " + line, innerWidth);
		const painted = opts.bodyBg ? theme.bg(opts.bodyBg, inner) : inner;
		return prefix + painted;
	};
	// When the body contains an inline image, its reserved blank padding rows (the
	// rows the TUI counts so content below the image lands in the right place) must
	// NOT be trimmed/collapsed — trimming them collapses a tall image to one line
	// and the terminal then paints the full image over the chat and footer below.
	const hasImage = bodyLines.some((l) => isImageLine(l));
	const bodySource = hasImage ? bodyLines : trimOuterBlankLines(bodyLines);
	const out = [padLine(topLine, width)];
	for (const line of bodySource) {
		out.push(paintBody(line));
	}
	if (opts.closeBottom !== false) {
		out.push(padLine(prefix + rail("╰" + connectedRuleFill(width, indent)), width));
	}
	return out;
}

export function trimOuterBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim().length === 0) start++;
	while (end > start && lines[end - 1].trim().length === 0) end--;
	return lines.slice(start, end);
}

/** Collapse runs of blank lines to a single blank line (tool output only). */
export function collapseBlankLines(lines: string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const blank = line.trim().length === 0;
		if (blank && out.length > 0 && out[out.length - 1]!.trim().length === 0) continue;
		out.push(line);
	}
	return trimOuterBlankLines(out);
}

function padLine(line: string, width: number): string {
	return padRight(truncateToWidth(line, width, ""), width);
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

export function breakpoint(width: number): TuiBreakpoint {
	if (width < 72) return "compact";
	if (width < 112) return "regular";
	return "wide";
}

function panelToneColor(tone: TuiTone): ThemeColor {
	switch (tone) {
		case "accent": return "borderAccent";
		case "success": return "success";
		case "warning": return "warning";
		case "error": return "error";
		case "muted": return "borderMuted";
		case "default":
		default: return "border";
	}
}

export function badge(text: string, tone: TuiTone = "default"): string {
	return theme.fg(panelToneColor(tone), text);
}

export function keyValue(label: string, value: string, valueColor: ThemeColor = "text", labelWidth = 10): string {
	return `${theme.fg("dim", padRight(label, labelWidth))}${theme.fg(valueColor, value)}`;
}

export function roundedPanel(
	lines: string[],
	width: number,
	opts: {
		tone?: TuiTone;
		title?: string;
		rightTitle?: string;
		paddingX?: number;
	} = {},
): string[] {
	const outerWidth = Math.max(1, width);
	const body = lines.length > 0 ? lines : [""];
	if (outerWidth < 3) {
		return body.map((line) => truncateToWidth(line, outerWidth, ""));
	}

	let panel = style()
		.border("rounded")
		.borderColor((text) => theme.fg(panelToneColor(opts.tone ?? "default"), text))
		.paddingX(Math.max(0, opts.paddingX ?? 0));
	if (opts.title) {
		panel = panel.title(theme.fg("borderAccent", opts.title));
	}
	if (opts.rightTitle) {
		panel = panel.titleRight(theme.fg("dim", opts.rightTitle));
	}
	return panel.render(body, outerWidth);
}

export function rightAlign(left: string, right: string, width: number): string {
	return alignRight(left, right, width);
}

/**
 * Render a copy-clean content surface (ADR-019): a titled top rule, body
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
 * invocations) as a copy-clean open surface (ADR-019): a titled top rule
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
	opts: {
		label?: string;
		meta?: string;
		railColor?: ThemeColor;
		connected?: boolean;
		continuesToUser?: boolean;
	} = {},
): string[] {
	const railColor = opts.railColor ?? "borderAccent";
	const source = trimOuterBlankLines(lines);
	const body = (source.length > 0 ? source : [""]).map((line) => theme.fg("assistantMessageText", line));
	const titleRight = opts.meta ? theme.fg("dim", opts.meta) : undefined;
	const card = renderConnectedCard(width, opts.label ?? "GSD", body, {
		indent: 0,
		titleRight,
		railColor,
		closeBottom: !opts.continuesToUser,
	});
	let result = card;
	if (opts.connected) {
		result = [...renderChatTurnBridge(width, TRANSCRIPT_CARD_INDENT), ...result];
	}
	if (opts.continuesToUser) {
		result = [...result, ...renderChatTurnBridgeToUser(width)];
	}
	return result;
}

export function renderUserRail(
	lines: string[],
	width: number,
	opts: { label?: string; meta?: string; continuesToAssistant?: boolean },
): string[] {
	const source = trimOuterBlankLines(lines);
	const body = (source.length > 0 ? source : [""]).map((line) => theme.fg("userMessageText", line));
	const titleRight = opts.meta ? theme.fg("dim", opts.meta) : undefined;
	return renderConnectedCard(width, opts.label ?? "You", body, {
		indent: TRANSCRIPT_CARD_INDENT,
		titleRight,
		railColor: "border",
		titleColor: "border",
		closeBottom: !opts.continuesToAssistant,
	});
}

/**
 * Render a single titled rule line — the collapsed form of a tool/command
 * card on the "open" surface. `title` and `right` must be pre-styled.
 */
function openRuleLine(title: string, right: string, width: number, tone: ThemeColor, sweep = false): string {
	const w = Math.max(20, width);
	if (!right) {
		const clippedTitle = truncateToWidth(title, Math.max(0, w - 6), "");
		const fill = Math.max(1, w - 5 - visibleWidth(clippedTitle));
		return padLine(renderRailText("─── ", tone) + clippedTitle + renderRailText(` ${"─".repeat(fill)}`, tone), w);
	}

	const titleBudget = Math.max(0, w - 11);
	const rightReserve = titleBudget > 1 && visibleWidth(right) > 0 ? 1 : 0;
	const leftBudget = Math.min(visibleWidth(title), Math.max(0, titleBudget - rightReserve));
	const rightBudget = Math.max(0, titleBudget - leftBudget);
	const clippedTitle = truncateToWidth(title, leftBudget, "");
	const clippedRight = truncateToWidth(right, rightBudget, "");
	const fixed = 4 + visibleWidth(clippedTitle) + 2 + visibleWidth(clippedRight) + 4;
	const fill = Math.max(1, w - fixed);
	const sweepFrame = sweep && railAnimationEnabled ? runningRailFrame() : undefined;

	return padLine(
		renderRailText("─── ", tone) +
			clippedTitle +
			renderRailText(` ${"─".repeat(fill)} `, tone, sweepFrame) +
			clippedRight +
			renderRailText(" ───", tone),
		w,
	);
}

function indentRenderedLines(lines: string[], indent: number, width: number): string[] {
	if (indent <= 0) return lines;
	const prefix = indentSpaces(indent);
	return lines.map((line) => padLine(prefix + truncateToWidth(line, Math.max(1, width - indent), ""), width));
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
		indent?: number;
	},
): string[] {
	const outerWidth = Math.max(20, width);
	const indent = opts.indent ?? TRANSCRIPT_CARD_INDENT;
	const tone = toneColor(opts.tone);
	// Preserve image padding rows (see renderConnectedCard) — trimming them would
	// collapse a tall inline image and make it overflow the card.
	const body = lines.some((l) => isImageLine(l)) ? lines : trimOuterBlankLines(lines);
	let titleRight = opts.right ? theme.fg(tone, opts.right) : undefined;
	if (opts.footerLeft || opts.footerRight) {
		const hint = [opts.footerLeft, opts.footerRight].filter(Boolean).join(" · ");
		const hintStyled = theme.fg("dim", hint);
		titleRight = titleRight ? `${titleRight} · ${hintStyled}` : hintStyled;
	}
	return renderConnectedCard(outerWidth, opts.title, body, {
		indent,
		titleRight,
		railColor: tone,
		railSweep: opts.tone === "running",
	});
}

export function renderToolLineCard(
	title: string,
	target: string | undefined,
	width: number,
	opts: { status: string; tone: StatusTone; hidden?: boolean; titlePrefix?: string; bg?: ThemeBg; indent?: number },
): string[] {
	const tone = toneColor(opts.tone);
	const indent = opts.indent ?? TRANSCRIPT_CARD_INDENT;
	const innerWidth = Math.max(20, width - indent);
	const titleText = `${opts.titlePrefix ?? ""}${styledHeader(title, "borderAccent")}${
		target ? ` ${theme.fg("text", target)}` : ""
	}`;
	const statusText = opts.hidden ? `${opts.status} · output hidden · ctrl+o expand` : opts.status;
	const right = theme.fg(opts.tone === "success" ? "success" : tone, statusText);
	const rule = openRuleLine(titleText, right, innerWidth, tone, opts.tone === "running");
	const line = opts.bg ? theme.bg(opts.bg, rule) : rule;
	return indentRenderedLines([line], indent, width);
}

export function renderCommandCard(
	command: string,
	width: number,
	opts: { status: string; tone: StatusTone; progress?: string; indent?: number },
): string[] {
	const tone = toneColor(opts.tone);
	const indent = opts.indent ?? TRANSCRIPT_CARD_INDENT;
	const innerWidth = Math.max(20, width - indent);
	const titleText = `${theme.fg("accent", "$")} ${theme.fg("text", command)}`;
	const statusText = opts.progress
		? `${opts.progress} ${opts.status}`
		: `${opts.status} · output hidden · ctrl+o expand`;
	const right = theme.fg(opts.tone === "success" ? "success" : tone, statusText);
	return indentRenderedLines([openRuleLine(titleText, right, innerWidth, tone, opts.tone === "running")], indent, width);
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
