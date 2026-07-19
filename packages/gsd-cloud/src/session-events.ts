// Project/App: Open GSD
// File Purpose: Live session-event producer for the cloud runtime.
//
// While the runtime is connected to the gateway, poll `gsd_status` on each
// advertised project (through the per-project MCP stdio client behind the
// Executor seam) every 3 s and normalize the observed deltas into the
// `session_event` wire frames pinned by the v1.6 live-sessions spec:
//
//   { type: "session_event", runtimeId, projectAlias, sessionId, seq,
//     event: { kind, at, data } }
//
// Producer responsibilities:
// - map status/event deltas onto the fixed kind vocabulary (session_started,
//   turn_started, assistant_text, tool_call, tool_result, blocker_pending,
//   blocker_resolved, session_idle, session_ended, error, snapshot)
// - maintain a per-(runtimeId, sessionId) monotonic seq (starts at 1)
// - keep a replay buffer of the last 500 events per session; on reconnect a
//   bounded tail is re-sent and the relay dedupes via its unique
//   (device, session, seq) constraint
// - emit a `snapshot` every 30 s per active session so late-joining consumers
//   can reconcile
// - enforce bounds: 8 KB per serialized event (string fields are truncated to
//   their per-field caps; frames still oversized after truncation are skipped
//   and logged) and 20 concurrent tracked sessions per runtime (beyond that,
//   skip and log)

import type { Logger } from "./logger.js";
import type { AdvertisedProject } from "./executors/executor.js";

export type SessionEventKind =
  | "session_started"
  | "turn_started"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "blocker_pending"
  | "blocker_resolved"
  | "session_idle"
  | "session_ended"
  | "error"
  | "snapshot";

export interface SessionEventFrame {
  type: "session_event";
  runtimeId: string;
  projectAlias: string | null;
  sessionId: string;
  seq: number;
  event: {
    kind: SessionEventKind;
    at: string;
    data: Record<string, unknown>;
  };
}

/** Raw MCP tool result shape returned by the Executor seam. */
interface McpToolResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: unknown }>;
}

/** Normalized subset of the `gsd_status` payload the producer diffs on. */
interface StatusPayload {
  sessionId: string;
  status: string;
  eventCount: number;
  recentEvents: Array<Record<string, unknown>>;
  pendingBlocker: { id: string; message: string; options?: string[] } | null;
  title?: string;
  model?: string;
  errorMessage?: string;
}

/**
 * Poll `gsd_status` for one advertised project and return the raw MCP tool
 * result. When `sessionId` is given, the poll targets that session directly.
 */
export type SessionStatusPoll = (
  project: AdvertisedProject,
  sessionId?: string,
) => Promise<unknown>;

export interface SessionEventProducerOptions {
  runtimeId: string;
  /** Advertised projects to poll — re-read every cycle so re-hellos apply. */
  projects: () => AdvertisedProject[];
  poll: SessionStatusPoll;
  /** Deliver a frame to the gateway (CloudRuntime's bounded outbox send). */
  send: (frame: SessionEventFrame, projectPath?: string) => void;
  logger: Logger;
  /** Master switch — when false, start() is a no-op. Default true. */
  enabled?: boolean;
  pollIntervalMs?: number;
  snapshotIntervalMs?: number;
  maxSessions?: number;
  replayBufferSize?: number;
  /** Frames per session re-sent on (re)connect; bounded to stay well under the
   * relay's per-connection session_event rate limit. */
  replayOnConnectMax?: number;
  maxEventBytes?: number;
  /** How long an ended session stays tracked so a server that keeps returning
   * it does not trigger a session_started/session_ended flap. */
  endedTtlMs?: number;
  now?: () => number;
}

