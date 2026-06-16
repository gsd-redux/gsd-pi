import assert from "node:assert";
import { describe, it } from "node:test";
import { extractSegments, sliceWithWidth, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

// sliceWithWidth() and extractSegments() walk a styled line, alternating between
// ANSI escape sequences and runs of visible text. The run-of-visible-text scan
// finds where the next escape sequence begins. These tests pin that behaviour
// with explicit cases and a fuzz sweep against an independent reference whose
// "find next ESC" step uses the original per-character formulation — so the
// indexOf-based rewrite is provably equivalent to scanning char by char.

// ── Independent references (model the contract, not the implementation) ──────

// Minimal escape-sequence reader matching utils.extractAnsiCode's recognised
// forms (CSI ...m/G/K/H/J, OSC/APC terminated by BEL or ST). Used only so the
// reference can advance over sequences exactly like the real scanner.
function readAnsi(str: string, pos: number): { length: number } | null {
	if (str[pos] !== "\x1b") return null;
	const next = str[pos + 1];
	if (next === "[") {
		let j = pos + 2;
		while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
		return j < str.length ? { length: j + 1 - pos } : null;
	}
	if (next === "]" || next === "_") {
		let j = pos + 2;
		while (j < str.length) {
			if (str[j] === "\x07") return { length: j + 1 - pos };
			if (str[j] === "\x1b" && str[j + 1] === "\\") return { length: j + 2 - pos };
			j++;
		}
		return null;
	}
	return null;
}

// Plain-text width: count UTF-16 code points outside ANSI as width 1 (ASCII-only
// corpus below keeps grapheme width trivial, isolating the scan logic).
function refSlice(line: string, startCol: number, length: number): string {
	if (length <= 0) return "";
	const endCol = startCol + length;
	let out = "";
	let col = 0;
	let pending = "";
	let i = 0;
	while (i < line.length) {
		const ansi = readAnsi(line, i);
		if (ansi) {
			if (col >= startCol && col < endCol) out += line.slice(i, i + ansi.length);
			else if (col < startCol) pending += line.slice(i, i + ansi.length);
			i += ansi.length;
			continue;
		}
		// Visible run: original scan advanced one char at a time to the next ESC.
		let end = i;
		while (end < line.length && !readAnsi(line, end)) end++;
		for (const ch of line.slice(i, end)) {
			const inRange = col >= startCol && col < endCol;
			if (inRange) {
				if (pending) {
					out += pending;
					pending = "";
				}
				out += ch;
			}
			col += 1;
			if (col >= endCol) break;
		}
		i = end;
		if (col >= endCol) break;
	}
	return out;
}

// ── Explicit cases ───────────────────────────────────────────────────────────

describe("sliceWithWidth", () => {
	it("slices a plain ASCII range", () => {
		assert.deepEqual(sliceWithWidth("hello world", 0, 5), { text: "hello", width: 5 });
		assert.deepEqual(sliceWithWidth("hello world", 6, 5), { text: "world", width: 5 });
	});

	it("returns empty for non-positive length", () => {
		assert.deepEqual(sliceWithWidth("hello", 0, 0), { text: "", width: 0 });
		assert.deepEqual(sliceWithWidth("hello", 0, -3), { text: "", width: 0 });
	});

	it("keeps an SGR code that falls inside the slice", () => {
		const line = "ab\x1b[31mcd\x1b[0mef";
		const { text } = sliceWithWidth(line, 2, 2);
		assert.ok(text.includes("\x1b[31m"));
		assert.ok(text.includes("c"));
		assert.ok(text.includes("d"));
	});

	it("carries styling active before the slice onto the first visible char (pendingAnsi)", () => {
		// Red turns on at col 0; slice starts at col 2 — red must be prepended so
		// the sliced text renders in the right color.
		const line = "\x1b[31mabcdef";
		const { text, width } = sliceWithWidth(line, 2, 2);
		assert.equal(width, 2);
		assert.ok(text.startsWith("\x1b[31m"), `expected pending red prepended, got ${JSON.stringify(text)}`);
		assert.ok(text.includes("cd"));
	});

	it("handles a long truecolor sequence between visible chars", () => {
		const line = "x\x1b[38;2;220;220;170my\x1b[0mz";
		assert.deepEqual(sliceWithWidth(line, 0, 1), { text: "x", width: 1 });
		const mid = sliceWithWidth(line, 1, 1);
		assert.equal(mid.width, 1);
		assert.ok(mid.text.includes("y"));
	});

	it("terminates on a lone/malformed ESC byte (no infinite loop)", () => {
		// A bare ESC that does not start a recognised CSI/OSC/APC sequence is not
		// consumed by extractAnsiCode, so the plain-text scan must still advance
		// past it. Regression: a find-next-ESC helper that returned the current
		// position stalled the caller forever.
		const line = "ab\x1bcd"; // \x1b not followed by [ ] _  => malformed
		const { text, width } = sliceWithWidth(line, 0, 4);
		assert.equal(width, 4, "all four visible cells (a,b,ESC,c) measured");
		assert.ok(text.includes("a") && text.includes("b") && text.includes("c"));
	});

	it("matches the per-character reference across a fuzz sweep", () => {
		const samples = [
			"plain text only",
			"\x1b[31mred\x1b[0m normal \x1b[1;32mbold green\x1b[0m",
			"\x1b[38;2;1;2;3mtruecolor\x1b[0m tail",
			"lead\x1b[4munder\x1b[24mline mid \x1b[7minv\x1b[0m end",
			"\x1b[31m\x1b[1m\x1b[4mstacked codes\x1b[0mx",
			"a\x1b[mb\x1b[0mc", // empty-param SGR
		];
		let checked = 0;
		for (const line of samples) {
			const visibleLen = line.replace(/\x1b\[[\d;]*[mGKHJ]/g, "").length;
			for (let start = 0; start <= visibleLen + 1; start++) {
				for (let len = 0; len <= visibleLen + 1; len++) {
					assert.equal(
						sliceWithWidth(line, start, len).text,
						refSlice(line, start, len),
						`slice mismatch line=${JSON.stringify(line)} start=${start} len=${len}`,
					);
					checked++;
				}
			}
		}
		assert.ok(checked > 200, `expected a broad sweep, only ${checked}`);
	});
});

describe("extractSegments", () => {
	it("splits before/after around an overlay region (plain)", () => {
		// "0123456789", before cols [0,3), after cols [5,8)
		const r = extractSegments("0123456789", 3, 5, 3);
		assert.equal(r.before, "012");
		assert.equal(r.beforeWidth, 3);
		assert.equal(r.after, "567");
		assert.equal(r.afterWidth, 3);
	});

	it("returns empty after-segment when afterLen <= 0", () => {
		const r = extractSegments("0123456789", 4, 0, 0);
		assert.equal(r.before, "0123");
		assert.equal(r.after, "");
		assert.equal(r.afterWidth, 0);
	});

	it("inherits styling from before the overlay into the after-segment", () => {
		// Red turns on at col 0 and never resets; the "after" run must re-open red.
		const line = "\x1b[31m0123456789";
		const r = extractSegments(line, 3, 5, 3);
		assert.ok(r.before.startsWith("\x1b[31m"), "before keeps the opening red");
		assert.ok(r.after.includes("\x1b[31m"), "after re-opens inherited red");
		assert.ok(r.after.includes("567"));
	});

	it("handles a long truecolor sequence in the scanned run", () => {
		const line = "ab\x1b[38;2;10;20;30mcdefgh\x1b[0mij";
		const r = extractSegments(line, 2, 4, 2);
		assert.equal(r.before, "ab");
		assert.ok(r.after.includes("e"));
		assert.ok(r.after.includes("f"));
	});
});

// The AnsiCodeTracker (exercised via wrapTextWithAnsi, which re-opens active
// styling at the start of every wrapped line) parses SGR parameters. These
// cases pin that the parameter extraction handles 256-color / truecolor codes
// and ignores malformed finals — the contract the regex-free sgrParams() must
// preserve.
describe("AnsiCodeTracker SGR parsing via wrapTextWithAnsi", () => {
	const wrapWidth = 6;
	// A word longer than the width forces a wrap, so the tracker must re-emit the
	// active color on the continuation line.
	function continuationReopens(code: string): boolean {
		const lines = wrapTextWithAnsi(`${code}abcdefghij\x1b[0m`, wrapWidth);
		assert.ok(lines.length >= 2, "expected the long word to wrap");
		return lines[1].includes(code);
	}

	it("preserves a 256-color foreground across a wrap", () => {
		assert.ok(continuationReopens("\x1b[38;5;208m"), "256-color fg should re-open on the wrapped line");
	});

	it("preserves a truecolor foreground across a wrap", () => {
		assert.ok(continuationReopens("\x1b[38;2;220;220;170m"), "truecolor fg should re-open on the wrapped line");
	});

	it("preserves a basic SGR color across a wrap", () => {
		assert.ok(continuationReopens("\x1b[31m"), "basic red should re-open on the wrapped line");
	});

	it("does not treat a non-SGR final (cursor move) as styling state", () => {
		// \x1b[5G is a cursor-column move, not SGR; it must not be re-emitted as a
		// color on the continuation line (sgrParams rejects it like the old regex).
		const lines = wrapTextWithAnsi("\x1b[5Gabcdefghij\x1b[0m", wrapWidth);
		assert.ok(lines.length >= 2, "expected wrap");
		assert.ok(!lines[1].includes("\x1b[5G"), "cursor-move must not be carried as styling");
	});
});

// graphemeWidth() has an ASCII fast path (single code unit 0x20-0x7e => width 1).
// It is private, but visibleWidth() routes through it for any string that is not
// caught by its own pure-ASCII shortcut — i.e. anything mixing ASCII with ANSI,
// tabs, or non-ASCII. These tests force that path and assert the measured width
// equals an independent grapheme-segmented reference, so the fast path cannot
// silently mis-measure ASCII inside styled content (which would cause wrap drift).
describe("graphemeWidth ASCII fast path via visibleWidth", () => {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	// Reference width: strip the one ANSI reset we use, expand tabs to 3, then sum
	// 1 per visible code point (the corpus below has no wide/zero-width chars in its
	// ASCII portions, so 1-per-codepoint is exact for those).
	function refWidth(s: string): number {
		const clean = s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\t/g, "   ");
		let w = 0;
		for (const { segment } of segmenter.segment(clean)) {
			// Non-ASCII segments delegate to the real function (already trusted via
			// the dedicated visible-width-fastpath suite); ASCII counts as 1.
			const cp = segment.codePointAt(0) ?? 0;
			w += cp >= 0x20 && cp <= 0x7e ? 1 : visibleWidth(segment);
		}
		return w;
	}

	it("measures ASCII inside ANSI-styled content correctly", () => {
		const cases = [
			"\x1b[31mhello world\x1b[0m",
			"\x1b[1;32m[ok]\x1b[0m done in \x1b[2m12ms\x1b[0m",
			"prefix \x1b[34m/src/file.ts:42\x1b[0m suffix",
			"\x1b[7m INVERSE \x1b[0m normal { } ( ) ; : , . < > / ? ! @ # $ %",
		];
		for (const s of cases) assert.strictEqual(visibleWidth(s), refWidth(s), JSON.stringify(s));
	});

	it("measures ASCII inside tabbed content correctly", () => {
		for (const s of ["col1\tcol2\tcol3", "a\tbb\tccc\tdddd", "\tlead tab then ascii"]) {
			assert.strictEqual(visibleWidth(s), refWidth(s), JSON.stringify(s));
		}
	});

	it("measures ASCII mixed with wide and zero-width characters correctly", () => {
		// Forces the segmented graphemeWidth path; the ASCII runs must still each
		// count as width 1 while the CJK/combining parts keep their real widths.
		const s = "ab日本cd\u0301ef";
		assert.strictEqual(visibleWidth(s), refWidth(s), JSON.stringify(s));
	});

	it("covers every printable-ASCII byte inside a styled wrapper", () => {
		for (let c = 0x20; c <= 0x7e; c++) {
			const ch = String.fromCharCode(c);
			const s = `\x1b[31m${ch}\x1b[0m`;
			assert.strictEqual(visibleWidth(s), 1, `byte 0x${c.toString(16)} (${JSON.stringify(ch)})`);
		}
	});

	it("returns stable widths for repeated non-ASCII graphemes (memoized path)", () => {
		// graphemeWidth memoizes non-ASCII clusters; a repeated grapheme must return
		// the same width on the cached call as on the first, uncached one. Measure
		// each grapheme inside a tab wrapper so it routes through graphemeWidth, and
		// assert first == repeated == an independent expectation.
		const cases: Array<[string, number]> = [
			["🚀", 2], // emoji
			["✅", 2], // emoji
			["日", 2], // CJK wide
			["A", 1], // narrow non-ASCII-triggering wrapper still measures A as 1
			["e\u0301", 1], // base + combining mark = width 1
		];
		for (const [g, expected] of cases) {
			const first = visibleWidth(`\t${g}`) - 3; // subtract the tab's 3 cols
			const repeated = visibleWidth(`\t${g}`) - 3;
			assert.strictEqual(first, repeated, `repeat width drift for ${JSON.stringify(g)}`);
			assert.strictEqual(first, expected, `width for ${JSON.stringify(g)}`);
		}
	});
});
