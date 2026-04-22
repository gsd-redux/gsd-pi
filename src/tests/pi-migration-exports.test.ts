// GSD2 — GSD-2 — Regression test for pi-migration.ts public exports consumed by cli.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import * as piMigration from "../pi-migration.js";

test("pi-migration exports getPiDefaultModelAndProvider for cli.ts fallback-model resolution", () => {
	assert.equal(
		typeof piMigration.getPiDefaultModelAndProvider,
		"function",
		"cli.ts validateConfiguredModel relies on this export to pick a fallback model",
	);
});

test("pi-migration exports migratePiCredentials for cli.ts startup migration", () => {
	assert.equal(typeof piMigration.migratePiCredentials, "function");
});
