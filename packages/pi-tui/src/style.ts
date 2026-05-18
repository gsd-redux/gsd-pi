// GSD2 - Terminal style primitives for framed TUI surfaces

import { truncateToWidth, visibleWidth } from "./utils.js";

export type TerminalBorderStyle = "none" | "rule" | "single" | "rounded" | "heavy" | "minimal" | "open";
export type TerminalDensity = "compact" | "comfortable" | "dashboard";
export type TerminalTone = "default" | "muted" | "running" | "success" | "error" | "current";

export interface TerminalStyleSpec {
	width?: number;
	paddingX?: number;
	paddingY?: number;
	border?: TerminalBorderStyle;
	density?: TerminalDensity;
	tone?: TerminalTone;
	borderColor?: (text: string) => string;
	foreground?: (text: string) => string;
	toneColor?: (tone: TerminalTone, text: string) => string;
	title?: string;
	titleRight?: string;
	titleColor?: (text: string) => string;
	titleRightColor?: (text: string) => string;
	bodyGutter?: string;
}

type BorderChars = {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
};

const BORDER_CHARS: Record<Exclude<TerminalBorderStyle, "none" | "rule" | "minimal" | "open">, BorderChars> = {
	single: {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
	},
	rounded: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	heavy: {
		topLeft: "┏",
		topRight: "┓",
		bottomLeft: "┗",
		bottomRight: "┛",
		horizontal: "━",
		vertical: "┃",
	},
};

const DENSITY_PADDING: Record<TerminalDensity, { x: number; y: number }> = {
	compact: { x: 0, y: 0 },
	comfortable: { x: 1, y: 0 },
	dashboard: { x: 1, y: 1 },
};

