import test from "node:test";
import assert from "node:assert/strict";
import { GSD_PI_LOGO } from "../logo.ts";

const { filterInitialGsdHeader } = await import("../../web/lib/initial-gsd-header-filter.ts");

const GSD_LOGO_LINES = GSD_PI_LOGO;

test("filterInitialGsdHeader strips a plain startup banner and keeps real terminal content", () => {
  const warning = "Warning: Google Search is not configured.";
  const raw = [...GSD_LOGO_LINES, "  Git Ship Done v2.33.1", "", warning].join("\n");

  const result = filterInitialGsdHeader(raw);

  assert.equal(result.status, "matched");
  assert.equal(result.text, warning);
});

test("filterInitialGsdHeader strips ANSI-colored startup banner output", () => {
  const cyan = "\u001b[36m";
  const reset = "\u001b[39m";
  const bold = "\u001b[1m";
  const boldReset = "\u001b[22m";
  const dim = "\u001b[2m";
  const dimReset = "\u001b[22m";
  const warning = "Warning: terminal content starts here.\r\n";

  const raw =
    GSD_LOGO_LINES.map((line) => `${cyan}${line}${reset}\r\n`).join("") +
    `  ${bold}Git Ship Done${boldReset} ${dim}v2.33.1${dimReset}\r\n\r\n` +
    warning;

  const result = filterInitialGsdHeader(raw);

  assert.equal(result.status, "matched");
  assert.equal(result.text, warning);
});

test("filterInitialGsdHeader waits for more data when the startup banner is incomplete", () => {
  const partial = `${GSD_LOGO_LINES[0]}\n${GSD_LOGO_LINES[1]}\n${GSD_LOGO_LINES[2]}`;

  const result = filterInitialGsdHeader(partial);

  assert.deepEqual(result, { status: "needs-more", text: "" });
});

test("filterInitialGsdHeader passes normal terminal output through untouched", () => {
  const raw = "Warning: already in the shell\r\n$ ";

  const result = filterInitialGsdHeader(raw);

  assert.equal(result.status, "passthrough");
  assert.equal(result.text, raw);
});
