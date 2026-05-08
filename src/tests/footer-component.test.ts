import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { FooterComponent } from "../../packages/pi-coding-agent/src/modes/interactive/components/footer.ts";
import { initTheme } from "../../packages/pi-coding-agent/src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

test("FooterComponent dims the pwd row including right-aligned extension statuses", () => {
  const footer = new FooterComponent(
    {
      state: {
        model: { id: "test-model", provider: "test", contextWindow: 1000 },
      },
      sessionManager: {
        getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ percent: 12.5, contextWindow: 1000 }),
      getLastTurnCost: () => 0,
      modelRegistry: {
        isUsingOAuth: () => false,
        getProviderAuthMode: () => "apiKey",
      },
    } as any,
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map([["one", "ready"], ["two", "synced"]]),
      getAvailableProviderCount: () => 1,
    } as any,
  );

  const lines = footer.render(100).map((line) => stripVTControlCharacters(line));

  assert.equal(lines.length, 2);
  assert.match(lines[0], /\(main\)/);
  assert.match(lines[0], /ready synced$/);
  assert.doesNotMatch(lines[1], /ready synced/);
});
