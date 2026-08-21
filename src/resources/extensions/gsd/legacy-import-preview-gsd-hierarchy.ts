// Project/App: gsd-pi
// File Purpose: Pure hierarchy interpretation for captured legacy .gsd projections.

import { compareText } from "./legacy-import-utils.js";

import type { LegacyImportValue } from "./legacy-import-contract.js";
import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
  type LegacyImportSourceLine,
} from "./legacy-import-preview-interpretation.js";

type SourceFile = LegacyImportDecodedSourceFile;
type SourceLine = LegacyImportSourceLine;
type PendingCandidate = LegacyImportPendingCandidate;
type PendingDiagnosis = LegacyImportPendingDiagnosis;
type HierarchyLayout = "flat" | "nested";

interface TextSpan {
  start: number;
  end: number;
}

interface HierarchyClaim {
  file: SourceFile;
  layout: HierarchyLayout;
  directory: string;
  canonicalId: string;
  sourceAlias: string;
  title: string;
  heading: SourceLine;
  status?: string;
  statusLine?: SourceLine;
  teamId: boolean;
  bareNumericAlias: boolean;
  bareNumericPath: boolean;
}

interface SliceClaim {
  id: string;
  title: string;
  status: "complete" | "pending";
  line: SourceLine;
  span: TextSpan;
  dependsOn?: readonly string[];
  risk?: string;
  sketch?: boolean;
}

interface FrontmatterField {
  value: string;
  line: SourceLine;
}

const FLAT_PREFIX = ".gsd/phases/";
const NESTED_PREFIX = ".gsd/milestones/";

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function matchSpan(line: SourceLine, match: RegExpExecArray): TextSpan {
  const prefix = line.text.slice(0, match.index);
  return {
    start: line.start + utf8Length(prefix),
    end: line.start + utf8Length(prefix + match[0]),
  };
}

function firstMatch(
  file: SourceFile,
  pattern: RegExp,
): { line: SourceLine; match: RegExpExecArray; span: TextSpan } | undefined {
  for (const line of file.lines) {
    const match = pattern.exec(line.text);
    if (match !== null) return { line, match, span: matchSpan(line, match) };
  }
  return undefined;
}

function frontmatterField(file: SourceFile, name: string): FrontmatterField | undefined {
  if (file.lines[0]?.text !== "---") return undefined;
  const closingIndex = file.lines.findIndex((line, index) => index > 0 && line.text === "---");
  if (closingIndex < 0) return undefined;
  const pattern = new RegExp(`^${name}:\\s*["']?([^"']+?)["']?\\s*$`, "u");
  for (const line of file.lines.slice(1, closingIndex)) {
    const match = pattern.exec(line.text);
    if (match !== null) return { value: match[1].trim(), line };
  }
  return undefined;
}

