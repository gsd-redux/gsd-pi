import { describe, expect, it } from "vitest";
import {
	collectValidationErrorFields,
	decideSchemaOverloadBreaker,
	extractValidationErrorFields,
	isConvergingValidationFieldSet,
	isRotatingValidationFieldSet,
	narrowedSchemaRetryInstruction,
} from "../src/schema-overload-convergence.js";

const cap = 3;

describe("schema-overload convergence", () => {
	it("extracts field paths from TypeBox validation errors", () => {
		const text = [
			'Validation failed for tool "gsd_reassess_roadmap":',
			"  - /milestoneId: Expected string",
			"  - /findings: Expected array",
			"",
			"Received arguments:",
			'{"milestoneId":1}',
		].join("\n");
		expect(extractValidationErrorFields(text)).toEqual(["/findings", "/milestoneId"]);
	});

	it("treats a shrinking field set as converging", () => {
		expect(isConvergingValidationFieldSet(["/a", "/b", "/c"], ["/a", "/b"])).toBe(true);
		expect(isConvergingValidationFieldSet(["/a", "/b"], ["/a", "/b"])).toBe(false);
		expect(isConvergingValidationFieldSet(["/a", "/b"], ["/a", "/c"])).toBe(false);
		expect(isConvergingValidationFieldSet(["/a"], ["/a", "/b"])).toBe(false);
	});

	it("treats a nonempty non-subset field set as rotating", () => {
		expect(isRotatingValidationFieldSet(["/a", "/b"], ["/a", "/c"])).toBe(true);
		expect(isRotatingValidationFieldSet(["/modified"], ["/sliceId"])).toBe(true);
		expect(isRotatingValidationFieldSet(["/a"], ["/a", "/b"])).toBe(true);
		expect(isRotatingValidationFieldSet(["/a", "/b"], ["/a", "/b"])).toBe(false);
		expect(isRotatingValidationFieldSet(["/a", "/b"], ["/a"])).toBe(false);
		expect(isRotatingValidationFieldSet(["/a", "/b"], [])).toBe(false);
	});

	it("grants one narrowed retry when errors shrink at the cap", () => {
		expect(
			decideSchemaOverloadBreaker({
				consecutive: cap,
				cap,
				previousFields: ["/a", "/b"],
				currentFields: ["/a"],
				narrowedRetryGranted: false,
			}),
		).toEqual({ trip: false, grantNarrowedRetry: true });
	});

	it("grants one narrowed retry when missing fields rotate at the cap", () => {
		expect(
			decideSchemaOverloadBreaker({
				consecutive: cap,
				cap,
				previousFields: ["/modified"],
				currentFields: ["/sliceId"],
				narrowedRetryGranted: false,
			}),
		).toEqual({ trip: false, grantNarrowedRetry: true });
	});

	it("trips at the cap when the field set is not shrinking", () => {
		expect(
			decideSchemaOverloadBreaker({
				consecutive: cap,
				cap,
				previousFields: ["/a", "/b"],
				currentFields: ["/a", "/b"],
				narrowedRetryGranted: false,
			}),
		).toEqual({ trip: true, grantNarrowedRetry: false });
	});

	it("trips at the cap when current fields are empty", () => {
		expect(
			decideSchemaOverloadBreaker({
				consecutive: cap,
				cap,
				previousFields: ["/a"],
				currentFields: [],
				narrowedRetryGranted: false,
			}),
		).toEqual({ trip: true, grantNarrowedRetry: false });
	});

	it("trips after the narrowed retry even if still shrinking", () => {
		expect(
			decideSchemaOverloadBreaker({
				consecutive: cap,
				cap,
				previousFields: ["/a", "/b"],
				currentFields: ["/a"],
				narrowedRetryGranted: true,
			}),
		).toEqual({ trip: true, grantNarrowedRetry: false });
	});

	it("trips after the rotating retry even if fields still rotate", () => {
		expect(
			decideSchemaOverloadBreaker({
				consecutive: cap,
				cap,
				previousFields: ["/modified"],
				currentFields: ["/sliceId"],
				narrowedRetryGranted: true,
			}),
		).toEqual({ trip: true, grantNarrowedRetry: false });
	});

	it("collects fields across multiple tool errors and names them in the retry instruction", () => {
		const fields = collectValidationErrorFields([
			"  - /milestoneId: Expected string\n",
			"  - /sliceId: Expected string\n",
		]);
		expect(fields).toEqual(["/milestoneId", "/sliceId"]);
		expect(narrowedSchemaRetryInstruction(fields)).toMatch(/minimal diff/);
		expect(narrowedSchemaRetryInstruction(fields)).toMatch(/\/milestoneId/);
	});
});
