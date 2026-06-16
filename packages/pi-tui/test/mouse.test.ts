import assert from "node:assert";
import { describe, it } from "node:test";
import { isMouseEvent, parseMouseEvent } from "../src/mouse.ts";

describe("parseMouseEvent (SGR)", () => {
	it("parses a left button press", () => {
		const event = parseMouseEvent("\x1b[<0;12;5M");
		assert.deepStrictEqual(event, {
			type: "press",
			button: "left",
			x: 12,
			y: 5,
			shift: false,
			alt: false,
			ctrl: false,
		});
	});

	it("parses a left button release (lowercase m)", () => {
		const event = parseMouseEvent("\x1b[<0;12;5m");
		assert.strictEqual(event?.type, "release");
		assert.strictEqual(event?.button, "left");
	});

	it("parses middle and right button presses", () => {
		assert.strictEqual(parseMouseEvent("\x1b[<1;1;1M")?.button, "middle");
		assert.strictEqual(parseMouseEvent("\x1b[<2;1;1M")?.button, "right");
	});

	it("parses wheel up and wheel down", () => {
		const up = parseMouseEvent("\x1b[<64;1;1M");
		assert.strictEqual(up?.button, "wheel-up");
		assert.strictEqual(up?.type, "press");
		const down = parseMouseEvent("\x1b[<65;1;1M");
		assert.strictEqual(down?.button, "wheel-down");
	});

	it("decodes modifier bits", () => {
		// 0 + shift(4) + alt(8) + ctrl(16) = 28
		const event = parseMouseEvent("\x1b[<28;3;4M");
		assert.deepStrictEqual(
			{ shift: event?.shift, alt: event?.alt, ctrl: event?.ctrl },
			{ shift: true, alt: true, ctrl: true },
		);
	});

	it("classifies motion-with-button as drag", () => {
		// bit 5 (32) = motion, low bits 0 = left held
		const event = parseMouseEvent("\x1b[<32;3;4M");
		assert.strictEqual(event?.type, "drag");
		assert.strictEqual(event?.button, "left");
	});

	it("handles large coordinates beyond the 223 X10 limit", () => {
		const event = parseMouseEvent("\x1b[<0;400;300M");
		assert.strictEqual(event?.x, 400);
		assert.strictEqual(event?.y, 300);
	});
});

describe("parseMouseEvent (legacy X10)", () => {
	it("parses a left press encoded as ESC [ M plus three bytes", () => {
		// button 0, col 32->0 +1? bytes are value+32. col byte = 32+10 = 42 ('*')
		const data = `\x1b[M${String.fromCharCode(32)}${String.fromCharCode(42)}${String.fromCharCode(37)}`;
		const event = parseMouseEvent(data);
		assert.strictEqual(event?.button, "left");
		assert.strictEqual(event?.type, "press");
		assert.strictEqual(event?.x, 10);
		assert.strictEqual(event?.y, 5);
	});

	it("reports a button release with low bits set to 3", () => {
		const data = `\x1b[M${String.fromCharCode(35)}${String.fromCharCode(33)}${String.fromCharCode(33)}`;
		const event = parseMouseEvent(data);
		assert.strictEqual(event?.type, "release");
		assert.strictEqual(event?.button, "none");
	});
});

describe("isMouseEvent", () => {
	it("recognizes SGR and X10 sequences", () => {
		assert.ok(isMouseEvent("\x1b[<0;1;1M"));
		assert.ok(isMouseEvent(`\x1b[M${"!".repeat(3)}`));
	});

	it("rejects non-mouse input", () => {
		assert.ok(!isMouseEvent("a"));
		assert.ok(!isMouseEvent("\x1b[A")); // arrow up
		assert.ok(!isMouseEvent("\x1b[<0;1;1")); // incomplete
	});

	it("returns null from parseMouseEvent for non-mouse data", () => {
		assert.strictEqual(parseMouseEvent("\x1b[A"), null);
	});
});
