// Project/App: gsd-pi
// File Purpose: Repository registry seam for parent workspace multi-repo resolution.

import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { extractPlanningPathReference } from "./pre-execution-checks.js";
import type { GSDPreferences, WorkspacePreferences, WorkspaceRepositoryPreference } from "./preferences-types.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { resolveGsdPathContract } from "./paths.js";

export interface RegisteredRepository {
  id: string;
  root: string;
  role?: string;
  verification?: string[];
  commitPolicy?: "auto" | "skip";
}

export interface RepositoryRegistry {
  projectRoot: string;
  mode: "project" | "parent";
  repositories: RegisteredRepository[];
  byId: ReadonlyMap<string, RegisteredRepository>;
}

export function defaultRepositoryTargets(registry: RepositoryRegistry): string[] {
  // In parent mode, default to the declared child repositories so work is
  // attributed to the repo it touches — not silently to the root "project".
  if (registry.mode === "parent") {
    return registry.repositories.filter((repo) => repo.id !== "project").map((repo) => repo.id);
  }

  const project = registry.byId.get("project");
  if (project) return [project.id];
  const first = registry.repositories[0];
  return first ? [first.id] : [];
}

/**
 * Derive parent-mode repository targets from the paths a task plans to touch.
 * Paths resolve against the project root; a path inside a declared child
 * repository attributes the task to that repository (deepest root wins), and
 * anything else belongs to the orchestration root ("project"). Without this,
 * defaulted targets fan verification out to every child repo even when the
 * task's files live only at the orchestration root, so no planning input can
 * make the gate pass (#1630). Accepts raw planned references — non-path
 * entries are filtered and annotations normalized here so derivation
 * semantics live in one place. Returns null when derivation has nothing to
 * go on (not parent mode, no declared children, or no usable paths).
 */
export function deriveRepositoryTargetsFromPlannedPaths(
  registry: RepositoryRegistry,
  plannedReferences: readonly string[],
): string[] | null {
  if (registry.mode !== "parent") return null;
  const children = registry.repositories.filter((repo) => repo.id !== "project");
  if (children.length === 0) return null;

  const targets: string[] = [];
  for (const raw of plannedReferences) {
    const plannedPath = extractPlanningPathReference(raw);
    if (!plannedPath) continue;
    const absolute = isAbsolute(plannedPath)
      ? resolve(plannedPath)
      : resolve(registry.projectRoot, plannedPath);
    let matched: RegisteredRepository | undefined;
    for (const child of children) {
      const rel = relative(child.root, absolute);
      const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      if (inside && (!matched || child.root.length > matched.root.length)) matched = child;
    }
    const id = matched ? matched.id : "project";
    if (!targets.includes(id)) targets.push(id);
  }
  return targets.length > 0 ? targets : null;
}


function assertInsideProjectRoot(projectRoot: string, candidateRoot: string, repoId: string): void {
  const rel = relative(projectRoot, candidateRoot);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`workspace.repositories.${repoId}.path resolves outside project root: ${candidateRoot}`);
  }
}

function resolveRepositoryRoot(
  projectRoot: string,
  repoId: string,
  repo: WorkspaceRepositoryPreference,
): RegisteredRepository {
  const root = resolve(projectRoot, repo.path);
  assertInsideProjectRoot(projectRoot, root, repoId);
  return {
    id: repoId,
    root,
    role: repo.role,
    verification: repo.verification,
    commitPolicy: repo.commit_policy,
  };
}

function resolveGitWorkingTreeRoot(basePath: string): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
    return root ? resolve(root) : null;
  } catch {
    return null;
  }
}

/**
 * Build a repository registry with an implicit reserved "project" repository
 * rooted at projectRoot. User-defined workspace repositories may not use id "project".
 */
export function createRepositoryRegistry(
  basePath: string,
  workspacePrefs?: WorkspacePreferences,
): RepositoryRegistry {
  const projectRoot = resolveRepositoryProjectRoot(basePath);
  const mode = workspacePrefs?.mode ?? "project";
  const repoMap = new Map<string, RegisteredRepository>();

  // "project" is reserved: always maps to projectRoot and cannot be overridden.
  repoMap.set("project", { id: "project", root: projectRoot });

  if (workspacePrefs?.repositories && Object.hasOwn(workspacePrefs.repositories, "project")) {
    throw new Error('workspace.repositories.project is reserved for the implicit project root repository');
  }

  for (const [repoId, repoConfig] of Object.entries(workspacePrefs?.repositories ?? {})) {
    repoMap.set(repoId, resolveRepositoryRoot(projectRoot, repoId, repoConfig));
  }

  return {
    projectRoot,
    mode,
    repositories: Array.from(repoMap.values()),
    byId: repoMap,
  };
}

export function resolveRepositoryProjectRoot(basePath: string): string {
  const contract = resolveGsdPathContract(basePath);
  return contract.isWorktree
    ? resolveGitWorkingTreeRoot(contract.workRoot) ?? contract.workRoot
    : contract.projectRoot;
}

export function createRepositoryRegistryFromPreferences(
  basePath: string,
  preferences?: Pick<GSDPreferences, "workspace">,
): RepositoryRegistry {
  return createRepositoryRegistry(basePath, preferences?.workspace);
}
