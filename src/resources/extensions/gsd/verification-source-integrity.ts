// Project/App: gsd-pi
// File Purpose: Deterministic fail-closed source snapshots for host verification targets.

import { createHash, type Hash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { SliceRow, TaskRow } from "./db-task-slice-rows.js";
import type { GSDPreferences } from "./preferences-types.js";
import {
  createRepositoryRegistryFromPreferences,
  defaultRepositoryTargets,
  type RegisteredRepository,
} from "./repository-registry.js";

export interface VerificationSourceTarget {
  id: string;
  cwd: string;
}

export interface VerificationTargetRevision {
  targetId: string;
  revision: string;
}

export interface VerificationSourceSnapshot {
  aggregateRevision: string;
  targets: VerificationTargetRevision[];
}

export interface ResolvedVerificationRepositoryTargets {
  repositories: RegisteredRepository[];
  explicitTargetsRequested: boolean;
  missingRepositoryIds: string[];
}

export type VerificationSourceSnapshotResult =
  | { ok: true; snapshot: VerificationSourceSnapshot }
  | { ok: false; targetId: string; error: string };

const SOURCE_PATHSPEC = ["--", ".", ":(exclude).gsd/**"];

export function resolveVerificationRepositoryTargets(
  basePath: string,
  preferences: GSDPreferences | undefined,
  task: TaskRow | null,
  slice: SliceRow | null,
): ResolvedVerificationRepositoryTargets {
  const registry = createRepositoryRegistryFromPreferences(basePath, preferences);
  const taskTargets = task?.target_repositories?.length ? task.target_repositories : null;
  const sliceTargets = slice?.target_repositories?.length ? slice.target_repositories : null;
  const explicitIds = taskTargets ?? sliceTargets;
  const requestedIds = explicitIds ?? defaultRepositoryTargets(registry);
  const repositories: RegisteredRepository[] = [];
  const missingRepositoryIds: string[] = [];
  const seen = new Set<string>();

  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const repository = registry.byId.get(id);
    if (repository) repositories.push(repository);
    else missingRepositoryIds.push(id);
  }

  const explicitTargetsRequested = explicitIds !== null;
  if (!explicitTargetsRequested && repositories.length === 0) {
    const project = registry.byId.get("project");
    if (project) repositories.push(project);
  }
  return { repositories, explicitTargetsRequested, missingRepositoryIds };
}

function addHashField(hash: Hash, label: string, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(label);
  hash.update("\0");
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
}

function gitOutput(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(detail || `git ${args.join(" ")} exited ${result.status ?? "without status"}`);
  }
  return result.stdout;
}

function untrackedPaths(cwd: string): string[] {
  return gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...SOURCE_PATHSPEC])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function addUntrackedFile(hash: Hash, cwd: string, path: string): void {
  const absolutePath = join(cwd, path);
  const stat = lstatSync(absolutePath);
  addHashField(hash, "untracked-path", path);
  addHashField(hash, "untracked-mode", String(stat.mode));
  if (stat.isSymbolicLink()) {
    addHashField(hash, "untracked-symlink", readlinkSync(absolutePath));
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported untracked source entry: ${path}`);
  }
  addHashField(hash, "untracked-content", readFileSync(absolutePath));
}

function captureTargetRevision(target: VerificationSourceTarget): VerificationTargetRevision {
  const hash = createHash("sha256");
  addHashField(hash, "head", gitOutput(target.cwd, ["rev-parse", "--verify", "HEAD"]));
  addHashField(hash, "staged", gitOutput(target.cwd, ["diff", "--no-ext-diff", "--binary", "--cached", "HEAD", ...SOURCE_PATHSPEC]));
  addHashField(hash, "unstaged", gitOutput(target.cwd, ["diff", "--no-ext-diff", "--binary", ...SOURCE_PATHSPEC]));
  for (const path of untrackedPaths(target.cwd)) addUntrackedFile(hash, target.cwd, path);
  return { targetId: target.id, revision: `sha256:${hash.digest("hex")}` };
}

function captureVerificationSourceSnapshotOnce(
  targets: VerificationSourceTarget[],
): VerificationSourceSnapshotResult {
  if (targets.length === 0) {
    return { ok: false, targetId: "<targets>", error: "Verification source snapshot requires at least one target repository" };
  }
  const ordered = [...targets].sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  const revisions: VerificationTargetRevision[] = [];
  for (const target of ordered) {
    if (seen.has(target.id)) {
      return { ok: false, targetId: target.id, error: `Duplicate verification source target: ${target.id}` };
    }
    seen.add(target.id);
    try {
      revisions.push(captureTargetRevision(target));
    } catch (error) {
      return {
        ok: false,
        targetId: target.id,
        error: `Unable to snapshot verification source for ${target.id}: ${(error as Error).message}`,
      };
    }
  }
  const aggregate = createHash("sha256");
  for (const target of revisions) {
    addHashField(aggregate, "target-id", target.targetId);
    addHashField(aggregate, "target-revision", target.revision);
  }
  return {
    ok: true,
    snapshot: {
      aggregateRevision: `sha256:${aggregate.digest("hex")}`,
      targets: revisions,
    },
  };
}

export function confirmVerificationSourceSnapshot(
  targets: VerificationSourceTarget[],
  expected: VerificationSourceSnapshot,
): VerificationSourceSnapshotResult {
  const confirmation = captureVerificationSourceSnapshotOnce(targets);
  if (!confirmation.ok) return confirmation;
  if (!verificationSourceChanged(expected, confirmation.snapshot)) return confirmation;
  const changedTarget = confirmation.snapshot.targets.find((target, index) =>
    target.targetId !== expected.targets[index]?.targetId ||
    target.revision !== expected.targets[index]?.revision
  );
  return {
    ok: false,
    targetId: changedTarget?.targetId ?? "<targets>",
    error: "Verification source changed while confirming a stable snapshot",
  };
}

export function captureVerificationSourceSnapshot(
  targets: VerificationSourceTarget[],
): VerificationSourceSnapshotResult {
  const first = captureVerificationSourceSnapshotOnce(targets);
  if (!first.ok) return first;
  return confirmVerificationSourceSnapshot(targets, first.snapshot);
}

export function verificationSourceChanged(
  before: VerificationSourceSnapshot,
  after: VerificationSourceSnapshot,
): boolean {
  return before.aggregateRevision !== after.aggregateRevision;
}
