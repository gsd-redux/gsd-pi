import { describe, expect, it } from "vitest";
import { getApiProvider } from "../src/api-registry.ts";
import { resetApiProviders } from "../src/providers/register-builtins.ts";

describe("anthropic-vertex provider", () => {
	it("registers anthropic-vertex as a built-in API provider", () => {
		resetApiProviders();

		const provider = getApiProvider("anthropic-vertex");

		expect(provider).toBeDefined();
		expect(provider?.api).toBe("anthropic-vertex");
	});
});
