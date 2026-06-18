// Project/App: gsd-pi
// File Purpose: Cross-walk matrix — every unit phase, workflow tool contract, transport
// registration, availability gate, and forbidden-tool boundary.

import test from "node:test";
import assert from "node:assert/strict";

import { WORKFLOW_TOOL_CONTRACTS } from "@opengsd/contracts";
import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerExecTools } from "../bootstrap/exec-tools.ts";
import { registerJournalTools } from "../bootstrap/journal-tools.ts";
import { registerMemoryTools } from "../bootstrap/memory-tools.ts";
import { registerQueryTools } from "../bootstrap/query-tools.ts";
import {
  buildMinimalAutoGsdToolSet,
  MINIMAL_AUTO_BASE_TOOL_NAMES,
  MINIMAL_GSD_TOOL_NAMES,
} from "../bootstrap/register-hooks.ts";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { canonicalWorkflowToolName } from "../engine-hook-contract.ts";
import { resolveToolPresentationPlan } from "../tool-presentation-plan.ts";
import { getToolSurfaceReadinessError } from "../tool-surface-readiness.ts";
import {
  compileUnitContextContract,
  compileUnitToolContract,
  getUnitWorkflowDispatchReadinessError,
} from "../tool-contract.ts";
import {
  getRequiredWorkflowToolsForUnit,
  getUnitToolSurfaceContract,
  UNIT_TOOL_CONTRACTS,
} from "../unit-tool-contracts.ts";
import { UNIT_MANIFESTS } from "../unit-context-manifest.ts";
import { UNIT_REGISTRY, type UnitTypeOrVariant } from "../unit-registry.ts";
import {
  isWorkflowToolSurfaceName,
  WORKFLOW_MCP_ADAPTER_TOOL_NAMES,
  WORKFLOW_TOOL_SURFACE_NAMES,
} from "../workflow-tool-surface.ts";

const WORKFLOW_SERVER = "gsd-workflow";

const MCP_TRANSPORT = {
  provider: "claude-code-cli",
  projectRoot: "/tmp/gsd-matrix-project",
  env: { GSD_WORKFLOW_MCP_COMMAND: "node" } as NodeJS.ProcessEnv,
  surface: "contract-matrix",
  authMode: "externalCli" as const,
  baseUrl: "local://claude-code",
};

/** Native Pi registers some contract names under legacy aliases. */
const NATIVE_TOOL_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  gsd_capture_thought: ["capture_thought", "gsd_capture_thought"],
  gsd_memory_query: ["memory_query", "gsd_memory_query"],
  gsd_memory_graph: ["gsd_graph", "gsd_memory_graph"],
};

const REGISTERED_SURFACE_TOOL_NAMES = [
  ...new Set([
    ...MINIMAL_AUTO_BASE_TOOL_NAMES,
    ...MINIMAL_GSD_TOOL_NAMES,
    ...Object.values(UNIT_TOOL_CONTRACTS).flatMap((contract) => contract.allowedGsdTools),
    ...WORKFLOW_TOOL_SURFACE_NAMES,
  ]),
];

function makeMockPi() {
  const tools: Array<{ name: string }> = [];
  return {
    registerTool(tool: { name: string }) {
      tools.push(tool);
    },
    tools,
  } as const;
}

function collectNativeRegisteredToolNames(): Set<string> {
  const pi = makeMockPi();
  registerDbTools(pi as never);
  registerExecTools(pi as never);
  registerQueryTools(pi as never);
  registerJournalTools(pi as never);
  registerMemoryTools(pi as never);
  return new Set(pi.tools.map((tool) => tool.name));
}

function workflowToolsForUnit(unitType: string): string[] {
  return getRequiredWorkflowToolsForUnit(unitType).filter(
    (tool) => tool.startsWith("gsd_") || tool === "ask_user_questions",
  );
}

function mockConnectedObservation(requiredTools: readonly string[]) {
  return {
    tools: requiredTools.map((tool) => `mcp__${WORKFLOW_SERVER}__${tool}`),
    mcpServers: [{ name: WORKFLOW_SERVER, status: "connected" }],
  };
}

function assertNativeToolRegistered(
  registered: Set<string>,
  contractName: string,
  label: string,
): void {
  const candidates = [contractName, ...(NATIVE_TOOL_EQUIVALENTS[contractName] ?? [])];
  assert.ok(
    candidates.some((name) => registered.has(name)),
    `${label}: native transport missing ${contractName} (candidates: ${candidates.join(", ")})`,
  );
}

function unitHasManifest(unitType: string): boolean {
  return unitType in UNIT_MANIFESTS;
}