interface TrackedSession {
  sessionId: string;
  projectAlias: string | null;
  projectPath: string;
  seq: number;
  replay: SessionEventFrame[];
  lastEventCount: number;
  lastStatus: string;
  pendingBlockerId: string | null;
  openTools: Map<string, string>;
  turnCounter: number;
  hadActivity: boolean;
  lastSnapshotAt: number;
  ended: boolean;
  endedAt: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_REPLAY_BUFFER_SIZE = 500;
const DEFAULT_REPLAY_ON_CONNECT_MAX = 100;
const DEFAULT_MAX_EVENT_BYTES = 8 * 1024;
const DEFAULT_ENDED_TTL_MS = 10 * 60_000;

// Per-field caps pinned by the spec ("max 8 KB per event after JSON
// serialization, truncate strings").
const CAP_ASSISTANT_TEXT = 2_000;
const CAP_SUMMARY = 500;
const CAP_MESSAGE = 500;
const CAP_ID = 200;
const CAP_OPTION = 200;
const CAP_OPTIONS_MAX = 10;

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "error"]);

export class SessionEventProducer {
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly snapshotIntervalMs: number;
  private readonly maxSessions: number;
  private readonly replayBufferSize: number;
  private readonly replayOnConnectMax: number;
  private readonly maxEventBytes: number;
  private readonly endedTtlMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly skippedBound = new Set<string>();
  private readonly reportedPollFailure = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  // Bumped on every stopPolling(); an in-flight poll cycle compares its
  // captured generation and abandons work (including logging) once stale, so a
  // poll that outlives a shutdown cannot write into a closed logger or send
  // on behalf of a dead connection.
  private generation = 0;