function canonicalMilestoneId(alias: string): string | undefined {
  const numeric = /^(?:M)?(\d+)(.*)$/u.exec(alias);
  if (numeric === null) return undefined;
  const number = Number(numeric[1]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  const suffix = numeric[2];
  if (suffix.length > 0 && !/^-[a-z0-9]+$/u.test(suffix)) return undefined;
  return `M${String(number).padStart(3, "0")}${suffix}`;
}

function hierarchyPath(path: string): boolean {
  return path.startsWith(FLAT_PREFIX) || path.startsWith(NESTED_PREFIX);
}

function layoutFor(path: string): HierarchyLayout | undefined {
  if (path.startsWith(FLAT_PREFIX)) return "flat";
  if (path.startsWith(NESTED_PREFIX)) return "nested";
  return undefined;
}

function roadmapPath(path: string): boolean {
  return /-ROADMAP\.md$/u.test(path);
}

function directorySegment(path: string, layout: HierarchyLayout): string {
  const prefix = layout === "flat" ? FLAT_PREFIX : NESTED_PREFIX;
  return path.slice(prefix.length).split("/")[0];
}

function claimFor(file: SourceFile): HierarchyClaim | undefined {
  const layout = layoutFor(file.entry.logical_path);
  if (layout === undefined || !roadmapPath(file.entry.logical_path) || file.encoding !== "utf-8") {
    return undefined;
  }
  const canonicalHeading = firstMatch(file, /^#\s+((?:M)?\d+(?:-[a-z0-9]+)?):\s+(.+)$/u);
  const legacyHeading = canonicalHeading === undefined
    ? firstMatch(file, /^##\s+(?:✅\s+)?(v\d+(?:\.\d+)*)\s+milestone\s+\(\s*(CLOSED)\b[^)]*\)\s*$/iu)
    : undefined;
  const heading = canonicalHeading ?? legacyHeading;
  if (heading === undefined) return undefined;
  const directory = directorySegment(file.entry.logical_path, layout);
  const sourceAlias = canonicalHeading?.match[1] ?? /^(?:M)?\d+/u.exec(directory)?.[0];
  if (sourceAlias === undefined) return undefined;
  const canonicalId = canonicalMilestoneId(sourceAlias);
  if (canonicalId === undefined) return undefined;
  const status = legacyHeading === undefined ? firstMatch(file, /^Status:\s*(\S.*?)\s*$/u) : undefined;
  return {
    file,
    layout,
    directory,
    canonicalId,
    sourceAlias,
    title: canonicalHeading?.match[2].trim() ?? `${legacyHeading!.match[1]} milestone`,
    heading: heading.line,
    status: legacyHeading === undefined ? status?.match[1].trim().toLowerCase() : "complete",
    statusLine: legacyHeading?.line ?? status?.line,
    teamId: canonicalId.includes("-"),
    bareNumericAlias: layout === "flat" && !sourceAlias.startsWith("M"),
    bareNumericPath: layout === "flat" && /^\d/u.test(directory),
  };
}

export function hasModeledLegacyGsdHierarchySource(files: readonly SourceFile[]): boolean {
  return files.some((file) => file.outcome !== "unparsed" && claimFor(file) !== undefined);
}

function addCandidate(
  candidates: PendingCandidate[],
  file: SourceFile,
  target: { kind: string; key: string; field?: string },
  normalized: LegacyImportValue,
  reasonCode: string,
  span: TextSpan,
  classification: "compare" | "preserve" = "compare",
): void {
  addLegacyImportCandidate(
    candidates,
    file,
    target,
    normalized,
    reasonCode,
    span.start,
    span.end,
    classification,
  );
}

function addDiagnosis(
  diagnoses: PendingDiagnosis[],
  file: SourceFile,
  code: string,
  message: string,
  span: TextSpan,
): void {
  addLegacyImportDiagnosis(
    diagnoses,
    file,
    code,
    "blocker",
    message,
    "requires-user",
    span.start,
    span.end,
  );
}

function preserveHeading(
  file: SourceFile,
  candidates: PendingCandidate[],
  reasonCode: string,
  normalized: LegacyImportValue,
): void {
  file.outcome = "preserved";
  const heading = file.lines.find((line) => /^#\s+/u.test(line.text));
  const span = heading === undefined
    ? { start: 0, end: file.bytes.length }
    : { start: heading.start, end: heading.end };
  addCandidate(
    candidates,
    file,
    { kind: "artifact", key: file.entry.logical_path },
    normalized,
    reasonCode,
    span,
    "preserve",
  );
}

function roadmapSlices(file: SourceFile): SliceClaim[] {
  const claims: SliceClaim[] = [];
  for (const line of file.lines) {
    const currentChecklist = /^-\s+\[([ xX])\]\s+\*\*(S\d+):\s+(.+?)\*\*\s+`risk:([^`]+)`\s+`depends:\[([^\]]*)\]`$/u.exec(line.text);
    if (currentChecklist !== null) {
      claims.push({
        id: currentChecklist[2],
        title: currentChecklist[3].trim(),
        status: currentChecklist[1].toLowerCase() === "x" ? "complete" : "pending",
        line,
        span: matchSpan(line, currentChecklist),
        dependsOn: currentChecklist[5].split(",").map((value) => value.trim()).filter(Boolean),
        risk: currentChecklist[4].trim(),
      });
      continue;
    }
    const checklist = /^-\s+\[([ xX])\]\s+(S\d+)\s+(.+?)(?:\s+\(depends on (S\d+)(?:-(S\d+))?\))?$/u.exec(line.text);
    if (checklist !== null) {
      claims.push({
        id: checklist[2],
        title: checklist[3].trim(),
        status: checklist[1].toLowerCase() === "x" ? "complete" : "pending",
        line,
        span: matchSpan(line, checklist),
        dependsOn: dependencyRange(checklist[4], checklist[5]),
      });
      continue;
    }
    const table = /^\|\s*(S\d+)\s*\|\s*([^|]+?)\s*\|\s*(yes|no)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/iu.exec(line.text);
    if (table !== null && table[1] !== "Slice") {
      claims.push({
        id: table[1],
        title: table[2].trim(),
        status: table[3].toLowerCase() === "yes" ? "complete" : "pending",
        line,
        span: matchSpan(line, table),
        dependsOn: table[4].trim().toLowerCase() === "none"
          ? []
          : table[4].split(",").map((value) => value.trim()).filter(Boolean),
        risk: table[5].trim(),
      });
      continue;
    }
    const legacyTable = /^\|\s*(S\d+|\d+(?:\.\d+)*)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/iu.exec(line.text);
    if (legacyTable !== null) {
      claims.push({
        id: legacyTable[1].toUpperCase().startsWith("S")
          ? legacyTable[1].toUpperCase()
          : `S${String(claims.length + 1).padStart(2, "0")}`,
        title: legacyTable[2].trim(),
        status: /^(?:✅\s*)?(?:complete|completed|done|closed)$/iu.test(legacyTable[3].trim())
          ? "complete"
          : "pending",
        line,
        span: matchSpan(line, legacyTable),
      });
      continue;
    }
    const prose = /^The milestone has one slice,\s*(S\d+)\s+([^,]+),.+$/u.exec(line.text);
    if (prose !== null) {
      claims.push({
        id: prose[1],
        title: prose[2].trim(),
        status: "pending",
        line,
        span: matchSpan(line, prose),
      });
      continue;
    }
    const sketch = /^Sketch:\s*(S\d+)\s+(.+?)\.\s+Tasks are intentionally undecided\.$/u.exec(line.text);
    if (sketch !== null) {
      claims.push({
        id: sketch[1],
        title: sketch[2].trim(),
        status: "pending",
        line,
        span: matchSpan(line, sketch),
        sketch: true,
      });
    }
  }
  return claims;
}

function conflictingRoadmapSlices(left: SourceFile, right: SourceFile): boolean {
  const comparable = (file: SourceFile) => roadmapSlices(file).map((slice) => ({
    id: slice.id,
    title: slice.title,
    status: slice.status,
    dependsOn: slice.dependsOn ?? [],
    risk: slice.risk ?? null,
    sketch: slice.sketch ?? false,
  }));
  const leftSlices = comparable(left);
  const rightSlices = comparable(right);
  return (leftSlices.length > 0 || rightSlices.length > 0)
    && JSON.stringify(leftSlices) !== JSON.stringify(rightSlices);
}

function dependencyRange(start?: string, end?: string): readonly string[] {
  if (start === undefined) return [];
  if (end === undefined) return [start];
  const startNumber = Number(start.slice(1));
  const endNumber = Number(end.slice(1));
  if (!Number.isSafeInteger(startNumber) || !Number.isSafeInteger(endNumber) || endNumber < startNumber) {
    return [];
  }
  const values: string[] = [];
  for (let value = startNumber; value <= endNumber; value += 1) {
    values.push(`S${String(value).padStart(2, "0")}`);
  }
  return values;
}

function emitHybridClaim(
  claim: HierarchyClaim,
  candidates: PendingCandidate[],
): void {
  const reason = claim.teamId ? "hybrid-non-overlap-team-id" : "hybrid-non-overlap";
  addCandidate(candidates, claim.file, { kind: "milestone", key: claim.canonicalId }, {
    id: claim.canonicalId,
    layout: claim.layout,
    ...(claim.status === undefined ? {} : { status: claim.status }),
    title: claim.title,
  }, reason, { start: claim.heading.start, end: claim.heading.end });
  for (const slice of roadmapSlices(claim.file)) {
    addCandidate(candidates, claim.file, {
      kind: "slice",
      key: `${claim.canonicalId}/${slice.id}`,
    }, {
      id: slice.id,
      milestone_id: claim.canonicalId,
      status: slice.status,
      title: slice.title,
    }, reason, slice.span);
  }
}

function markClaimsUnparsed(claims: readonly HierarchyClaim[]): void {
  for (const claim of claims) claim.file.outcome = "unparsed";
}

function diagnoseHybridGroup(
  id: string,
  claims: readonly HierarchyClaim[],
  diagnoses: PendingDiagnosis[],
): void {
  const flat = claims.filter((claim) => claim.layout === "flat").sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path));
  const nested = claims.filter((claim) => claim.layout === "nested").sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path));
  markClaimsUnparsed(claims);

  if (flat.length > 1 || nested.length > 1) {
    const duplicateLayout = flat.length > 1 ? flat : nested;
    const evidence = duplicateLayout[1];
    addDiagnosis(
      diagnoses,
      evidence.file,
      "ambiguous-path",
      `Two ${evidence.layout} directories identify milestone ${id}, so neither path can become canonical.`,
      { start: evidence.heading.start, end: evidence.heading.end },
    );
    if (flat.length > 0 && nested.length > 0) {
      const nestedEvidence = nested[0];
      addDiagnosis(
        diagnoses,
        nestedEvidence.file,
        "duplicate-logical-milestone",
        `Flat and nested layouts both contain logical milestone ${id}.`,
        { start: nestedEvidence.heading.start, end: nestedEvidence.heading.end },
      );
    }
    return;
  }

  const flatClaim = flat[0];
  const nestedClaim = nested[0];
  if (flatClaim === undefined || nestedClaim === undefined) return;
  if (flatClaim.teamId || nestedClaim.teamId) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "ambiguous-team-milestone-alias",
      `Nested and flat team projections both claim ${id} with conflicting content.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
    return;
  }
  if (
    flatClaim.bareNumericPath
    && flatClaim.status === undefined
    && nestedClaim.status === undefined
  ) {
    if (conflictingRoadmapSlices(flatClaim.file, nestedClaim.file)) {
      addDiagnosis(
        diagnoses,
        flatClaim.file,
        "duplicate-logical-milestone",
        `A second hierarchy layout claims ${id}; both sources remain evidence until the user chooses the route.`,
        { start: flatClaim.heading.start, end: flatClaim.heading.end },
      );
      addDiagnosis(
        diagnoses,
        nestedClaim.file,
        "hybrid-conflicting-content",
        `The nested and flat ${id} sources name different routes, so neither is imported without a user choice.`,
        { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
      );
      return;
    }
    const pathAlias = /^\d+/u.exec(flatClaim.directory)?.[0] ?? flatClaim.sourceAlias;
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "duplicate-logical-milestone",
      `Bare numeric flat milestone ${pathAlias} collides with nested milestone ${id}.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
    return;
  }
  if (flatClaim.title !== nestedClaim.title) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "hybrid-conflicting-content",
      `Flat and nested milestone ${id} titles disagree.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
  }
  if (
    flatClaim.status !== undefined
    && nestedClaim.status !== undefined
    && flatClaim.status !== nestedClaim.status
    && nestedClaim.statusLine !== undefined
  ) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "hybrid-conflicting-status",
      `Flat and nested milestone ${id} status evidence disagrees.`,
      { start: nestedClaim.statusLine.start, end: nestedClaim.statusLine.end },
    );
  }
  if (flatClaim.title === nestedClaim.title && flatClaim.status === nestedClaim.status) {
    addDiagnosis(
      diagnoses,
      nestedClaim.file,
      "duplicate-logical-milestone",
      `Flat and nested layouts both contain logical milestone ${id}.`,
      { start: nestedClaim.heading.start, end: nestedClaim.heading.end },
    );
  }
}

