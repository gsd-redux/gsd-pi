import type { Markdown, TUI } from "@gsd/pi-tui";

import type { AssistantMessageComponent } from "./components/assistant-message.js";
import type { DynamicBorder } from "./components/dynamic-border.js";
import {
	ToolExecutionComponent,
	ToolPhaseSummaryComponent,
	type ToolExecutionPhase,
} from "./components/tool-execution.js";

/** Default debounce delay for streaming work batching (ms). */
const STREAM_RENDER_DEBOUNCE_MS = 50;

/** Cache for buildDesiredSegmentsForMessage — avoids O(n) block iteration during streaming. */
export interface DesiredSegmentsCache {
	count: number;
	hideThinkingBlock: boolean;
	segments: DesiredSegment[];
}

/** Per streaming assistant turn — text runs, tools, and rollup summaries. */
export type RenderedSegment =
	| {
			kind: "text-run";
			startIndex: number;
			endIndex: number;
			contentType: "text" | "thinking";
			component: AssistantMessageComponent;
			/** Snapshot for redundant sub-turn detection after content[] shrinks. */
			cachedText?: string;
			/** Cached text length — fast O(1) comparison to avoid string allocation. */
			cachedTextLength?: number;
	  }
	| { kind: "tool"; contentIndex: number; component: ToolExecutionComponent }
	| { kind: "tool-summary"; component: ToolPhaseSummaryComponent; phases: ToolExecutionPhase[] };

export type DesiredSegment =
	| { kind: "text-run"; startIndex: number; endIndex: number; contentType: "text" | "thinking" }
	| { kind: "tool"; contentIndex: number; toolId: string };

export type ToolRegistrationSource = "content" | "standalone";

/**
 * Per InteractiveMode instance: streaming transcript walker + pinned message zone.
 * Replaces module-level globals in chat-controller.ts.
 */
export class StreamingRenderState {
	lastProcessedContentIndex = 0;
	lastContentLength = 0;
	renderedSegments: RenderedSegment[] = [];
	/** Displaced segments when provider sub-turn shrinks content[] mid-lifecycle. */
	orphanedSegments: RenderedSegment[] = [];
	readonly toolRegistrationSources = new WeakMap<ToolExecutionComponent, Set<ToolRegistrationSource>>();

	lastPinnedText = "";
	hasToolsInTurn = false;
	pinnedBorder: DynamicBorder | undefined;
	pinnedTextComponent: Markdown | undefined;
	pinnedZoneNeedsViewportRealign = false;

	/** Cache for buildDesiredSegmentsForMessage — avoids O(n) block iteration during streaming. */
	_desiredSegmentsCache?: DesiredSegmentsCache;

	/** Debounce timer for batching streaming render requests. */
	renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	resetStreamingSegments(): void {
		this.lastProcessedContentIndex = 0;
		this.lastContentLength = 0;
		this.renderedSegments = [];
		this.orphanedSegments = [];
		// Cancel any pending debounced render when the stream ends
		this.cancelDebouncedRender();
	}

	resetPinnedZone(): void {
		if (this.pinnedBorder) {
			this.pinnedBorder.stopSpinner();
		}
		this.pinnedBorder = undefined;
		this.pinnedTextComponent = undefined;
		this.lastPinnedText = "";
		this.hasToolsInTurn = false;
		this.pinnedZoneNeedsViewportRealign = false;
	}

	resetForNewAssistantMessage(): void {
		this.resetStreamingSegments();
		this.resetPinnedZone();
	}

	resetForSessionChange(): void {
		this.resetForNewAssistantMessage();
	}

	/**
	 * Schedule a debounced render request.
	 *
	 * During active streaming, multiple message_update events fire rapidly.
	 * The segment walker and pinned-zone update still run synchronously on
	 * each update (their internal caches keep them cheap, and sub-turn
	 * replacement/suppression logic depends on seeing each intermediate
	 * state) — but the actual render is batched into one request per
	 * debounce window, which is where the CPU churn lives.
	 */
	scheduleDebouncedRender(ui: TUI): void {
		if (this.renderDebounceTimer) {
			clearTimeout(this.renderDebounceTimer);
		}
		this.renderDebounceTimer = setTimeout(() => {
			this.renderDebounceTimer = null;
			ui.requestRender();
		}, STREAM_RENDER_DEBOUNCE_MS);
	}

	/**
	 * Cancel any pending debounced render and request one immediately.
	 * Call this at stream boundaries (message_end, agent_end) so the final
	 * state paints without waiting out the debounce window.
	 */
	flushPendingStreamingWork(ui: TUI): void {
		this.cancelDebouncedRender();
		// Not forced: force-realigning the viewport here would break the
		// "no force-render when pinned zone was never shown" contract.
		ui.requestRender();
	}

	/** Cancel any pending debounced render (call at stream end). */
	cancelDebouncedRender(): void {
		if (this.renderDebounceTimer) {
			clearTimeout(this.renderDebounceTimer);
			this.renderDebounceTimer = null;
		}
	}
}

export function createStreamingRenderState(): StreamingRenderState {
	return new StreamingRenderState();
}
