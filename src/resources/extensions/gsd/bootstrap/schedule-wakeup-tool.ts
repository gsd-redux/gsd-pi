// Project/App: GSD-2
// File Purpose: Registers the auto-mode ScheduleWakeup continuation tool.

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { getAutoRuntimeSnapshot } from "../auto-runtime-state.js";
import { scheduleAutoWakeup } from "../auto/schedule-wakeup.js";
import { resolveCtxCwd } from "./dynamic-tools.js";

const MAX_WAKEUP_DELAY_SECONDS = 24 * 60 * 60;

export function registerScheduleWakeupTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ScheduleWakeup",
    label: "Schedule Wakeup",
    description:
      "In GSD auto-mode, pause the current unit and continue the same session after a delay. " +
      "Use this for long external processes that need polling without ending the unit as no-artifact.",
    promptSnippet: "Schedule a same-session auto-mode wakeup after a delay.",
    promptGuidelines: [
      "Use ScheduleWakeup at the end of an execute-task turn when waiting for a long external process.",
      "Include a prompt that says exactly what external state to check next and what artifact to write when done.",
      "Re-arm ScheduleWakeup on each polling turn if the external process is still running.",
    ],
    parameters: Type.Object({
      delaySeconds: Type.Number({
        minimum: 1,
        maximum: MAX_WAKEUP_DELAY_SECONDS,
        description: "How many seconds to wait before continuing the same auto-mode session.",
      }),
      prompt: Type.String({
        minLength: 1,
        description: "Prompt to send when the session wakes up.",
      }),
      reason: Type.Optional(Type.String({
        description: "Why this delay is appropriate.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const dash = getAutoRuntimeSnapshot();
      const currentUnit = dash.currentUnit;
      const basePath = dash.basePath || resolveCtxCwd(ctx);

      if (!dash.active || !currentUnit) {
        return {
          content: [{ type: "text", text: "ScheduleWakeup is only available during an active GSD auto-mode unit." }],
          details: { operation: "schedule_wakeup", error: "auto_mode_inactive" },
          isError: true,
        };
      }

      const delaySeconds = Math.max(
        1,
        Math.min(MAX_WAKEUP_DELAY_SECONDS, Math.floor(params.delaySeconds)),
      );
      scheduleAutoWakeup({
        basePath,
        unitType: currentUnit.type,
        unitId: currentUnit.id,
        delayMs: delaySeconds * 1000,
        prompt: params.prompt,
        reason: params.reason ?? "",
        createdAt: Date.now(),
      });

      return {
        content: [{
          type: "text",
          text: `Wakeup scheduled for ${delaySeconds}s. Auto-mode will continue ${currentUnit.type} ${currentUnit.id} in the same session.`,
        }],
        details: {
          operation: "schedule_wakeup",
          delaySeconds,
          unitType: currentUnit.type,
          unitId: currentUnit.id,
        },
      };
    },
  });
}