function interpretHybrid(
  files: readonly SourceFile[],
  claims: readonly HierarchyClaim[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.encoding === "utf-8") file.parserId = "gsd-hybrid-hierarchy";
  }
  const byId = new Map<string, HierarchyClaim[]>();
  for (const claim of claims) {
    byId.set(claim.canonicalId, [...(byId.get(claim.canonicalId) ?? []), claim]);
  }
  for (const [id, group] of [...byId.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (group.length === 1) {
      emitHybridClaim(group[0], candidates);
    } else {
      diagnoseHybridGroup(id, group, diagnoses);
    }
  }
  for (const file of files) {
    if (file.encoding === "utf-8" && !roadmapPath(file.entry.logical_path)) {
      file.outcome = "unparsed";
      addDiagnosis(
        diagnoses,
        file,
        "unresolved-hybrid-membership",
        "Hybrid hierarchy artifact lacks one unambiguous milestone projection.",
        { start: 0, end: file.bytes.length },
      );
    }
  }
}

function emitFlatRoadmap(
  claim: HierarchyClaim,
  candidates: PendingCandidate[],
): void {
  let reason = "flat-milestone-alias";
  let normalized: LegacyImportValue = { id: claim.canonicalId, title: claim.title };
  if (claim.bareNumericAlias) {
    reason = "flat-bare-numeric-milestone";
    normalized = {
      id: claim.canonicalId,
      source_alias: claim.sourceAlias,
      ...(claim.status === undefined ? {} : { status: claim.status }),
      title: claim.title,
    };
  } else if (claim.directory.startsWith("M")) {
    reason = "flat-descriptor-milestone";
    normalized = {
      id: claim.canonicalId,
      source_alias: claim.directory,
      ...(claim.status === undefined ? {} : { status: claim.status }),
      title: claim.title,
    };
  } else if (claim.status !== undefined) {
    normalized = { id: claim.canonicalId, status: claim.status, title: claim.title };
  }
  addCandidate(
    candidates,
    claim.file,
    { kind: "milestone", key: claim.canonicalId },
    normalized,
    reason,
    { start: claim.heading.start, end: claim.heading.end },
  );
  for (const slice of roadmapSlices(claim.file)) {
    addCandidate(candidates, claim.file, {
      kind: "slice",
      key: `${claim.canonicalId}/${slice.id}`,
    }, {
      id: slice.id,
      milestone_id: claim.canonicalId,
      status: slice.status,
      title: slice.title,
    }, "flat-slice-checklist", slice.span);
  }
}

