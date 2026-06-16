import assert from "node:assert";
import { describe, it } from "node:test";
import { extractAnsiCode } from "../src/utils.ts";

// extractAnsiCode() scans a single escape sequence (CSI / OSC / APC) starting at
// `pos` and returns its { code, length }, or null when `pos` is not the start of
// a recognised sequence. The CSI branch scans for one of five final bytes
// (m / G / K / H / J) by comparing char codes directly. These tests pin that
// contract with explicit cases and an equivalence sweep against an independent
// reference implementation of the CSI scan, so the function is provably correct
// regardless of how the scan is written.

/**
 * Independent reference for the CSI scan, using a regex `.test()` over each
 * character — the original formulation. extractAnsiCode() must match this for
 * every input, which is what makes the char-code rewrite a safe equivalent.
 */
function referenceExtract(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;
	if (str[pos + 1] !== "[") return null; // reference only models the CSI branch
	let j = pos + 2;
	while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
	if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
	return null;
}

describe("extractAnsiCode", () => {
	it("parses a basic SGR color sequence", () => {
		const ansi = extractAnsiCode("\x1b[31mhi", 0);
		assert.deepEqual(ansi, { code: "\x1b[31m", length: 5 });
	});

	it("parses a reset sequence", () => {
		const ansi = extractAnsiCode("\x1b[0m", 0);
		assert.deepEqual(ansi, { code: "\x1b[0m", length: 4 });
	});

	it("parses a truecolor SGR sequence", () => {
		const ansi = extractAnsiCode("\x1b[38;2;220;220;170mX", 0);
		assert.deepEqual(ansi, { code: "\x1b[38;2;220;220;170m", length: 19 });
	});

	it("parses each CSI final byte (m/G/K/H/J)", () => {
		for (const final of ["m", "G", "K", "H", "J"]) {
			const seq = `\x1b[1;2${final}`;
			const ansi = extractAnsiCode(seq, 0);
			assert.deepEqual(ansi, { code: seq, length: seq.length }, `final byte ${final}`);
		}
	});

	it("returns the sequence length so the caller can skip it", () => {
		const str = "ab\x1b[31mcd";
		const ansi = extractAnsiCode(str, 2);
		assert.equal(ansi?.length, 5);
		assert.equal(str.slice(2 + ansi!.length), "cd");
	});

	it("returns null when pos is not at an ESC", () => {
		assert.equal(extractAnsiCode("\x1b[31m", 1), null);
		assert.equal(extractAnsiCode("plain text", 0), null);
	});

	it("returns null for an unterminated CSI sequence", () => {
		assert.equal(extractAnsiCode("\x1b[38;2;1;2;3", 0), null);
		assert.equal(extractAnsiCode("\x1b[", 0), null);
	});

	it("parses an OSC 8 hyperlink terminated by BEL", () => {
		const seq = "\x1b]8;;https://example.com\x07";
		const ansi = extractAnsiCode(seq, 0);
		assert.deepEqual(ansi, { code: seq, length: seq.length });
	});

	it("matches an independent CSI reference across every final byte and prefix", () => {
		const prefixes = ["", "0", "1;31", "38;2;1;2;3", "?25", "2"];
		let checked = 0;
		// Sweep every possible byte in the CSI body position, with several
		// parameter prefixes, at every offset of a surrounding string.
		for (let byte = 0x20; byte <= 0x7e; byte++) {
			for (const prefix of prefixes) {
				const seq = `\x1b[${prefix}${String.fromCharCode(byte)}tail\x1b[0m`;
				for (let pos = 0; pos < seq.length; pos++) {
					assert.deepEqual(
						extractAnsiCode(seq, pos),
						referenceExtract(seq, pos),
						`byte=0x${byte.toString(16)} prefix=${JSON.stringify(prefix)} pos=${pos}`,
					);
					checked++;
				}
			}
		}
		assert.ok(checked > 5000, `expected a broad sweep, only checked ${checked}`);
	});

	it("matches the CSI reference on truncated and lone-ESC inputs", () => {
		for (const str of ["\x1b[", "\x1b[38;2", "\x1b[m", "\x1b[0m", "\x1b[1;31mx"]) {
			for (let pos = 0; pos < str.length + 1; pos++) {
				assert.deepEqual(
					extractAnsiCode(str, pos),
					referenceExtract(str, pos),
					`str=${JSON.stringify(str)} pos=${pos}`,
				);
			}
		}
	});
});