function unitTypesWithContracts(): Array<[UnitTypeOrVariant, (typeof UNIT_REGISTRY)[UnitTypeOrVariant]]> {
  return Object.entries(UNIT_REGISTRY).filter(
    (entry): entry is [UnitTypeOrVariant, (typeof UNIT_REGISTRY)[UnitTypeOrVariant]] =>
      entry[1].toolContract !== null,
  );
}

// ─── Unit phase × contract integrity ───────────────────────────────────────

test("every manifest-backed unit with a tool contract compiles Tool Contract and Context Contract", () => {
  for (const [unitType] of unitTypesWithContracts()) {
    if (!unitHasManifest(unitType)) continue;
    const toolResult = compileUnitToolContract(unitType);
    assert.equal(toolResult.ok, true, `${unitType} must compile Tool Contract`);

    const contextResult = compileUnitContextContract(unitType);
    assert.equal(contextResult.ok, true, `${unitType} must compile Context Contract`);
  }
});

for (const [unitType, descriptor] of unitTypesWithContracts()) {
  test(`${unitType}: required workflow tools are declared, on-surface, and allowed`, () => {
    const contract = descriptor.toolContract!;
    const allowed = new Set(contract.allowedGsdTools.map((tool) => String(tool)));

    for (const required of contract.requiredWorkflowTools) {
      const name = String(required);
      if (name === "subagent") {
        assert.ok(allowed.has("subagent"), `${unitType}: subagent required but not allowed`);
        continue;
      }
      assert.ok(
        allowed.has(name) || name === "ask_user_questions",
        `${unitType}: required ${name} must be allowed or be ask_user_questions`,
      );
      if (name.startsWith("gsd_")) {
        assert.ok(
          isWorkflowToolSurfaceName(name),
          `${unitType}: required ${name} must be on WORKFLOW_TOOL_SURFACE_NAMES`,
        );
      } else if (name === "ask_user_questions") {
        assert.ok(
          (WORKFLOW_MCP_ADAPTER_TOOL_NAMES as readonly string[]).includes(name),
          `${unitType}: ask_user_questions must be on the MCP adapter surface`,
        );
      }
    }
  });
}