function expectedFlatParent(
  file: SourceFile,
  claimsByDirectory: ReadonlyMap<string, HierarchyClaim>,
): { milestoneId: string; sliceIds: ReadonlySet<string>; taskId: string } | undefined {
  const relative = file.entry.logical_path.slice(FLAT_PREFIX.length);
  const [directory, fileName] = relative.split("/");
  const claim = claimsByDirectory.get(directory);
  const fileIdentity = /^.+?-(\d+)-(?:PLAN|SUMMARY)\.md$/u.exec(fileName ?? "");
  if (claim === undefined || fileIdentity === null) return undefined;
  const sliceIds = new Set(roadmapSlices(claim.file).map((slice) => slice.id));
  if (sliceIds.size === 0) return undefined;
  return {
    milestoneId: claim.canonicalId,
    sliceIds,
    taskId: `T${String(Number(fileIdentity[1])).padStart(2, "0")}`,
  };
}

function selectFlatParent(
  file: SourceFile,
  parent: { milestoneId: string; sliceIds: ReadonlySet<string>; taskId: string } | undefined,
): {
  selected?: { milestoneId: string; sliceId: string; taskId: string };
  evidence?: SourceLine;
} {
  const milestone = frontmatterField(file, "milestone");
  const slice = frontmatterField(file, "slice");
  const task = frontmatterField(file, "task");
  if (parent === undefined) return { evidence: slice?.line ?? milestone?.line ?? task?.line ?? file.lines[0] };
  if (milestone === undefined || milestone.value !== parent.milestoneId) {
    return { evidence: milestone?.line ?? file.lines[0] };
  }
  if (slice === undefined || !parent.sliceIds.has(slice.value)) {
    return { evidence: slice?.line ?? file.lines[0] };
  }
  if (task === undefined || task.value !== parent.taskId) {
    return { evidence: task?.line ?? file.lines[0] };
  }
  return { selected: { milestoneId: parent.milestoneId, sliceId: slice.value, taskId: parent.taskId } };
}

