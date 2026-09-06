// Project/App: gsd-pi
// File Purpose: Verifies sidebar webview section collapse-state restoration (issue #2150).

import test from "node:test";
import assert from "node:assert/strict";
import { applySectionCollapseState, type CollapsibleSection } from "../src/section-state.ts";

/** Minimal stand-in for a webview `.section` element — no DOM required. */
function makeSection(id: string | undefined, initialClasses: string[] = []): CollapsibleSection {
	const classes = new Set(initialClasses);
	return {
		dataset: { section: id },
		classList: {
			add: (name) => classes.add(name),
			remove: (name) => classes.delete(name),
			contains: (name) => classes.has(name),
		},
	};
}

test("stored 'open' state removes the collapsed class even when the section is default-collapsed", () => {
	const settings = makeSection("settings", ["section", "collapsed"]);

	applySectionCollapseState([settings], { settings: "open" });

	assert.equal(settings.classList.contains("collapsed"), false);
});

test("stored 'collapsed' state adds the collapsed class to a default-open section", () => {
	const workflow = makeSection("workflow", ["section"]);

	applySectionCollapseState([workflow], { workflow: "collapsed" });

	assert.equal(workflow.classList.contains("collapsed"), true);
});

test("sections without a stored entry keep their template default", () => {
	const settings = makeSection("settings", ["section", "collapsed"]);
	const workflow = makeSection("workflow", ["section"]);

	applySectionCollapseState([settings, workflow], {});

	assert.equal(settings.classList.contains("collapsed"), true);
	assert.equal(workflow.classList.contains("collapsed"), false);
});

test("unknown ids and sections without a data-section id are ignored", () => {
	const untagged = makeSection(undefined, ["section", "collapsed"]);
	const known = makeSection("actions", ["section", "collapsed"]);

	applySectionCollapseState([untagged, known], {
		removedSection: "collapsed",
		actions: "unexpected-value",
	});

	// Sections start collapsed here on purpose: a broken implementation that
	// strips "collapsed" for unknown ids/values must fail this test.
	assert.equal(untagged.classList.contains("collapsed"), true);
	assert.equal(known.classList.contains("collapsed"), true);
});