for (const [unitType, descriptor] of unitTypesWithContracts()) {
  const requiredTools = workflowToolsForUnit(unitType);
  if (requiredTools.length === 0) continue;

  test(`${unitType}: static dispatch gate passes when workflow MCP is configured`, () => {
    const error = getUnitWorkflowDispatchReadinessError({
      ...MCP_TRANSPORT,
      unitType,
      activeTools: REGISTERED_SURFACE_TOOL_NAMES,
    });
    assert.equal(error, null, `${unitType} static gate: ${error ?? "ok"}`);
  });

  test(`${unitType}: runtime tool-surface readiness passes when MCP tools are connected`, () => {
    const error = getToolSurfaceReadinessError({
      unitType,
      workflowServerName: WORKFLOW_SERVER,
      observation: mockConnectedObservation(requiredTools),
    });
    assert.equal(error, null, `${unitType} runtime readiness: ${error ?? "ok"}`);
  });

  test(`${unitType}: runtime readiness fails when a required workflow tool is missing`, () => {
    if (requiredTools.length === 0) return;
    const missing = requiredTools[0];
    const partial = requiredTools.filter((tool) => tool !== missing);
    const error = getToolSurfaceReadinessError({
      unitType,
      workflowServerName: WORKFLOW_SERVER,
      observation: mockConnectedObservation(partial),
    });
    assert.ok(error, `${unitType} should fail readiness when ${missing} is absent`);
    assert.match(error!, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test(`${unitType}: native auto scoping exposes every required workflow tool`, () => {
    const scoped = buildMinimalAutoGsdToolSet(
      REGISTERED_SURFACE_TOOL_NAMES,
      unitType,
      REGISTERED_SURFACE_TOOL_NAMES,
    );
    for (const required of contractRequiredNames(unitType)) {
      const canonical = canonicalWorkflowToolName(required);
      const nativeCandidates = NATIVE_TOOL_EQUIVALENTS[canonical] ?? [canonical];
      assert.ok(
        scoped.some((tool) => nativeCandidates.includes(tool) || tool === canonical),
        `${unitType}: scoped tools missing ${required}; got ${scoped.join(", ")}`,
      );
    }
  });

  test(`${unitType}: MCP presentation plan exposes every required workflow tool`, () => {
    const requested = [
      ...new Set([
        ...(descriptor.toolContract?.allowedGsdTools ?? []),
        ...requiredTools,
      ]),
    ].filter((tool) => String(tool).startsWith("gsd_") || tool === "ask_user_questions");
    const plan = resolveToolPresentationPlan({
      phase: unitType,
      surface: "claude-code-sdk",
      workflowMcpServerName: WORKFLOW_SERVER,
      requestedToolNames: requested.map(String),
      availableToolNames: REGISTERED_SURFACE_TOOL_NAMES,
    });
    for (const required of requiredTools) {
      const presented = `mcp__${WORKFLOW_SERVER}__${required}`;
      assert.ok(
        plan.presentedToolNames.includes(presented),
        `${unitType}: presentation plan missing ${presented}; got ${plan.presentedToolNames.join(", ")}`,
      );
    }
  });
}

function contractRequiredNames(unitType: string): string[] {
  return getRequiredWorkflowToolsForUnit(unitType).filter((tool) => tool !== "ask_user_questions");
}

for (const [unitType, descriptor] of unitTypesWithContracts()) {
  const contract = descriptor.toolContract;
  if (!contract || !("forbiddenGsdTools" in contract) || !contract.forbiddenGsdTools) continue;
  const forbidden = Object.entries(contract.forbiddenGsdTools);

  for (const [toolName, reason] of forbidden) {
    test(`${unitType}: forbids ${toolName} — ${reason}`, () => {
      const block = shouldBlockAutoUnitToolCall(unitType, toolName);
      assert.equal(block.block, true, `${unitType} must block ${toolName}`);
      assert.ok(block.reason, `${unitType} block reason for ${toolName}`);
    });
  }
}

// ─── Workflow tool contract × transports ───────────────────────────────────

test("every canonical workflow contract tool is on the compiled MCP surface list", () => {
  for (const contract of WORKFLOW_TOOL_CONTRACTS) {
    assert.ok(
      isWorkflowToolSurfaceName(contract.canonicalName),
      `${contract.canonicalName} missing from WORKFLOW_TOOL_SURFACE_NAMES`,
    );
    for (const alias of contract.aliases) {
      assert.ok(
        isWorkflowToolSurfaceName(alias),
        `alias ${alias} for ${contract.canonicalName} missing from surface`,
      );
    }
  }
});

test("every unit-required workflow tool resolves to a registered contract canonical name", () => {
  const canonicalNames = new Set<string>(WORKFLOW_TOOL_CONTRACTS.map((tool) => tool.canonicalName));
  const adapterNames = new Set(WORKFLOW_MCP_ADAPTER_TOOL_NAMES as readonly string[]);

  for (const [unitType] of unitTypesWithContracts()) {
    for (const required of getRequiredWorkflowToolsForUnit(unitType)) {
      const name = String(required);
      if (name === "ask_user_questions") {
        assert.ok(adapterNames.has(name), `${unitType}: ${name} must be adapter-registered`);
        continue;
      }
      if (name === "subagent") continue;
      const canonical = canonicalWorkflowToolName(name);
      assert.ok(
        canonicalNames.has(canonical),
        `${unitType}: required ${name} canonicalizes to unknown contract ${canonical}`,
      );
    }
  }
});

test("native bootstrap registers every contract canonical tool (or documented equivalent)", () => {
  const registered = collectNativeRegisteredToolNames();
  for (const contract of WORKFLOW_TOOL_CONTRACTS) {
    assertNativeToolRegistered(registered, contract.canonicalName, "native bootstrap");
  }
});

test("every write-policy workflow contract declares schema and audit metadata", () => {
  for (const contract of WORKFLOW_TOOL_CONTRACTS) {
    assert.match(contract.schemaId, /^workflow\./, `${contract.canonicalName} schemaId`);
    assert.match(contract.auditEvent, /^workflow\./, `${contract.canonicalName} auditEvent`);
    assert.ok(contract.executorId.length > 0, `${contract.canonicalName} executorId`);
    if (contract.writePolicy === "write") {
      assert.notEqual(
        contract.executorId,
        "executeMilestoneStatus",
        `${contract.canonicalName} write tool must not use read executor`,
      );
    }
  }
});

test("registry tool contracts stay aligned with UNIT_TOOL_CONTRACTS view", () => {
  for (const [unitType, descriptor] of Object.entries(UNIT_REGISTRY)) {
    if (!descriptor.toolContract) {
      assert.equal(getUnitToolSurfaceContract(unitType), undefined);
      continue;
    }
    assert.deepEqual(
      getUnitToolSurfaceContract(unitType),
      descriptor.toolContract,
      `${unitType} derived contract drift`,
    );
  }
});