function interpretFlatArtifact(
  file: SourceFile,
  claimsByDirectory: ReadonlyMap<string, HierarchyClaim>,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const path = file.entry.logical_path;
  if (roadmapPath(path) || file.encoding !== "utf-8") return;
  const parent = selectFlatParent(file, expectedFlatParent(file, claimsByDirectory));
  if (/-PLAN\.md$/u.test(path)) {
    const heading = firstMatch(file, /^#\s+(T\d+):\s+(.+)$/u);
    if (parent.selected === undefined || heading === undefined || heading.match[1] !== parent.selected.taskId) {
      file.outcome = "unparsed";
      const evidence = parent.evidence ?? heading?.line ?? file.lines[0];
      addDiagnosis(
        diagnoses,
        file,
        "task-plan-parent-conflict",
        "Task plan parent metadata conflicts with its containing phase and cannot select a task.",
        { start: evidence.start, end: evidence.end },
      );
      return;
    }
    addCandidate(candidates, file, {
      kind: "task",
      key: `${parent.selected.milestoneId}/${parent.selected.sliceId}/${parent.selected.taskId}`,
    }, {
      id: parent.selected.taskId,
      milestone_id: parent.selected.milestoneId,
      slice_id: parent.selected.sliceId,
      status: "pending",
      title: heading.match[2].trim(),
    }, "flat-task-frontmatter-parent", heading.span);
    return;
  }
  if (/-SUMMARY\.md$/u.test(path)) {
    const status = frontmatterField(file, "status");
    if (parent.selected === undefined || status === undefined) {
      file.outcome = "unparsed";
      const evidence = parent.evidence ?? status?.line ?? file.lines[0];
      addDiagnosis(
        diagnoses,
        file,
        "task-summary-parent-conflict",
        "Summary parent metadata conflicts with its containing phase and cannot select a task.",
        { start: evidence.start, end: evidence.end },
      );
      return;
    }
    addCandidate(candidates, file, {
      kind: "task",
      key: `${parent.selected.milestoneId}/${parent.selected.sliceId}/${parent.selected.taskId}`,
      field: "status",
    }, status.value, "flat-matching-summary-attestation", {
      start: status.line.start,
      end: status.line.end,
    });
    return;
  }
  preserveHeading(
    file,
    candidates,
    "flat-unknown-artifact-preserved",
    { reason: "unknown-phase-suffix" },
  );
}

function interpretFlat(
  files: readonly SourceFile[],
  claims: readonly HierarchyClaim[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.encoding !== "utf-8") continue;
    file.parserId = roadmapPath(file.entry.logical_path) || /-(?:PLAN|SUMMARY)\.md$/u.test(file.entry.logical_path)
      ? "gsd-flat-hierarchy"
      : "gsd-artifact-classifier";
  }
  const byId = new Map<string, HierarchyClaim[]>();
  for (const claim of claims) byId.set(claim.canonicalId, [...(byId.get(claim.canonicalId) ?? []), claim]);
  const validClaims: HierarchyClaim[] = [];
  for (const [id, group] of byId) {
    if (group.length === 1) {
      validClaims.push(group[0]);
      continue;
    }
    markClaimsUnparsed(group);
    const evidence = [...group].sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path))[1];
    addDiagnosis(
      diagnoses,
      evidence.file,
      "ambiguous-path",
      `Two flat directories identify milestone ${id}, so neither path can become canonical.`,
      { start: evidence.heading.start, end: evidence.heading.end },
    );
  }
  const claimsByDirectory = new Map(validClaims.map((claim) => [claim.directory, claim]));
  for (const claim of validClaims) emitFlatRoadmap(claim, candidates);
  for (const file of files) interpretFlatArtifact(file, claimsByDirectory, candidates, diagnoses);
}