  constructor(private readonly deps: SessionEventProducerOptions) {
    this.enabled = deps.enabled ?? true;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.replayBufferSize = deps.replayBufferSize ?? DEFAULT_REPLAY_BUFFER_SIZE;
    this.replayOnConnectMax = deps.replayOnConnectMax ?? DEFAULT_REPLAY_ON_CONNECT_MAX;
    this.maxEventBytes = deps.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.endedTtlMs = deps.endedTtlMs ?? DEFAULT_ENDED_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Begin producing. Idempotent. Re-sends a bounded tail of each active
   * session's replay buffer first — after a reconnect the relay dedupes those
   * frames via its unique (device, session, seq) constraint.
   */
  start(): void {
    if (!this.enabled || this.timer) return;
    this.replayBuffered();
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    void this.pollOnce();
  }

  /**
   * Stop the polling loop. Session state (seq counters, replay buffers) is
   * kept so a later start() resumes rather than restarts the stream.
   */
  stopPolling(): void {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one poll cycle across all advertised projects. Overlap-safe and never
   * rejects: a poll cycle runs unattended on a timer, so every failure is
   * contained here (logged) instead of surfacing as an unhandled rejection. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const generation = this.generation;
    try {
      for (const project of this.deps.projects()) {
        if (generation !== this.generation) return;
        await this.pollProject(project, generation);
      }
      this.pruneEnded();
    } catch (err) {
      this.logIfCurrent(generation, "session events: poll cycle failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.polling = false;
    }
  }

  private logIfCurrent(generation: number, message: string, data: Record<string, unknown>): void {
    if (generation !== this.generation) return;
    this.deps.logger.warn(message, data);
  }

  private async pollProject(project: AdvertisedProject, generation: number): Promise<void> {
    let payloads: StatusPayload[];
    try {
      payloads = await this.enumerate(project, generation);
    } catch (err) {
      // Enumeration failed (MCP child down, timeout, …). Do not diff against a
      // missing view — sessions would look "vanished" and end spuriously.
      this.logIfCurrent(generation, "session events: status poll failed", {
        project: project.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (generation !== this.generation) return;

    const seen = new Set<string>();
    for (const payload of payloads) {
      if (!payload.sessionId) continue;
      seen.add(payload.sessionId);
      const tracked = this.track(project, payload);
      if (!tracked) continue; // beyond the concurrent-session bound
      this.applyPayload(tracked, payload);
    }

    // A session the server no longer returns (and never reported a terminal
    // status for) is over — close the stream so consumers are not left waiting.
    for (const tracked of this.sessions.values()) {
      if (tracked.projectPath !== project.path || tracked.ended) continue;
      if (!seen.has(tracked.sessionId)) {
        this.emit(tracked, "session_ended", { reason: "completed" });
        this.markEnded(tracked);
      }
    }
  }

  /**
   * List the sessions a project's MCP server currently tracks. The common
   * case is zero or one session per project; when the server tracks several,
   * gsd_status answers with an ambiguity hint that names each sessionId, so
   * parse it and poll each session explicitly.
   */
  private async enumerate(project: AdvertisedProject, generation: number): Promise<StatusPayload[]> {
    const first = readStatusResult(await this.deps.poll(project));
    if (first.payload) return [first.payload];
    const text = first.errorText ?? "";
    if (text.startsWith("No tracked GSD sessions") || text.startsWith("Session not found")) {
      return [];
    }
    if (!text.includes("Multiple tracked GSD sessions")) {
      throw new Error(text || "unexpected gsd_status result");
    }
    const sessionIds = parseTrackedSessionHints(text);
    const payloads: StatusPayload[] = [];
    for (const sessionId of sessionIds) {
      // A multi-session enumeration awaits one poll per session; if polling was
      // stopped mid-enumeration, abandon the rest so we do not keep probing or
      // mutating state on behalf of a dead connection.
      if (generation !== this.generation) break;
      const key = sessionKey(project.path, sessionId);
      try {
        const result = readStatusResult(await this.deps.poll(project, sessionId));
        if (result.payload) {
          payloads.push(result.payload);
          this.reportedPollFailure.delete(key);
        } else this.pollFailure(key, sessionId, result.errorText ?? "unexpected gsd_status result", generation);
      } catch (err) {
        this.pollFailure(key, sessionId, err instanceof Error ? err.message : String(err), generation);
      }
    }
    return payloads;
  }

  /** Surface a per-session poll failure as an `error` event (session known). */
  private pollFailure(key: string, sessionId: string, message: string, generation: number): void {
    // The poll for this session may have straddled a stopPolling(): if the
    // generation moved on, do not emit (or mark) — a stale error frame must not
    // land on the next connection with a fresh seq after reconnect.
    if (generation !== this.generation) return;
    if (message.startsWith("Session not found")) return; // vanish is handled by the diff
    const tracked = this.sessions.get(key);
    if (!tracked || tracked.ended) return;
    if (this.reportedPollFailure.has(key)) return;
    this.reportedPollFailure.add(key);
    this.emit(tracked, "error", { message: truncate(message, CAP_MESSAGE) });
  }

  private track(project: AdvertisedProject, payload: StatusPayload): TrackedSession | undefined {
    const key = sessionKey(project.path, payload.sessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      // An ended entry lingers briefly so a server that keeps returning a
      // finished session does not cause a session_started/session_ended flap.
      // But if the same sessionId is reported active again (reused/resumed after
      // a new gsd_execute), revive the entry in place so a fresh session_started
      // and its deltas flow immediately instead of being suppressed until the
      // TTL prune. seq and the replay buffer are kept so the monotonic
      // (device, session, seq) stream the relay dedupes on is not restarted.
      if (existing.ended && !TERMINAL_STATUSES.has(payload.status)) {
        existing.ended = false;
        existing.endedAt = 0;
        existing.lastEventCount = payload.eventCount;
        existing.lastStatus = "";
        existing.pendingBlockerId = null;
        existing.openTools.clear();
        existing.turnCounter = 0;
        existing.hadActivity = false;
        existing.lastSnapshotAt = this.now();
        // The revived session is a fresh lifetime: allow a new poll-failure
        // error to be reported again for it.
        this.reportedPollFailure.delete(key);
        this.emitSessionStarted(existing, payload);
      }
      return existing;
    }

    if (this.activeSessionCount() >= this.maxSessions) {
      if (!this.skippedBound.has(key)) {
        this.skippedBound.add(key);
        this.deps.logger.warn("session events: concurrent session bound reached; skipping session", {
          sessionId: payload.sessionId,
          project: project.path,
          maxSessions: this.maxSessions,
        });
      }
      return undefined;
    }

    const tracked: TrackedSession = {
      sessionId: payload.sessionId,
      projectAlias: project.alias,
      projectPath: project.path,
      seq: 0,
      replay: [],
      // Baseline: events that happened before the first observation are not
      // replayed; the delta cursor starts at the current count. lastStatus
      // stays empty so a session first observed in a terminal status still
      // emits session_ended on its first applyPayload.
      lastEventCount: payload.eventCount,
      lastStatus: "",
      pendingBlockerId: null,
      openTools: new Map(),
      turnCounter: 0,
      hadActivity: false,
      lastSnapshotAt: this.now(),
      ended: false,
      endedAt: 0,
    };
    this.sessions.set(key, tracked);
    this.emitSessionStarted(tracked, payload);
    return tracked;
  }

  /** Emit the session_started frame, carrying title/model when the server
   * reports them. Shared by first-observation tracking and session revival. */
  private emitSessionStarted(tracked: TrackedSession, payload: StatusPayload): void {
    const data: Record<string, unknown> = {};
    if (payload.title) data.title = payload.title;
    if (payload.model) data.model = payload.model;
    this.emit(tracked, "session_started", data);
  }

  private applyPayload(tracked: TrackedSession, payload: StatusPayload): void {
    if (tracked.ended) return;
    let emitted = false;

    // --- event deltas (chronological order) ---
    // When more events elapsed between polls than the server's recentEvents
    // window holds, the overflow is unrecoverable: gsd_status only returns a
    // bounded tail and cannot page further back. Emit the visible tail once and
    // advance the cursor to the server count so later polls never re-emit an
    // overlapping window (that would surface as duplicate events under fresh
    // seqs, which the relay's (device, session, seq) dedupe cannot catch). Log
    // the gap so the loss is observable instead of silent.
    const gap = payload.eventCount - tracked.lastEventCount - payload.recentEvents.length;
    if (gap > 0) {
      this.deps.logger.warn("session events: event window overflow; older events skipped", {
        sessionId: tracked.sessionId,
        skipped: gap,
        windowSize: payload.recentEvents.length,
      });
    }
    for (const raw of deltaEvents(tracked, payload)) {
      emitted = this.mapRawEvent(tracked, raw) || emitted;
    }
    tracked.lastEventCount = payload.eventCount;

    // --- blocker transitions ---
    const blocker = payload.pendingBlocker;
    if (blocker && tracked.pendingBlockerId !== blocker.id) {
      const data: Record<string, unknown> = {
        blockerId: truncate(blocker.id, CAP_ID),
        question: truncate(blocker.message, CAP_MESSAGE),
      };
      if (blocker.options?.length) {
        data.options = blocker.options.slice(0, CAP_OPTIONS_MAX).map((option) => truncate(option, CAP_OPTION));
      }
      if (this.emit(tracked, "blocker_pending", data)) {
        tracked.pendingBlockerId = blocker.id;
        emitted = true;
      }
    } else if (!blocker && tracked.pendingBlockerId !== null) {
      const blockerId = tracked.pendingBlockerId;
      if (this.emit(tracked, "blocker_resolved", { blockerId })) {
        tracked.pendingBlockerId = null;
        emitted = true;
      }
    }

    // --- terminal status transitions ---
    if (payload.status !== tracked.lastStatus && TERMINAL_STATUSES.has(payload.status)) {
      if (payload.status === "error") {
        this.emit(tracked, "error", { message: truncate(payload.errorMessage ?? "session entered error state", CAP_MESSAGE) });
      }
      this.emit(tracked, "session_ended", { reason: payload.status });
      this.markEnded(tracked);
      return;
    }
    tracked.lastStatus = payload.status;

    // --- idle edge: the session went quiet after activity ---
    if (emitted) {
      tracked.hadActivity = true;
    } else if (tracked.hadActivity && payload.status === "running" && tracked.pendingBlockerId === null) {
      this.emit(tracked, "session_idle", {});
      tracked.hadActivity = false;
    }

    // --- periodic snapshot for late-joining consumers ---
    if (this.now() - tracked.lastSnapshotAt >= this.snapshotIntervalMs) {
      const data: Record<string, unknown> = {
        status: payload.status,
        // lastSeq is the seq this very frame will carry — the high-water mark.
        lastSeq: tracked.seq + 1,
      };
      const activeTool = [...tracked.openTools.values()].pop();
      if (activeTool) data.activeTool = activeTool;
      if (tracked.pendingBlockerId !== null) data.pendingBlockerId = tracked.pendingBlockerId;
      this.emit(tracked, "snapshot", data);
      tracked.lastSnapshotAt = this.now();
    }
  }

  /** Map one raw agent event onto the wire vocabulary. Returns true when a frame was emitted. */
  private mapRawEvent(tracked: TrackedSession, raw: Record<string, unknown>): boolean {
    const type = typeof raw.type === "string" ? raw.type : "";
    switch (type) {
      case "turn_start": {
        const turn = typeof raw.turnIndex === "number" ? raw.turnIndex
          : typeof raw.turn === "number" ? raw.turn
          : tracked.turnCounter;
        tracked.turnCounter = Math.max(tracked.turnCounter, turn + 1);
        this.emit(tracked, "turn_started", { turn });
        return true;
      }
      case "message_end": {
        const message = raw.message as Record<string, unknown> | undefined;
        if (!message || message.role !== "assistant") return false;
        const text = extractText(message.content);
        if (!text) return false;
        this.emit(tracked, "assistant_text", { text: truncate(text, CAP_ASSISTANT_TEXT) });
        return true;
      }
      case "tool_execution_start":
      case "tool_use": {
        const name = stringField(raw.toolName) ?? stringField(raw.name) ?? "unknown";
        const toolCallId = stringField(raw.toolCallId);
        if (toolCallId) tracked.openTools.set(toolCallId, name);
        this.emit(tracked, "tool_call", {
          name,
          summary: truncate(summarize(raw.args), CAP_SUMMARY),
        });
        return true;
      }
      case "tool_execution_end": {
        const name = stringField(raw.toolName) ?? stringField(raw.name) ?? "unknown";
        const toolCallId = stringField(raw.toolCallId);
        if (toolCallId) tracked.openTools.delete(toolCallId);
        this.emit(tracked, "tool_result", {
          name,
          ok: raw.isError !== true,
          summary: truncate(summarizeResult(raw.result), CAP_SUMMARY),
        });
        return true;
      }
      default:
        // agent_start/agent_end, message_start/update, turn_end, cost_update,
        // extension_ui_request (surfaced via pendingBlocker), … are not part of
        // the wire vocabulary.
        return false;
    }
  }

  private emit(tracked: TrackedSession, kind: SessionEventKind, data: Record<string, unknown>): boolean {
    const frame: SessionEventFrame = {
      type: "session_event",
      runtimeId: this.deps.runtimeId,
      projectAlias: tracked.projectAlias,
      sessionId: tracked.sessionId,
      seq: tracked.seq + 1,
      event: { kind, at: new Date(this.now()).toISOString(), data },
    };
    const sized = this.enforceFrameSize(frame);
    if (!sized) {
      this.deps.logger.warn("session events: dropping oversized frame", {
        sessionId: tracked.sessionId,
        kind,
        maxEventBytes: this.maxEventBytes,
      });
      return false; // do not burn the seq — consumers never see a gap from us
    }
    tracked.seq = sized.seq;
    tracked.replay.push(sized);
    if (tracked.replay.length > this.replayBufferSize) {
      tracked.replay.splice(0, tracked.replay.length - this.replayBufferSize);
    }
    this.deps.send(sized, tracked.projectPath);
    return true;
  }

  /**
   * Enforce the 8 KB serialized-event bound. Per-field caps make this a safety
   * net: progressively halve the longest string fields until the frame fits,
   * or give up (returns undefined → caller skips and logs).
   */
  private enforceFrameSize(frame: SessionEventFrame): SessionEventFrame | undefined {
    let current = frame;
    for (let attempts = 0; attempts < 8; attempts += 1) {
      if (Buffer.byteLength(JSON.stringify(current)) <= this.maxEventBytes) return current;
      const data = current.event.data;
      let longestKey: string | undefined;
      let longest = 0;
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string" && value.length > longest) {
          longest = value.length;
          longestKey = key;
        }
      }
      if (!longestKey || longest === 0) return undefined;
      current = {
        ...current,
        event: {
          ...current.event,
          data: { ...data, [longestKey]: (data[longestKey] as string).slice(0, Math.floor(longest / 2)) },
        },
      };
    }
    return undefined;
  }

  private markEnded(tracked: TrackedSession): void {
    tracked.ended = true;
    tracked.endedAt = this.now();
    tracked.openTools.clear();
  }

  /** Ended sessions stay tracked briefly so a server that keeps returning
   * them does not cause a session_started/session_ended flap; prune eventually
   * so they cannot pile up against the concurrent-session bound. */
  private pruneEnded(): void {
    const now = this.now();
    for (const [key, tracked] of this.sessions) {
      if (tracked.ended && now - tracked.endedAt > this.endedTtlMs) {
        this.sessions.delete(key);
        this.skippedBound.delete(key);
        this.reportedPollFailure.delete(key);
      }
    }
  }

  private activeSessionCount(): number {
    let count = 0;
    for (const tracked of this.sessions.values()) {
      if (!tracked.ended) count += 1;
    }
    return count;
  }

  private replayBuffered(): void {
    for (const tracked of this.sessions.values()) {
      if (tracked.ended || tracked.replay.length === 0) continue;
      const tail = tracked.replay.slice(-this.replayOnConnectMax);
      this.deps.logger.debug("session events: replaying buffered frames", {
        sessionId: tracked.sessionId,
        frames: tail.length,
      });
      for (const frame of tail) {
        this.deps.send(frame, tracked.projectPath);
      }
    }
  }
}

function sessionKey(projectPath: string, sessionId: string): string {
  return `${projectPath}\n${sessionId}`;
}

/** Parse the sessionId hints from a gsd_status "Multiple tracked" error. */
function parseTrackedSessionHints(text: string): string[] {
  const marker = "Tracked sessions:";
  const index = text.indexOf(marker);
  if (index === -1) return [];
  return text
    .slice(index + marker.length)
    .split(";")
    .map((entry) => entry.trim().split(/\s+/)[0] ?? "")
    .filter((id) => id !== "" && id !== "(no");
}

/** Unwrap the MCP tool result into a normalized payload or an error text. */
function readStatusResult(result: unknown): { payload?: StatusPayload; errorText?: string } {
  const toolResult = result as McpToolResult | undefined;
  const text = (toolResult?.content ?? [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  if (toolResult?.isError) return { errorText: text };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { errorText: text || "unexpected gsd_status result" };
  }
  if (typeof raw.error === "string") return { errorText: raw.error };
  return { payload: normalizePayload(raw) };
}

function normalizePayload(raw: Record<string, unknown>): StatusPayload {
  const progress = raw.progress as Record<string, unknown> | undefined;
  const blocker = raw.pendingBlocker as Record<string, unknown> | null | undefined;
  return {
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    status: typeof raw.status === "string" ? raw.status : "running",
    eventCount: typeof progress?.eventCount === "number" ? progress.eventCount : 0,
    recentEvents: Array.isArray(raw.recentEvents)
      ? raw.recentEvents.filter((event): event is Record<string, unknown> => event != null && typeof event === "object")
      : [],
    pendingBlocker: blocker && typeof blocker.id === "string"
      ? {
          id: blocker.id,
          message: typeof blocker.message === "string" ? blocker.message : "",
          ...(Array.isArray(blocker.options)
            ? { options: blocker.options.filter((option): option is string => typeof option === "string") }
            : {}),
        }
      : null,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.error === "string" ? { errorMessage: raw.error } : {}),
    ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}),
  };
}

/** Events that appeared since the last observation, oldest first. */
function deltaEvents(tracked: TrackedSession, payload: StatusPayload): Array<Record<string, unknown>> {
  const delta = payload.eventCount - tracked.lastEventCount;
  if (delta <= 0) {
    // Counter reset (session object rebuilt) — treat the visible window as new.
    return payload.eventCount < tracked.lastEventCount ? payload.recentEvents : [];
  }
  const startIndex = Math.max(0, payload.recentEvents.length - delta);
  return payload.recentEvents.slice(startIndex);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part != null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarize(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function summarizeResult(result: unknown): string {
  const text = extractText((result as { content?: unknown } | undefined)?.content);
  return text || summarize(result);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
