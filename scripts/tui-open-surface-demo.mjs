#!/usr/bin/env node
// Local visual harness for ADR 0001 — compare the copy-clean "open" surface
// against the current bordered surface.
//
// Run after building pi-tui:
//   cd packages/pi-tui && npx tsc -p tsconfig.json && cd ../..
//   node scripts/tui-open-surface-demo.mjs
//
// Then SELECT the body lines of each block below and paste them somewhere —
// compare what actually got copied.

import { style } from "../packages/pi-tui/dist/index.js";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const body = [
	"$ ls packages/",
	"pi-tui  pi-coding-agent  pi-ai",
	"rpc-client  mcp-server  native",
];
const width = 52;

const print = (lines) => {
	for (const line of lines) console.log(line);
};

console.log();
console.log(cyan("ADR 0001 — copy-clean surface demo"));
console.log(dim("Select the 3 body lines of each block and paste them."));
console.log();

console.log(dim("── CURRENT: bordered (rounded) ──────────────────────"));
console.log();
print(
	style()
		.border("rounded")
		.paddingX(1)
		.title("bash", cyan)
		.titleRight("success", green)
		.borderColor(dim)
		.render(body, width),
);
console.log();
console.log(dim('↑ a copied body line also carries "│ " and " │"'));
console.log();

console.log(dim("── NEW: open surface (copy-clean) ───────────────────"));
console.log();
print(
	style()
		.border("open")
		.title("bash", cyan)
		.titleRight("success", green)
		.borderColor(dim)
		.render(body, width),
);
console.log();
console.log(dim("↑ a copied body line is exactly the text, no prefix"));
console.log();
console.log(dim("openSurface() in transcript-design.ts is the themed"));
console.log(dim("wrapper around style().border(\"open\") shown here."));
console.log();