function nestedTaskCandidates(
  file: SourceFile,
  milestoneId: string,
  sliceId: string,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const checkbox = firstMatch(file, /^-\s+\[([ xX])\]\s+\*\*(T\d+):\s+(.+?)\*\*(?:\s+`est:[^`]+`)?$/u)
    ?? firstMatch(file, /^-\s+\[([ xX])\]\s+(T\d+)\s+(.+)$/u);
  const heading = firstMatch(file, /^##\s+(T\d+)\s+(.+)$/u);
  const xml = firstMatch(file, /<task\s+id="(T\d+)"\s+status="([^"]+)">([^<]+)<\/task>/u);
  const h1 = firstMatch(file, /^#\s+(T\d+):\s+(.+)$/u);
  const grammars = [checkbox, heading, xml, h1].filter((value) => value !== undefined);
  if (grammars.length !== 1) {
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses,
      file,
      "ambiguous-task-membership",
      "Task projection lacks one unambiguous hierarchy grammar.",
      { start: 0, end: file.bytes.length },
    );
    return;
  }
  const path = file.entry.logical_path;
  let taskId: string;
  let title: string;
  let status: "complete" | "pending";
  let reason: string;
  let span: TextSpan;
  if (checkbox !== undefined) {
    taskId = checkbox.match[2];
    title = checkbox.match[3].trim();
    status = checkbox.match[1].toLowerCase() === "x" ? "complete" : "pending";
    reason = "nested-checkbox-task";
    span = checkbox.span;
  } else if (heading !== undefined) {
    taskId = heading.match[1];
    title = heading.match[2].trim();
    status = firstMatch(file, /^Status:\s*complete\s*$/iu) === undefined ? "pending" : "complete";
    reason = "nested-heading-task";
    span = heading.span;
  } else if (xml !== undefined) {
    taskId = xml.match[1];
    title = xml.match[3].trim();
    status = xml.match[2].toLowerCase() === "complete" ? "complete" : "pending";
    reason = "nested-xml-task";
    span = xml.span;
  } else {
    taskId = h1!.match[1];
    title = h1!.match[2].trim();
    status = firstMatch(file, /^Status:\s*complete\s*$/iu) === undefined ? "pending" : "complete";
    reason = path.includes("/tasks/") ? "nested-task-subdirectory" : "nested-flat-task-within-slice";
    span = h1!.span;
  }
  addCandidate(candidates, file, {
    kind: "task",
    key: `${milestoneId}/${sliceId}/${taskId}`,
  }, {
    id: taskId,
    milestone_id: milestoneId,
    slice_id: sliceId,
    status,
    title,
  }, reason, span);
}

function nestedPlanParent(
  file: SourceFile,
  claimsByDirectory: ReadonlyMap<string, HierarchyClaim>,
): { milestoneId: string; sliceId: string } | undefined {
  const match = /^\.gsd\/milestones\/([^/]+)\/slices\/(S\d+)(?:-[^/]+)?\//u.exec(file.entry.logical_path);
  if (match === null) return undefined;
  const milestoneId = claimsByDirectory.get(match[1])?.canonicalId;
  return milestoneId === undefined ? undefined : { milestoneId, sliceId: match[2] };
}

function emitNestedRoadmap(claim: HierarchyClaim, candidates: PendingCandidate[]): Set<string> {
  addCandidate(candidates, claim.file, { kind: "milestone", key: claim.canonicalId }, {
    id: claim.canonicalId,
    ...(claim.status === undefined ? {} : { status: claim.status }),
    title: claim.title,
  }, "nested-milestone-heading", { start: claim.heading.start, end: claim.heading.end });
  const slices = roadmapSlices(claim.file);
  for (const slice of slices) {
    let reason = "nested-roadmap-checklist";
    if (slice.risk !== undefined) reason = "nested-roadmap-table";
    else if (slice.sketch === true) reason = "nested-sketch-placeholder";
    else if (slice.line.text.startsWith("The milestone")) reason = "nested-roadmap-prose";
    else if ((slice.dependsOn?.length ?? 0) > 1) reason = "nested-roadmap-dependency-range";
    const normalized: Record<string, LegacyImportValue> = {
      id: slice.id,
      milestone_id: claim.canonicalId,
      status: slice.status,
      title: slice.title,
    };
    if (reason === "nested-roadmap-checklist" || reason === "nested-roadmap-dependency-range" || reason === "nested-roadmap-table") {
      normalized.depends_on = slice.dependsOn ?? [];
    }
    if (slice.risk !== undefined) normalized.risk = slice.risk;
    if (slice.sketch === true) {
      normalized.sketch = true;
      normalized.tasks = [];
    }
    addCandidate(candidates, claim.file, {
      kind: "slice",
      key: `${claim.canonicalId}/${slice.id}`,
    }, normalized, reason, slice.span);
  }
  return new Set(slices.map((slice) => slice.id));
}

function interpretNested(
  files: readonly SourceFile[],
  claims: readonly HierarchyClaim[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.encoding === "utf-8") file.parserId = "gsd-nested-hierarchy";
  }
  const byId = new Map<string, HierarchyClaim[]>();
  for (const claim of claims) byId.set(claim.canonicalId, [...(byId.get(claim.canonicalId) ?? []), claim]);
  const memberships = new Map<string, Set<string>>();
  const claimsByDirectory = new Map<string, HierarchyClaim>();
  for (const [id, group] of byId) {
    if (group.length !== 1) {
      markClaimsUnparsed(group);
      const evidence = [...group].sort((left, right) => compareText(left.file.entry.logical_path, right.file.entry.logical_path))[1];
      addDiagnosis(
        diagnoses,
        evidence.file,
        "ambiguous-path",
        `Two nested directories identify milestone ${id}, so neither path can become canonical.`,
        { start: evidence.heading.start, end: evidence.heading.end },
      );
      continue;
    }
    claimsByDirectory.set(group[0].directory, group[0]);
    memberships.set(id, emitNestedRoadmap(group[0], candidates));
  }
  for (const file of files) {
    if (roadmapPath(file.entry.logical_path) || file.encoding !== "utf-8") continue;
    const parent = nestedPlanParent(file, claimsByDirectory);
    if (parent !== undefined && memberships.get(parent.milestoneId)?.has(parent.sliceId)) {
      nestedTaskCandidates(file, parent.milestoneId, parent.sliceId, candidates, diagnoses);
      continue;
    }
    const milestoneDirectory = directorySegment(file.entry.logical_path, "nested");
    if (!claimsByDirectory.has(milestoneDirectory)) {
      preserveHeading(
        file,
        candidates,
        "nested-ghost-preserved",
        { reason: "ghost-milestone-without-roadmap" },
      );
      continue;
    }
    if (!file.entry.logical_path.includes("/slices/")) {
      preserveHeading(
        file,
        candidates,
        "nested-milestone-artifact-preserved",
        { milestone_id: claimsByDirectory.get(milestoneDirectory)!.canonicalId },
      );
      continue;
    }
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses,
      file,
      "unresolved-nested-membership",
      "Nested hierarchy artifact lacks one unambiguous milestone and slice membership.",
      { start: 0, end: file.bytes.length },
    );
  }
}

/**
 * Interpret hierarchy files already decoded from the immutable source capture.
 * Returns every claimed hierarchy path so the caller can route remaining .gsd
 * registry and truth sources to their own processors.
 */
export function interpretLegacyGsdHierarchyFiles(
  decodedFiles: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): ReadonlySet<string> {
  const files = decodedFiles.filter((file) => hierarchyPath(file.entry.logical_path));
  if (files.length === 0) return new Set();
  const handled = new Set(files.map((file) => file.entry.logical_path));
  const claims = files.flatMap((file) => claimFor(file) ?? []);
  const claimedSources = new Set(claims.map((claim) => claim.file.entry.source_id));
  for (const file of files) {
    if (
      file.encoding === "utf-8"
      && roadmapPath(file.entry.logical_path)
      && !claimedSources.has(file.entry.source_id)
    ) {
      file.outcome = "unparsed";
      const evidence = file.lines.find((line) => line.text.trim().length > 0);
      addDiagnosis(
        diagnoses,
        file,
        "malformed-roadmap",
        "A recognized roadmap lacks a canonical milestone heading and cannot establish hierarchy truth.",
        { start: evidence?.start ?? 0, end: evidence?.end ?? file.bytes.length },
      );
    }
  }
  const layouts = new Set(files.flatMap((file) => {
    if (file.encoding !== "utf-8") return [];
    const layout = layoutFor(file.entry.logical_path);
    return layout === undefined ? [] : [layout];
  }));

  if (layouts.size > 1) interpretHybrid(files, claims, candidates, diagnoses);
  else if (layouts.has("flat")) interpretFlat(files, claims, candidates, diagnoses);
  else interpretNested(files, claims, candidates, diagnoses);

  return handled;
}
