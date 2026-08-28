// Project/App: gsd-pi
// File Purpose: GSD-W017 — non-blocking notifications for cheaper/better
// same-tier GitHub Copilot alternatives, triggered by manual model
// selection or a completed GSD-W018 session-start catalog refresh.
//
// Never fires for automatic/dynamic routing selections: those never emit the
// `model_select` event this module is wired to (auto-mode applies models
// directly through the model registry, not through the interactive
// set/cycle/restore selection path). Never switches the model automatically
// — purely advisory, deduplicated by a fingerprint of (account scope,
// selected model, suggested model, catalog revision) so a stable pairing is
// only ever announced once until something material changes.

import { createHash } from "node:crypto";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { findCheaperSameTierOption, type CheaperSameTierSuggestion } from "./commands/handlers/copilot-models.js";
import type { CopilotModelSnapshot } from "./copilot-model-catalog.js";
import { canonicalizeModelId, MODEL_CAPABILITY_PROFILES, type ModelCapabilities } from "./model-router.js";

// Session-scoped only — never persisted to disk, mirrors the existing
// per-account notification dedup pattern in commands/handlers/copilot-models.ts.
const notifiedFingerprints = new Set<string>();

/** Test-only hook to reset module-level session state between test cases. */
export function _resetCopilotCatalogNotificationStateForTests(): void {
	notifiedFingerprints.clear();
}

function bareModelId(modelId: string): string {
	return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
}

/** Average of the 7 capability dimensions. */
function averageCapabilityScore(profile: ModelCapabilities): number {
	const values = Object.values(profile);
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Pure comparison of two capability profiles. A small margin (avoids noise
 * from rounding-equivalent profiles) is required before calling the
 * candidate "higher" — anything else (including missing data) resolves to
 * "equal-or-lower", the safer default for messaging purposes.
 */
export function compareCapabilityScores(
	selected: ModelCapabilities | undefined,
	candidate: ModelCapabilities | undefined,
): "higher" | "equal-or-lower" {
	if (!selected || !candidate) return "equal-or-lower";
	return averageCapabilityScore(candidate) > averageCapabilityScore(selected) + 1 ? "higher" : "equal-or-lower";
}

function isHigherCapability(selectedBareId: string, candidateBareId: string): boolean {
	return (
		compareCapabilityScores(
			MODEL_CAPABILITY_PROFILES[canonicalizeModelId(selectedBareId)],
			MODEL_CAPABILITY_PROFILES[canonicalizeModelId(candidateBareId)],
		)
		=== "higher"
	);
}

function buildFingerprint(
	accountScope: string,
	selectedBareId: string,
	suggestion: CheaperSameTierSuggestion,
	snapshot: CopilotModelSnapshot | null,
): string {
	const revision = snapshot?.hash ?? "no-snapshot";
	return createHash("sha256")
		.update(`${accountScope}\n${selectedBareId}\ngithub-copilot/${suggestion.modelId}\n${revision}`)
		.digest("hex");
}

function formatNotificationMessage(
	selectedBareId: string,
	suggestion: CheaperSameTierSuggestion,
	higherCapability: boolean,
): string {
	const label = higherCapability ? "better, cheaper alternative" : "cheaper equivalent";
	return [
		`GitHub Copilot: a ${label} to github-copilot/${selectedBareId} is available — github-copilot/${suggestion.modelId}`,
		`(saves $${suggestion.inputSavings.toFixed(4)} input / $${suggestion.outputSavings.toFixed(4)} output per 1K).`,
		`The current model was not changed. Run /gsd copilot-models why github-copilot/${suggestion.modelId} for details.`,
	].join(" ");
}

export interface NotifyCheaperAlternativeOptions {
	ctx: ExtensionContext;
	/**
	 * Opaque scope key segmenting the dedup fingerprint. Uses the session's
	 * basePath (the same scoping unit GSD-W018's coordinator and
	 * register-hooks.ts already key state by) rather than re-deriving a
	 * per-account token hash purely for deduplication — within one GSD
	 * project session there is realistically one active Copilot account, and
	 * the worst case of a coarser scope is one redundant notification, never
	 * a wrong or fabricated one.
	 */
	accountScope: string;
	/** Provider of the currently selected/active model. Non-"github-copilot" providers are always a no-op. */
	selectedModelProvider: string | undefined;
	/** The currently selected/active GitHub Copilot model id (bare or provider-qualified). */
	selectedModelId: string;
	snapshot: CopilotModelSnapshot | null;
}

/**
 * Check whether the given (already-selected/active) GitHub Copilot model has
 * a qualifying cheaper or better-and-cheaper same-tier alternative, and fire
 * a deduplicated, non-blocking notification if so. Never mutates the active
 * model, routing state, or any persisted file. Returns true when a
 * notification was actually sent (false when no qualifying alternative
 * exists, or the exact pairing was already announced for this catalog
 * revision).
 */
export function maybeNotifyCheaperAlternative(options: NotifyCheaperAlternativeOptions): boolean {
	const { ctx, accountScope, selectedModelProvider, selectedModelId, snapshot } = options;
	if (selectedModelProvider !== "github-copilot") return false;
	const bareId = bareModelId(selectedModelId);

	const suggestion = findCheaperSameTierOption(bareId, ctx, snapshot);
	if (!suggestion) return false;

	const fingerprint = buildFingerprint(accountScope, bareId, suggestion, snapshot);
	if (notifiedFingerprints.has(fingerprint)) return false;
	notifiedFingerprints.add(fingerprint);

	const higherCapability = isHigherCapability(bareId, suggestion.modelId);
	ctx.ui.notify(formatNotificationMessage(bareId, suggestion, higherCapability), "info");
	return true;
}
