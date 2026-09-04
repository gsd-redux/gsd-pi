// Project/App: gsd-pi
// File Purpose: Sidebar webview section collapse-state restoration, shared by the
// inline webview script and unit tests (issue #2150).

/**
 * A minimal structural view of a webview `.section` element (DOM-compatible).
 */
export interface CollapsibleSection {
	dataset: { section?: string };
	classList: {
		add(name: string): void;
		remove(name: string): void;
		contains(name: string): boolean;
	};
}

/**
 * Apply the persisted collapse state to each section in BOTH directions so a
 * stored "open" survives the periodic full re-render instead of deterministically
 * re-collapsing to the template default (issue #2150). Sections without a stored
 * entry keep their template default.
 */
export function applySectionCollapseState(
	sections: Iterable<CollapsibleSection>,
	stored: Record<string, string>,
): void {
	for (const section of sections) {
		const id = section.dataset.section;
		if (!id) {
			continue;
		}
		if (stored[id] === "collapsed") {
			section.classList.add("collapsed");
		} else if (stored[id] === "open") {
			section.classList.remove("collapsed");
		}
	}
}
