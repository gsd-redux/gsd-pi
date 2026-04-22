// GSD2 — Tests for Pi Ai Event Stream Factory
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@gsd/pi-ai";

describe("@gsd/pi-ai event stream exports", () => {
	it("exports createAssistantMessageEventStream for package consumers", () => {
		assert.equal(typeof createAssistantMessageEventStream, "function");
		const stream = createAssistantMessageEventStream();
		assert.ok(stream instanceof AssistantMessageEventStream);
	});
});
