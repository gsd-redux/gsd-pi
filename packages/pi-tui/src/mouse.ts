/**
 * Mouse event parsing for the TUI.
 *
 * Supports the two common terminal mouse report encodings:
 * - SGR extended mode: `CSI < b ; x ; y M` (press/motion) or `... m` (release).
 *   Preferred because it has no 223-cell coordinate limit and reports the button
 *   on release.
 * - Legacy X10/normal mode: `CSI M` followed by exactly three bytes (button,
 *   column, row), each offset by 32.
 *
 * Mouse reporting is turned on with {@link ENABLE_MOUSE} and off with
 * {@link DISABLE_MOUSE} (see terminal.ts). We request button-event tracking
 * (mode 1000) plus SGR extended coordinates (mode 1006). Wheel events are
 * reported as buttons 64/65 under mode 1000, so no separate mode is needed.
 *
 * Coordinates produced here are 1-based screen coordinates, matching the
 * terminal protocol. The TUI translates them to component-local 0-based
 * coordinates before dispatching to {@link Component.handleMouse}.
 */

export type MouseButton = "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "none";
export type MouseEventType = "press" | "release" | "move" | "drag";

export interface MouseEvent {
	/** Kind of interaction. Clicks arrive as "press" then "release". */
	type: MouseEventType;
	/** Which button (or wheel direction) triggered the event. */
	button: MouseButton;
	/** Column of the event (1-based when produced by the parser). */
	x: number;
	/** Row of the event (1-based when produced by the parser). */
	y: number;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

/** Enable button-event tracking (1000) plus SGR extended coordinates (1006). */
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
/** Disable mouse reporting (reverse order of {@link ENABLE_MOUSE}). */
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";

// SGR mouse report: ESC [ < button ; col ; row (M | m)
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

// Modifier bits shared by both encodings.
const SHIFT_BIT = 4;
const ALT_BIT = 8;
const CTRL_BIT = 16;
const MOTION_BIT = 32;
const WHEEL_BIT = 64;

/** True when `data` is a complete mouse report sequence. */
export function isMouseEvent(data: string): boolean {
	if (SGR_MOUSE_RE.test(data)) {
		return true;
	}
	// Legacy X10: ESC [ M followed by exactly three encoded bytes.
	return data.length === 6 && data.startsWith("\x1b[M");
}

function decodeButton(code: number, isRelease: boolean): { button: MouseButton; type: MouseEventType } {
	if ((code & WHEEL_BIT) !== 0) {
		// Wheel events: low bit selects direction.
		return { button: (code & 1) === 0 ? "wheel-up" : "wheel-down", type: "press" };
	}

	let button: MouseButton;
	switch (code & 3) {
		case 0:
			button = "left";
			break;
		case 1:
			button = "middle";
			break;
		case 2:
			button = "right";
			break;
		default:
			button = "none";
			break;
	}

	let type: MouseEventType;
	if (isRelease) {
		type = "release";
	} else if ((code & MOTION_BIT) !== 0) {
		type = button === "none" ? "move" : "drag";
	} else {
		type = "press";
	}

	return { button, type };
}

/**
 * Parse a single mouse report sequence into a structured event, or return null
 * if `data` is not a recognized mouse sequence.
 */
export function parseMouseEvent(data: string): MouseEvent | null {
	const sgr = data.match(SGR_MOUSE_RE);
	if (sgr) {
		const code = parseInt(sgr[1], 10);
		const x = parseInt(sgr[2], 10);
		const y = parseInt(sgr[3], 10);
		const isRelease = sgr[4] === "m";
		const { button, type } = decodeButton(code, isRelease);
		return {
			type,
			button,
			x,
			y,
			shift: (code & SHIFT_BIT) !== 0,
			alt: (code & ALT_BIT) !== 0,
			ctrl: (code & CTRL_BIT) !== 0,
		};
	}

	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const code = data.charCodeAt(3) - 32;
		const x = data.charCodeAt(4) - 32;
		const y = data.charCodeAt(5) - 32;
		// Legacy mode reports any button release with the low bits set to 3 and
		// does not say which button was released.
		const isRelease = (code & WHEEL_BIT) === 0 && (code & 3) === 3;
		const { button, type } = decodeButton(code, isRelease);
		return {
			type,
			button: isRelease ? "none" : button,
			x,
			y,
			shift: (code & SHIFT_BIT) !== 0,
			alt: (code & ALT_BIT) !== 0,
			ctrl: (code & CTRL_BIT) !== 0,
		};
	}

	return null;
}
