// Project/App: gsd-pi
// File Purpose: Tests for the shared cost rounding used by the generated
// catalog writers (scripts/lib/model-cost.ts).

import { describe, expect, test } from "vitest";
import { formatCost, roundCost } from "../scripts/lib/model-cost.ts";

describe("roundCost", () => {
	test("strips binary float noise from upstream prices", () => {
		// Real values observed in upstream provider data (see #2120).
		expect(roundCost(0.7999999999999999)).toBe(0.8);
		expect(roundCost(1.5999999999999999)).toBe(1.6);
		expect(roundCost(3.1999999999999997)).toBe(3.2);
		expect(roundCost(0.049999999999999996)).toBe(0.05);
		expect(roundCost(0.09999999999999999)).toBe(0.1);
	});

	test("leaves clean values unchanged", () => {
		expect(roundCost(0.8)).toBe(0.8);
		expect(roundCost(0.05)).toBe(0.05);
		expect(roundCost(2)).toBe(2);
	});

	test("normalizes negative zero to zero", () => {
		expect(Object.is(roundCost(-0), 0)).toBe(true);
	});

	test("rejects non-finite costs", () => {
		expect(() => roundCost(Number.NaN)).toThrow(/finite/);
		expect(() => roundCost(Number.POSITIVE_INFINITY)).toThrow(/finite/);
	});

	test("is idempotent", () => {
		const once = roundCost(0.7999999999999999);
		expect(roundCost(once)).toBe(once);
	});
});

describe("formatCost / roundCost contract", () => {
	// The regression behind #2120: the TypeScript writer formats costs while
	// the JSON snapshot serialized raw floats, so the two outputs diverged.
	// Both writers now share roundCost; these assertions pin that the TS
	// literal and the JSON-serialized value are the same number.
	test("TS literal and JSON-serialized value agree for noisy floats", () => {
		for (const value of [0.7999999999999999, 1.5999999999999999, 3.1999999999999997, 0.049999999999999996]) {
			const tsLiteral = Number(formatCost(value));
			const jsonValue = JSON.parse(JSON.stringify(roundCost(value))) as number;
			expect(jsonValue).toBe(tsLiteral);
		}
	});
});
