import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  applyTextDelta,
  applyThinkingDelta,
  completeTurn,
  createInitialTranscriptState,
  getFlatTranscript,
  MAX_TRANSCRIPT_TURNS,
  pushPendingUserMessage,
  type CompletedTurn,
} from "../transcript-store.ts"

describe("transcript-store", () => {
  test("turn FSM: text delta accumulates then completes into a turn", () => {
    let state = createInitialTranscriptState()
    state = applyTextDelta(state, "Hello ")
    state = applyTextDelta(state, "world")
    state = completeTurn(state)

    assert.equal(state.completedTurns.length, 1)
    assert.equal(getFlatTranscript(state.completedTurns)[0], "Hello world")
    assert.equal(state.streamingAssistantText, "")
    assert.equal(state.currentTurnSegments.length, 0)
  })

  test("thinking then text preserves segment order", () => {
    let state = createInitialTranscriptState()
    state = applyThinkingDelta(state, "reasoning")
    state = applyTextDelta(state, "answer")
    state = completeTurn(state)

    const turn = state.completedTurns[0]!
    assert.equal(turn.segments.length, 2)
    assert.equal(turn.segments[0]?.kind, "thinking")
    assert.equal(turn.segments[1]?.kind, "text")
  })

  test("pending user message attaches on turn complete", () => {
    let state = createInitialTranscriptState()
    state = pushPendingUserMessage(state, {
      id: "u1",
      role: "user",
      content: "Hi",
      complete: true,
      timestamp: 1,
    })
    state = applyTextDelta(state, "Hello back")
    state = completeTurn(state)

    assert.equal(state.completedTurns[0]?.userMessage?.content, "Hi")
    assert.equal(state.pendingUserMessage, null)
  })

  test("overflow trims oldest turns", () => {
    const turns: CompletedTurn[] = Array.from({ length: MAX_TRANSCRIPT_TURNS + 3 }, (_, index) => ({
      segments: [{ kind: "text", content: `turn-${index}` }],
    }))

    let state = {
      ...createInitialTranscriptState(),
      completedTurns: turns,
    }
    state = applyTextDelta(state, "new")
    state = completeTurn(state)

    assert.equal(state.completedTurns.length, MAX_TRANSCRIPT_TURNS)
    assert.equal(
      state.completedTurns[0]?.segments[0]?.kind === "text" ? state.completedTurns[0].segments[0].content : null,
      `turn-${turns.length + 1 - MAX_TRANSCRIPT_TURNS}`,
    )
    assert.equal(getFlatTranscript(state.completedTurns).at(-1), "new")
  })
})
