const CLAUDE_CODE_AGENT_TYPES = ["Explore", "Plan", "general-purpose"] as const;

const ROLE_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  scout: ["Explore"],
  planner: ["Plan"],
};

/**
 * Resolve an internal GSD role to a type registered by the active host.
 * Prefer the role itself, then its host alias, then the host's registered
 * `general-purpose` type. Preserve the role only when no fallback is exposed.
 */
export function resolveSubagentRole(
  role: string,
  availableAgentTypes?: readonly string[],
): string {
  if (!availableAgentTypes) return role;

  const registeredRole = availableAgentTypes.find(
    (agentType) => agentType.toLowerCase() === role.toLowerCase(),
  );
  if (registeredRole) return registeredRole;

  for (const candidate of ROLE_CANDIDATES[role.toLowerCase()] ?? []) {
    const registeredCandidate = availableAgentTypes.find(
      (agentType) => agentType.toLowerCase() === candidate.toLowerCase(),
    );
    if (registeredCandidate) return registeredCandidate;
  }

  return availableAgentTypes.find(
    (agentType) => agentType.toLowerCase() === "general-purpose",
  ) ?? role;
}

/** Claude Code uses native Agent types instead of GSD's bundled role names. */
export function resolveSubagentRoleForProvider(role: string, provider?: string): string {
  return resolveSubagentRole(
    role,
    provider?.toLowerCase() === "claude-code" ? CLAUDE_CODE_AGENT_TYPES : undefined,
  );
}
