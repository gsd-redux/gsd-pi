#!/usr/bin/env node
// Project/App: Open GSD
// File Purpose: E2E fixture standing in for the workflow MCP server.
//
// The gsd-pi executor drives the workflow MCP server over newline-delimited
// JSON-RPC on stdio. This fixture speaks exactly that protocol subset so the E2E
// harness can exercise the full cloud path (gateway -> WS relay -> cloud runtime
// -> executor -> stdio MCP) without starting the installed server. It is selected
// via GSD_WORKFLOW_MCP_COMMAND/ARGS; set GSD_CLOUD_E2E_GSD_CLI to a real gsd
// binary for a full-stack run instead.
//
// Protocol contract (mirrors what McpStdioClient sends/reads):
//   <- {"jsonrpc":"2.0","id":N,"method":"initialize","params":{...}}
//   -> {"jsonrpc":"2.0","id":N,"result":{protocolVersion,capabilities,serverInfo}}
//   <- {"jsonrpc":"2.0","method":"notifications/initialized"}   (no response)
//   <- {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{name,arguments}}
//   -> {"jsonrpc":"2.0","id":N,"result":{content:[{type:"text",text}]}}
//
// stdout carries protocol frames ONLY; diagnostics go to stderr.

import { createInterface } from "node:readline";

const FIXTURE_MARKER = "GSD_CLOUD_E2E_FIXTURE";
const PROTOCOL_VERSION = "2024-11-05";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // Stray non-JSON input — ignore like a tolerant server would.
  }
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;

  // Notifications (no id) never get a response.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    return respond(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "gsd-cloud-e2e-fixture", version: "1.0.0" },
    });
  }

  if (method === "ping") {
    return respond(id, {});
  }

  if (method === "tools/list") {
    return respond(id, {
      tools: ["gsd_query", "gsd_status"].map((name) => ({
        name,
        description: `Fixture stand-in for the ${name} workflow tool.`,
        inputSchema: { type: "object", properties: {}, required: [] },
      })),
    });
  }

  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    if (name === "gsd_query") {
      const projectDir = typeof args.projectDir === "string" ? args.projectDir : "<none>";
      const query = typeof args.query === "string" ? args.query : "<none>";
      return respond(id, {
        content: [{
          type: "text",
          text: `${FIXTURE_MARKER} gsd_query ok projectDir=${projectDir} query=${query}`,
        }],
      });
    }
    if (name === "gsd_status") {
      const projectDir = typeof args.projectDir === "string" ? args.projectDir : "<none>";
      return respond(id, {
        content: [{
          type: "text",
          text: `${FIXTURE_MARKER} gsd_status ok projectDir=${projectDir}`,
        }],
      });
    }
    return respond(id, {
      content: [{ type: "text", text: `${FIXTURE_MARKER} unhandled tool: ${name || "<missing>"}` }],
    });
  }

  respondError(id, -32601, `Method not found: ${method}`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
