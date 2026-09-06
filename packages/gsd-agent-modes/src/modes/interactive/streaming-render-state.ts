import type { Markdown, TUI } from "@gsd/pi-tui";

import type { AssistantMessageComponent } from "./components/assistant-message.js";
import type { DynamicBorder } from "./components/dynamic-border.js";
import {
	ToolExecutionComponent,
	ToolPhaseSummaryComponent,
	type ToolExecutionPhase,
} from "./components/tool-execution.js";

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

	resetStreamingSegments(): void {
		this.lastProcessedContentIndex = 0;
		this.lastContentLength = 0;
		this.renderedSegments = [];
		this.orphanedSegments = [];
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
	 * Request an immediate render at stream boundaries (message_end, agent_end)
	 * so the final state paints without any delay.
	 */
	flushPendingStreamingWork(ui: TUI): void {
		// Not forced: force-realigning the viewport here would break the
		// "no force-render when pinned zone was never shown" contract.
		ui.requestRender();
	}
}

export function createStreamingRenderState(): StreamingRenderState {
	return new StreamingRenderState();
}