function padVisible(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function color(fn: ((text: string) => string) | undefined, text: string): string {
	return fn ? fn(text) : text;
}

function normalizeWidth(spec: TerminalStyleSpec, width?: number): number {
	return Math.max(1, Math.floor(width ?? spec.width ?? 80));
}

export class TerminalStyle {
	private readonly spec: TerminalStyleSpec;

	constructor(spec: TerminalStyleSpec = {}) {
		this.spec = { ...spec };
	}

	width(width: number): TerminalStyle {
		return new TerminalStyle({ ...this.spec, width });
	}

	padding(x: number, y = x): TerminalStyle {
		return new TerminalStyle({ ...this.spec, paddingX: x, paddingY: y });
	}

	paddingX(paddingX: number): TerminalStyle {
		return new TerminalStyle({ ...this.spec, paddingX });
	}

	paddingY(paddingY: number): TerminalStyle {
		return new TerminalStyle({ ...this.spec, paddingY });
	}

	border(border: TerminalBorderStyle): TerminalStyle {
		return new TerminalStyle({ ...this.spec, border });
	}

	density(density: TerminalDensity): TerminalStyle {
		return new TerminalStyle({ ...this.spec, density });
	}

	tone(tone: TerminalTone, toneColor?: (tone: TerminalTone, text: string) => string): TerminalStyle {
		return new TerminalStyle({ ...this.spec, tone, toneColor });
	}

	borderColor(borderColor: (text: string) => string): TerminalStyle {
		return new TerminalStyle({ ...this.spec, borderColor });
	}

	foreground(foreground: (text: string) => string): TerminalStyle {
		return new TerminalStyle({ ...this.spec, foreground });
	}

	toneColor(toneColor: (tone: TerminalTone, text: string) => string): TerminalStyle {
		return new TerminalStyle({ ...this.spec, toneColor });
	}

	title(title: string, titleColor?: (text: string) => string): TerminalStyle {
		return new TerminalStyle({ ...this.spec, title, titleColor });
	}

	titleRight(titleRight: string, titleRightColor?: (text: string) => string): TerminalStyle {
		return new TerminalStyle({ ...this.spec, titleRight, titleRightColor });
	}

	rightTitle(titleRight: string, titleRightColor?: (text: string) => string): TerminalStyle {
		return this.titleRight(titleRight, titleRightColor);
	}

	bodyGutter(bodyGutter: string): TerminalStyle {
		return new TerminalStyle({ ...this.spec, bodyGutter });
	}

	render(contentLines: string[], width?: number): string[] {
		const outerWidth = normalizeWidth(this.spec, width);
		const border = this.spec.border ?? "none";
		const densityPadding = DENSITY_PADDING[this.spec.density ?? "compact"];
		const paddingX = Math.max(0, Math.floor(this.spec.paddingX ?? densityPadding.x));
		const paddingY = Math.max(0, Math.floor(this.spec.paddingY ?? densityPadding.y));
		const gutter = this.spec.bodyGutter ?? "";
		const gutterWidth = visibleWidth(gutter);
		// "open" surfaces have no vertical border column — body lines are
		// emitted as pure content so terminal selection copies clean text.
		const borderColumns = border === "none" || border === "open" ? 0 : 2;
		const innerWidth = Math.max(1, outerWidth - borderColumns - paddingX * 2 - gutterWidth);
		const emptyPaddedLine = " ".repeat(paddingX * 2 + innerWidth);
		const sourceLines = contentLines.length > 0 ? contentLines : [""];
		const paddedBody = [
			...Array.from({ length: paddingY }, () => emptyPaddedLine),
			...sourceLines.map((line) => {
				const clipped = truncateToWidth(line, innerWidth, "");
				const styled = color(this.spec.foreground, clipped);
				return `${gutter}${" ".repeat(paddingX)}${padVisible(styled, innerWidth)}${" ".repeat(paddingX)}`;
			}),
			...Array.from({ length: paddingY }, () => emptyPaddedLine),
		];
		const borderColorFn = this.spec.borderColor ?? (this.spec.toneColor ? (value: string) => this.spec.toneColor?.(this.spec.tone ?? "default", value) ?? value : undefined);
		const borderColor = (text: string) => color(borderColorFn, text);

		if (border === "none") {
			return paddedBody.map((line) => padVisible(line, outerWidth));
		}

		if (border === "rule") {
			return [
				borderColor("─".repeat(outerWidth)),
				...this.renderTitleRows(outerWidth),
				...paddedBody.map((line) => `${borderColor("│ ")}${truncateToWidth(line, Math.max(1, outerWidth - 2), "")}`),
			];
		}

		if (border === "minimal") {
			const contentWidth = Math.max(1, outerWidth - 2);
			return [
				...this.renderTitleRows(contentWidth).map((line) => `${borderColor("│ ")}${padVisible(line, contentWidth)}`),
				...paddedBody.map((line) => `${borderColor("│ ")}${padVisible(line, contentWidth)}`),
			];
		}

		if (border === "open") {
			// Copy-clean content surface (ADR 0001): a titled top rule, body
			// lines emitted verbatim with no border column or prefix, and a
			// closing rule. Selecting a body line copies only its content.
			return [
				this.renderOpenTopRule(outerWidth, borderColor),
				...paddedBody.map((line) => padVisible(line, outerWidth)),
				borderColor("─".repeat(Math.max(1, outerWidth))),
			];
		}

		const chars = BORDER_CHARS[border];
		const horizontalWidth = Math.max(0, outerWidth - 2);
		const top = borderColor(
			`${chars.topLeft}${chars.horizontal.repeat(horizontalWidth)}${chars.topRight}`,
		);
		const bottom = borderColor(
			`${chars.bottomLeft}${chars.horizontal.repeat(horizontalWidth)}${chars.bottomRight}`,
		);
		const contentWidth = Math.max(1, outerWidth - 2);
		return [
			top,
			...this.renderTitleRows(contentWidth).map((line) =>
				`${borderColor(chars.vertical)}${padVisible(line, contentWidth)}${borderColor(chars.vertical)}`,
			),
			...paddedBody.map((line) =>
				`${borderColor(chars.vertical)}${padVisible(line, contentWidth)}${borderColor(chars.vertical)}`,
			),
			bottom,
		];
	}

	/**
	 * Build the titled top rule for an "open" surface, e.g.
	 * `─── bash · success ─────────── 1.2s ───`. The whole line is rule
	 * characters plus the (optional) titles — no content, so it is safe for
	 * a user to include in a copy selection.
	 */
	private renderOpenTopRule(width: number, borderColor: (text: string) => string): string {
		const w = Math.max(1, width);
		const left = this.spec.title ?? "";
		const right = this.spec.titleRight ?? "";
		if (!left && !right) return borderColor("─".repeat(w));

		const styledLeft = color(this.spec.titleColor, left);
		const styledRight = color(this.spec.titleRightColor, right);

		if (left && right) {
			const fixed = 4 + visibleWidth(left) + 2 + visibleWidth(right) + 4;
			const fill = Math.max(1, w - fixed);
			return (
				borderColor("─── ") +
				styledLeft +
				borderColor(` ${"─".repeat(fill)} `) +
				styledRight +
				borderColor(" ───")
			);
		}
		if (left) {
			const fill = Math.max(1, w - 5 - visibleWidth(left));
			return borderColor("─── ") + styledLeft + borderColor(` ${"─".repeat(fill)}`);
		}
		const fill = Math.max(1, w - 5 - visibleWidth(right));
		return borderColor(`${"─".repeat(fill)} `) + styledRight + borderColor(" ───");
	}

	private renderTitleRows(width: number): string[] {
		const leftRaw = this.spec.title ?? "";
		const rightRaw = this.spec.titleRight ?? "";
		if (!leftRaw && !rightRaw) return [];

		const leftBudget = rightRaw ? Math.max(1, width - visibleWidth(rightRaw) - 1) : width;
		const left = color(this.spec.titleColor, truncateToWidth(leftRaw, leftBudget, ""));
		const right = color(this.spec.titleRightColor, rightRaw);
		const gap = rightRaw
			? Math.max(1, width - visibleWidth(left) - visibleWidth(right))
			: Math.max(0, width - visibleWidth(left));
		return [`${left}${" ".repeat(gap)}${right}`];
	}
}

export function style(spec: TerminalStyleSpec = {}): TerminalStyle {
	return new TerminalStyle(spec);
}
