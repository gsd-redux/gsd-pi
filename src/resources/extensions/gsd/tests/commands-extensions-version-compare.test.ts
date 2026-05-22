// GSD2 — Regression test for Issue #4946 isVersionGreater (commands-extensions.ts)
//
// Covers the inline npm-version comparator that replaced the `semver` import in
// commands-extensions.ts. The original import broke `tsc -p tsconfig.json` whenever
// `@types/semver` failed to install — the file is type-checked transitively despite
// being under the `src/resources` exclude. The replacement keeps the same comparison
// semantics for the realistic input space (npm extension version strings) without
// pulling in the full semver type surface.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { isVersionGreater } from "../commands-extensions.ts";

describe("isVersionGreater — npm extension version comparison (#4946)", () => {
	test("strictly greater patch beats lesser patch", () => {
		assert.equal(isVersionGreater("1.2.4", "1.2.3"), true);
		assert.equal(isVersionGreater("1.2.3", "1.2.4"), false);
	});

	test("equal versions are not strictly greater", () => {
		assert.equal(isVersionGreater("1.2.3", "1.2.3"), false);
	});

	test("numeric (not lexicographic) component comparison", () => {
		// Lexicographic compare would say "1.10.0" < "1.9.0".
		assert.equal(isVersionGreater("1.10.0", "1.9.0"), true);
		assert.equal(isVersionGreater("1.9.0", "1.10.0"), false);
	});

	test("major bump beats minor and patch differences", () => {
		assert.equal(isVersionGreater("2.0.0", "1.99.99"), true);
		assert.equal(isVersionGreater("1.99.99", "2.0.0"), false);
	});

	test("missing trailing components default to zero", () => {
		assert.equal(isVersionGreater("1.2", "1.1.9"), true);
		assert.equal(isVersionGreater("1", "0.9.9"), true);
		assert.equal(isVersionGreater("1.2", "1.2.0"), false);
	});

	test("release version beats prerelease at the same release number", () => {
		assert.equal(isVersionGreater("1.0.0", "1.0.0-beta.1"), true);
		assert.equal(isVersionGreater("1.0.0-beta.1", "1.0.0"), false);
	});

	test("prerelease ordering: beta.2 > beta.1, rc.1 > beta.9", () => {
		assert.equal(isVersionGreater("1.0.0-beta.2", "1.0.0-beta.1"), true);
		assert.equal(isVersionGreater("1.0.0-rc.1", "1.0.0-beta.9"), true);
	});

	test("non-numeric junk in components doesn't crash — coerces to 0", () => {
		// Defensive: we don't throw on garbage input; we treat unparseable
		// components as 0. This matches the behaviour the extension installer
		// can rely on without surfacing an error to the user.
		assert.equal(isVersionGreater("1.x.0", "1.0.0"), false);
		assert.equal(isVersionGreater("abc", "0.0.1"), false);
	});
});
