import type { Markdown, TUI } from "@gsd/pi-tui";

import type { AssistantMessageComponent } from "./components/assistant-message.js";
import type { DynamicBorder } from "./components/dynamic-border.js";
import type { TimestampFormat } from "./components/timestamp.js";
import {
	ToolExecutionComponent,
	ToolPhaseSummaryComponent,
	type ToolExecutionPhase,
} from "./components/tool-execution.js";
import { runSegmentWalker } from "./controllers/chat-segment-walker.js";
import { updatePinnedMessageZone } from "./controllers/chat-pinned-zone.js";

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

	/** Debounce timer for batching streaming work (segment walker + pinned zone + render). */
	renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** Pending streaming work: host reference + content blocks for deferred execution. */
	_pendingStreamingArgs: {
		host: any;
		timestampFormat: TimestampFormat;
		contentBlocks: Array<any>;
	} | null = null;

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
	 * Accumulate streaming work and schedule a debounced batch execution.
	 *
	 * During active streaming, multiple message_update events fire rapidly.
	 * This batches runSegmentWalker + updatePinnedMessageZone + requestRender
	 * into a single execution window, reducing CPU churn by ~50x.
	 *
	 * IMPORTANT: This replaces the old pattern where runSegmentWalker and
	 * updatePinnedMessageZone were called synchronously on every message_update.
	 * Those functions are now deferred until the debounce fires.
	 */
	scheduleDebouncedStreamingWork(
		host: any,
		timestampFormat: TimestampFormat,
		contentBlocks: Array<any>,
	): void {
		// Accumulate the latest streaming work
		this._pendingStreamingArgs = { host, timestampFormat, contentBlocks };

		if (this.renderDebounceTimer) {
			clearTimeout(this.renderDebounceTimer);
		}
		this.renderDebounceTimer = setTimeout(() => {
			this.renderDebounceTimer = null;
			// Execute all accumulated work in one batch
			const args = this._pendingStreamingArgs;
			this._pendingStreamingArgs = null;
			if (args) {
				// Run segment walker + pinned zone + render in one batch
				runSegmentWalker(args.host, this, args.timestampFormat);
				updatePinnedMessageZone(args.host, this, args.contentBlocks);
				args.host.ui.requestRender();
			}
		}, STREAM_RENDER_DEBOUNCE_MS);
	}

	/**
	 * Flush pending streaming work immediately + force render.
	 * Call this at stream boundaries (message_end, agent_end).
	 */
	flushPendingStreamingWork(ui: TUI): void {
		this.cancelDebouncedRender();
		// Execute any pending work immediately
		const args = this._pendingStreamingArgs;
		this._pendingStreamingArgs = null;
		if (args) {
			runSegmentWalker(args.host, this, args.timestampFormat);
			updatePinnedMessageZone(args.host, this, args.contentBlocks);
		}
		ui.requestRender(true); // force = true for final flush
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
