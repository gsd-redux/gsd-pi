// Project/App: gsd-pi
// File Purpose: Pure actionless interpretation of captured legacy .planning bytes.

import { compareText } from "./legacy-import-utils.js";

import type {
  LegacyImportTarget,
  LegacyImportValue,
} from "./legacy-import-contract.js";
import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  decodeLegacyImportCapture,
  finalizeLegacyImportInterpretation,
  type LegacyImportDecodedSourceFile,
  type LegacyImportInterpretation,
  type LegacyImportInterpretationCandidate,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
  type LegacyImportSourceLine,
} from "./legacy-import-preview-interpretation.js";
import type { LegacyImportSourceCapture } from "./legacy-import-preview-source.js";

export type LegacyImportPlanningCandidate = LegacyImportInterpretationCandidate;
export type LegacyImportPlanningInterpretation = LegacyImportInterpretation;

type Line = LegacyImportSourceLine;
type SourceFile = LegacyImportDecodedSourceFile;
type PendingCandidate = LegacyImportPendingCandidate;
type PendingDiagnosis = LegacyImportPendingDiagnosis;

interface FlatMembership {
  phaseTargets: ReadonlyMap<string, string>;
  taskTargets: ReadonlyMap<string, string>;
}

const PARSER_VERSION = "1";

function parserFor(path: string): string {
  if (path === ".planning/ROADMAP.md") return "planning-roadmap-parser";
  if (/^\.planning\/milestones\/[^/]+-(?:ROADMAP|REQUIREMENTS)\.md$/u.test(path)) {
    return "planning-milestone-directory-parser";
  }
  if (/^\.planning\/milestones\/[^/]+-phases\/[^/]+\/[^/]+-PLAN\.md$/u.test(path)) {
    return "planning-milestone-directory-parser";
  }
  if (
    path.startsWith(".planning/.archive/")
    || path.startsWith(".planning/decisions/")
    || path.startsWith(".planning/quick/")
    || path.startsWith(".planning/research/")
    || path.startsWith(".planning/seeds/")
    || path.startsWith(".planning/milestones/")
    || /\/(?:[^/]+-)?(?:EXTRA|RESEARCH|VERIFICATION)\.md$/u.test(path)
  ) return "planning-supplemental-classifier";
  return "planning-parser";
}

function sourceFiles(capture: LegacyImportSourceCapture): SourceFile[] {
  return decodeLegacyImportCapture(capture, {
    sourceLabel: "planning",
    includes: (entry) => entry.logical_path.startsWith(".planning/"),
    parserId: parserFor,
    kind: (path) => path.endsWith(".json") ? "json" : "markdown",
    parserVersion: PARSER_VERSION,
  });
}

const addCandidate = addLegacyImportCandidate;
const addDiagnosis = addLegacyImportDiagnosis;

function wholeFilePreservation(
  candidates: PendingCandidate[],
  file: SourceFile,
  reasonCode: string,
  normalized: LegacyImportValue = { path: file.entry.logical_path, preservation: "verbatim" },
): void {
  file.outcome = "preserved";
  addCandidate(
    candidates,
    file,
    { kind: "legacy-artifact", key: file.entry.logical_path },
    normalized,
    reasonCode,
    0,
    file.bytes.length,
    "preserve",
  );
}

function firstLine(file: SourceFile, pattern: RegExp): { line: Line; match: RegExpExecArray } | undefined {
  for (const line of file.lines) {
    const match = pattern.exec(line.text);
    if (match !== null) return { line, match };
  }
  return undefined;
}

function frontmatterValue(file: SourceFile, key: string): { value: string; line: Line } | undefined {
  if (file.lines[0]?.text !== "---") return undefined;
  const closing = file.lines.findIndex((line, index) => index > 0 && line.text === "---");
  if (closing < 0) return undefined;
  const pattern = new RegExp(`^${key}:\\s*["']?([^"']+?)["']?\\s*$`, "u");
  const found = file.lines.slice(1, closing).flatMap((line) => {
    const match = pattern.exec(line.text);
    return match === null ? [] : [{ line, match }];
  })[0];
  return found === undefined ? undefined : { value: found.match[1], line: found.line };
}

function malformedRoadmap(
  file: SourceFile,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): true {
  file.outcome = "unparsed";
  addCandidate(
    candidates,
    file,
    { kind: "legacy-roadmap-fragment", key: "malformed" },
    { disposition: "preserved", grammar: "malformed" },
    "malformed-roadmap-preserve",
    0,
    file.bytes.length,
    "preserve",
  );
  addDiagnosis(
    diagnoses,
    file,
    "malformed-roadmap-grammar",
    "blocker",
    "Roadmap grammar is recognizable but incomplete or unsafe to interpret.",
    "requires-user",
    0,
    file.bytes.length,
    { kind: "roadmap-layout", key: "project" },
  );
  return true;
}

function xmlValue(text: string, tag: string): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "iu").exec(text)?.[1].trim() ?? "";
}

function headingTitle(file: SourceFile): string {
  const heading = firstLine(file, /^#\s+(.+)$/u)?.match[1] ?? "";
  return heading.replace(/^[\d.]+-[\da-z]+:\s*/iu, "").trim();
}

function normalizePhase(value: string): string {
  const parts = value.split(".");
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`legacy import phase number "${value}" contains an empty segment`);
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function naturalPlanOrder(left: string, right: string): number {
  const leftMatch = /^(\d+)([a-z]*)$/iu.exec(left);
  const rightMatch = /^(\d+)([a-z]*)$/iu.exec(right);
  if (leftMatch === null || rightMatch === null) return compareText(left, right);
  const number = Number(leftMatch[1]) - Number(rightMatch[1]);
  return number === 0 ? compareText(leftMatch[2].toLowerCase(), rightMatch[2].toLowerCase()) : number;
}

function buildFlatMembership(files: readonly SourceFile[]): FlatMembership {
  const roadmap = files.find((file) => file.entry.logical_path === ".planning/ROADMAP.md");
  const phaseTargets = new Map<string, string>();
  if (
    roadmap === undefined
    || roadmap.lines.some((line) => (
      /^##\s+v[\d.]+/u.test(line.text)
      || /^##\s+Milestones?\s*$/iu.test(line.text)
      || line.text === "<details>"
      || /^-\s+[✅🚧]/u.test(line.text)
    ))
  ) return { phaseTargets, taskTargets: new Map() };
  let sequence = 0;
  let observed = 0;
  for (const line of roadmap?.lines ?? []) {
    const dash = /^-\s+\[[ xX]\]\s+([\d.]+)\s+[—–-]\s+.+$/u.exec(line.text);
    const colon = /^-\s+\[[ xX]\]\s+Phase\s+(\d+):\s+.+$/u.exec(line.text);
    if (dash !== null) {
      observed += 1;
      sequence += 1;
      phaseTargets.set(normalizePhase(dash[1]), `M001/S${String(sequence).padStart(2, "0")}`);
    } else if (colon !== null) {
      observed += 1;
    }
  }
  if (phaseTargets.size !== observed) {
    return { phaseTargets: new Map(), taskTargets: new Map() };
  }
  const plans = files.flatMap((file) => {
    const match = /^\.planning\/phases\/([\d.]+)-[^/]+\/(?:[\d.]+-)?([\da-z]+)-PLAN\.md$/iu.exec(file.entry.logical_path);
    if (match === null) return [];
    const frontmatter = frontmatterValue(file, "plan")?.value;
    return frontmatter !== undefined && frontmatter !== match[2]
      ? []
      : [{ file, phase: normalizePhase(match[1]), plan: match[2] }];
  });
  const taskTargets = new Map<string, string>();
  for (const phase of new Set(plans.map((plan) => plan.phase))) {
    const phaseTarget = phaseTargets.get(phase);
    if (phaseTarget === undefined) continue;
    const ordered = plans.filter((plan) => plan.phase === phase).sort((left, right) => naturalPlanOrder(left.plan, right.plan));
    ordered.forEach((plan, index) => {
      const task = phaseTarget.startsWith("M")
        ? `${phaseTarget}/T${String(index + 1).padStart(2, "0")}`
        : `${phaseTarget}-plan-${String(index + 1).padStart(2, "0")}`;
      taskTargets.set(plan.file.entry.logical_path, task);
    });
  }
  return { phaseTargets, taskTargets };
}

function interpretProject(
  file: SourceFile,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const title = firstLine(file, /^#\s+(.+)$/u)?.match[1]?.trim() ?? "";
  const vision = file.lines.slice(1).map((line) => line.text).join("\n").trim();
  if (title.length === 0 || vision.length === 0) {
    file.outcome = "unparsed";
    addCandidate(candidates, file, { kind: "legacy-artifact", key: file.entry.logical_path }, {
      path: file.entry.logical_path, preservation: "verbatim",
    }, "malformed-project-preserve", 0, file.bytes.length, "preserve");
    addDiagnosis(
      diagnoses, file, "malformed-project", "blocker",
      "Project input lacks a heading title or vision body and cannot become an authoritative milestone.", "requires-user",
    );
    return;
  }
  addCandidate(candidates, file, { kind: "milestone", key: "M001" }, {
    id: "M001", title, vision,
  }, "planning-project-milestone");
}

function interpretRequirements(file: SourceFile, candidates: PendingCandidate[], diagnoses: PendingDiagnosis[]): void {
  const headings = file.lines.flatMap((line) => {
    const match = /^###\s+([A-Z]+-?\d+)\s+[—–-]\s+(.+)$/u.exec(line.text);
    return match === null ? [] : [{ line, match }];
  });
  if (headings.length === 0) {
    file.outcome = "unparsed";
    addCandidate(candidates, file, { kind: "legacy-artifact", key: file.entry.logical_path }, {
      path: file.entry.logical_path, preservation: "verbatim",
    }, "malformed-requirements-preserve", 0, file.bytes.length, "preserve");
    addDiagnosis(
      diagnoses, file, "malformed-requirements", "blocker",
      "Requirements input has no complete requirement rows.", "requires-user",
    );
    return;
  }
  headings.forEach(({ line, match }, index) => {
    const end = headings[index + 1]?.line.start ?? file.bytes.length;
    const section = file.lines.filter((candidate) => candidate.start >= line.start && candidate.start < end);
    const status = section.flatMap((candidate) => /^-\s*Status:\s*(.+)$/iu.exec(candidate.text)?.[1] ?? [])[0] ?? "pending";
    const description = section.flatMap((candidate) => /^-\s*Description:\s*(.+)$/iu.exec(candidate.text)?.[1] ?? [])[0] ?? "";
    const rawStart = headings.length === 1 ? 0 : line.start;
    addCandidate(candidates, file, { kind: "requirement", key: match[1] }, {
      id: match[1], title: match[2].trim(), description: description.trim(), status: status.trim(),
    }, "planning-requirement", rawStart, end);
  });
}

function interpretMultiRoadmap(
  file: SourceFile,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): boolean {
  const headingLines = file.lines.filter((line) => /^##\s+v[\d.]+\s+[—–-]\s+.+$/u.test(line.text));
  const detailsLines = file.lines.filter((line) => /^<summary>v[\d.]+\s+.+<\/summary>$/u.test(line.text));
  const summaryHeading = file.lines.find((line) => /^##\s+Milestones?\s*$/iu.test(line.text));
  const summarySubheads = file.lines.filter((line) => /^###\s+v[\d.]+\s+.+$/u.test(line.text));
  const completedRows = file.lines.filter((line) => /^-\s+\[[xX]\]\s+\*\*Phase\s+\d+:/u.test(line.text));
  const emojiRows = file.lines.filter((line) => /^-\s+[✅🚧]\s+\*\*v[\d.]+/u.test(line.text));
  const rangeRows = file.lines.filter((line) => /^-\s+[✅🚧]\s+v[\d.]+/u.test(line.text));
  const closedTableHeadings = file.lines.filter((line) => (
    /^##\s+(?:✅\s+)?v\d+(?:\.\d+)*\s+milestone\s+\(\s*CLOSED\b[^)]*\)\s*$/iu.test(line.text)
  ));
  const grammars = [
    headingLines.length > 0 ? "heading" : undefined,
    detailsLines.length > 0 ? "details" : undefined,
    summaryHeading !== undefined && summarySubheads.length > 0 ? "summary" : undefined,
    summaryHeading !== undefined && summarySubheads.length === 0 && completedRows.length > 0 ? "completed-range" : undefined,
    emojiRows.length > 0 || rangeRows.length > 0 ? "emoji-range" : undefined,
    closedTableHeadings.length > 0 ? "closed-status-table" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (grammars.length === 0) return false;
  if (grammars.length > 1) {
    file.outcome = "unparsed";
    const starts = [
      headingLines[0]?.start,
      file.lines.find((line) => line.text === "<details>")?.start,
      summaryHeading?.start,
      file.lines.find((line) => /^##\s+Completed Ranges\s*$/iu.test(line.text))?.start,
    ].filter((value): value is number => value !== undefined).sort((left, right) => left - right);
    const fragments: [string, number, number][] = [];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      let end = starts[index + 1] ?? file.bytes.length;
      const grammar = start === headingLines[0]?.start
        ? "heading"
        : start === summaryHeading?.start
          ? "summary"
          : start === file.lines.find((line) => /^##\s+Completed Ranges\s*$/iu.test(line.text))?.start
            ? "ranges"
            : "details";
      if (grammar === "details") {
        end = file.lines.find((line) => line.text === "</details>")?.end ?? end;
      }
      fragments.push([grammar, start, end]);
    }
    for (const [grammar, start, end] of fragments) {
      addCandidate(candidates, file, { kind: "legacy-roadmap-fragment", key: grammar }, {
        disposition: "preserved", grammar,
      }, "roadmap-grammar-coexists-preserve", start, end, "preserve");
    }
    const heading = file.lines[0];
    addDiagnosis(
      diagnoses,
      file,
      "competing-roadmap-grammars",
      "blocker",
      "Heading, details, summary-section, and range grammars coexist; parser precedence cannot choose milestone membership safely.",
      "requires-user",
      heading.start,
      heading.end,
      { kind: "roadmap-layout", key: "project" },
    );
    return true;
  }

  const milestoneKey = (index: number) => `M${String(index + 1).padStart(3, "0")}`;
  if (grammars[0] === "heading") {
    if (headingLines.some((heading, index) => {
      const next = headingLines[index + 1]?.start ?? file.bytes.length;
      return !file.lines.some((line) => line.start > heading.start && line.start < next && /^-\s+\[[ xX]\]\s+[\d.]+\s+[—–-]\s+.+$/u.test(line.text));
    })) return malformedRoadmap(file, candidates, diagnoses);
    headingLines.forEach((heading, milestoneIndex) => {
      const match = /^##\s+v[\d.]+\s+[—–-]\s+(.+)$/u.exec(heading.text)!;
      const nextStart = headingLines[milestoneIndex + 1]?.start ?? file.bytes.length;
      const phases = file.lines.filter((line) => line.start > heading.start && line.start < nextStart)
        .flatMap((line) => {
          const row = /^-\s+\[([ xX])\]\s+([\d.]+)\s+[—–-]\s+(.+)$/u.exec(line.text);
          return row === null ? [] : [{ line, row }];
        });
      const id = milestoneKey(milestoneIndex);
      const complete = phases.length > 0 && phases.every(({ row }) => row[1].toLowerCase() === "x");
      addCandidate(candidates, file, { kind: "milestone", key: id }, {
        grammar: "heading", id, title: match[1].trim(), status: complete ? "complete" : "active", sequence: milestoneIndex + 1,
      }, "heading-milestone", heading.start, heading.end);
      phases.forEach(({ line, row }, sliceIndex) => {
        const slice = `S${String(sliceIndex + 1).padStart(2, "0")}`;
        addCandidate(candidates, file, { kind: "slice", key: `${id}/${slice}` }, {
          grammar: "heading", id: slice, milestone_id: id, title: row[3].trim(),
          status: row[1].toLowerCase() === "x" ? "complete" : "pending", sequence: sliceIndex + 1,
        }, "heading-slice", line.start, line.end);
      });
    });
    return true;
  }

  if (grammars[0] === "details") {
    if (detailsLines.some((line) => !/^<summary>v[\d.]+\s+.+?\s+\(Phase[^)]*\)\s+--\s+[A-Z]+<\/summary>$/u.test(line.text))) {
      return malformedRoadmap(file, candidates, diagnoses);
    }
    if (detailsLines.some((summary, index) => {
      const next = detailsLines[index + 1]?.start ?? file.bytes.length;
      return !file.lines.some((line) => line.start > summary.start && line.start < next && /^-\s+\[[ xX]\]\s+[\d.]+\s+[—–-]\s+.+$/u.test(line.text));
    })) return malformedRoadmap(file, candidates, diagnoses);
    detailsLines.forEach((summary, milestoneIndex) => {
      const match = /^<summary>v[\d.]+\s+(.+?)\s+\(Phase[^)]*\)\s+--\s+([A-Z]+)<\/summary>$/u.exec(summary.text)!;
      const next = detailsLines[milestoneIndex + 1]?.start ?? file.bytes.length;
      const phases = file.lines.filter((line) => line.start > summary.start && line.start < next)
        .flatMap((line) => {
          const row = /^-\s+\[([ xX])\]\s+[\d.]+\s+[—–-]\s+(.+)$/u.exec(line.text);
          return row === null ? [] : [{ line, row }];
        });
      const id = milestoneKey(milestoneIndex);
      addCandidate(candidates, file, { kind: "milestone", key: id }, {
        grammar: "details", id, title: match[1].trim(), status: match[2] === "COMPLETED" ? "complete" : "active", sequence: milestoneIndex + 1,
      }, "details-milestone", summary.start, summary.end);
      phases.forEach(({ line, row }, sliceIndex) => {
        const slice = `S${String(sliceIndex + 1).padStart(2, "0")}`;
        addCandidate(candidates, file, { kind: "slice", key: `${id}/${slice}` }, {
          grammar: "details", id: slice, milestone_id: id, title: row[2].trim(),
          status: row[1].toLowerCase() === "x" ? "complete" : "pending", sequence: sliceIndex + 1,
        }, "details-slice", line.start, line.end);
      });
    });
    return true;
  }

  if (grammars[0] === "summary") {
    const summaryRowPattern = /^-\s+\[([ xX])\]\s+\*\*Phase\s+\d+:\s+(.+?)\*\*\s+[—–-]\s+Phases/u;
    const summaryRows = file.lines.filter((line) => summaryRowPattern.test(line.text));
    if (
      summaryRows.length === 0
      || summaryRows.length !== summarySubheads.length
      || summarySubheads.some((heading, index) => {
        const next = summarySubheads[index + 1]?.start ?? file.bytes.length;
        return !file.lines.some((line) => line.start > heading.start && line.start < next && /^-\s+\[[ xX]\]\s+\*\*Phase\s+\d+:/u.test(line.text));
      })
    ) return malformedRoadmap(file, candidates, diagnoses);
    summaryRows.forEach((line, milestoneIndex) => {
      const row = summaryRowPattern.exec(line.text)!;
      const id = milestoneKey(milestoneIndex);
      addCandidate(candidates, file, { kind: "milestone", key: id }, {
        grammar: "summary", id, title: row[2].trim(), status: row[1].toLowerCase() === "x" ? "complete" : "active", sequence: milestoneIndex + 1,
      }, "summary-milestone", line.start, line.end);
    });
    summarySubheads.forEach((heading, milestoneIndex) => {
      const next = summarySubheads[milestoneIndex + 1]?.start ?? file.bytes.length;
      const phases = file.lines.filter((line) => line.start > heading.start && line.start < next)
        .flatMap((line) => {
          const row = /^-\s+\[([ xX])\]\s+\*\*Phase\s+\d+:\s+(.+?)\*\*/u.exec(line.text);
          return row === null ? [] : [{ line, row }];
        });
      const id = milestoneKey(milestoneIndex);
      phases.forEach(({ line, row }, sliceIndex) => {
        const slice = `S${String(sliceIndex + 1).padStart(2, "0")}`;
        addCandidate(candidates, file, { kind: "slice", key: `${id}/${slice}` }, {
          grammar: "summary", id: slice, milestone_id: id, title: row[2].trim(),
          status: row[1].toLowerCase() === "x" ? "complete" : "pending", sequence: sliceIndex + 1,
        }, "summary-slice", line.start, line.end);
      });
    });
    return true;
  }

  if (grammars[0] === "completed-range") {
    const parsedRows = completedRows.map((line) => ({
      line,
      row: /^-\s+\[[xX]\]\s+\*\*Phase\s+\d+:\s+(.+?)\*\*\s+[—–-]\s+Phases\s+(\d+)-(\d+)/u.exec(line.text),
    }));
    if (parsedRows.some(({ row }) => row === null || Number(row[3]) < Number(row[2]) || Number(row[3]) - Number(row[2]) > 1000)) {
      return malformedRoadmap(file, candidates, diagnoses);
    }
    parsedRows.forEach(({ line, row }, milestoneIndex) => {
      if (row === null) return;
      const id = milestoneKey(milestoneIndex);
      addCandidate(candidates, file, { kind: "milestone", key: id }, {
        grammar: "completed-range", id, title: row[1].trim(), status: "complete", sequence: milestoneIndex + 1,
      }, "completed-range-milestone", line.start, line.end);
      const start = Number(row[2]);
      const end = Number(row[3]);
      for (let phase = start; phase <= end; phase += 1) {
        const sequence = phase - start + 1;
        const slice = `S${String(sequence).padStart(2, "0")}`;
        addCandidate(candidates, file, { kind: "slice", key: `${id}/${slice}` }, {
          grammar: "completed-range", id: slice, milestone_id: id, title: `Phase ${phase}`,
          status: "complete", sequence,
        }, "completed-range-slice", line.start, line.end);
      }
    });
    return true;
  }

  if (grammars[0] === "closed-status-table") {
    const rowPattern = /^\|\s*(?:S\d+|\d+(?:\.\d+)*)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/iu;
    if (closedTableHeadings.some((heading, index) => {
      const next = closedTableHeadings[index + 1]?.start ?? file.bytes.length;
      return !file.lines.some((line) => line.start > heading.start && line.start < next && rowPattern.test(line.text));
    })) return malformedRoadmap(file, candidates, diagnoses);

    closedTableHeadings.forEach((heading, milestoneIndex) => {
      const headingMatch = /^##\s+(?:✅\s+)?(v\d+(?:\.\d+)*)\s+milestone/iu.exec(heading.text)!;
      const next = closedTableHeadings[milestoneIndex + 1]?.start ?? file.bytes.length;
      const phases = file.lines.filter((line) => line.start > heading.start && line.start < next)
        .flatMap((line) => {
          const row = rowPattern.exec(line.text);
          return row === null ? [] : [{ line, row }];
        });
      const id = milestoneKey(milestoneIndex);
      addCandidate(candidates, file, { kind: "milestone", key: id }, {
        grammar: "closed-status-table", id, title: `${headingMatch[1]} milestone`, status: "complete", sequence: milestoneIndex + 1,
      }, "closed-status-table-milestone", heading.start, heading.end);
      phases.forEach(({ line, row }, sliceIndex) => {
        const slice = `S${String(sliceIndex + 1).padStart(2, "0")}`;
        addCandidate(candidates, file, { kind: "slice", key: `${id}/${slice}` }, {
          grammar: "closed-status-table", id: slice, milestone_id: id, title: row[1].trim(),
          status: /^(?:✅\s*)?(?:complete|completed|done|closed)$/iu.test(row[2].trim()) ? "complete" : "pending",
          sequence: sliceIndex + 1,
        }, "closed-status-table-slice", line.start, line.end);
      });
    });
    return true;
  }

  const parsedEmojiRows = [...emojiRows, ...rangeRows].sort((left, right) => left.start - right.start).map((line) => ({
    line,
    row: /^-\s+([✅🚧])\s+(?:\*\*)?v[\d.]+\s+(.+?)(?:\*\*)?\s+[—–-]\s+Phases\s+(\d+)-(\d+)/u.exec(line.text),
  }));
  if (parsedEmojiRows.length === 0 || parsedEmojiRows.some(({ row }) => row === null)) {
    return malformedRoadmap(file, candidates, diagnoses);
  }
  const heading = file.lines[0];
  addCandidate(candidates, file, { kind: "milestone", key: "M001" }, {
    grammar: "emoji-range", id: "M001", title: "Migration", status: "active", sequence: 1,
  }, "emoji-range-milestone", heading.start, heading.end);
  parsedEmojiRows.forEach(({ line, row }, index) => {
    if (row === null) return;
    const slice = `S${String(index + 1).padStart(2, "0")}`;
    addCandidate(candidates, file, { kind: "slice", key: `M001/${slice}` }, {
      grammar: "emoji-range", id: slice, milestone_id: "M001", title: row[2].trim(),
      status: row[1] === "✅" ? "complete" : "pending", sequence: index + 1,
    }, "emoji-range-slice", line.start, line.end);
  });
  return true;
}

function interpretFlatRoadmap(
  file: SourceFile,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
  files: readonly SourceFile[],
): void {
  const rows: { line: Line; match: RegExpExecArray; style: "dash" | "colon" }[] = [];
  for (const line of file.lines) {
    const dash = /^-\s+\[([ xX])\]\s+([\d.]+)\s+[—–-]\s+(.+)$/u.exec(line.text);
    const colon = /^-\s+\[([ xX])\]\s+Phase\s+(\d+):\s+(.+)$/u.exec(line.text);
    if (dash !== null) rows.push({ line, match: dash, style: "dash" });
    else if (colon !== null) rows.push({ line, match: colon, style: "colon" });
  }
  const duplicate = rows.find(({ match }, index) => (
    rows.findIndex((candidate) => normalizePhase(candidate.match[2]) === normalizePhase(match[2])) !== index
  ));
  if (duplicate !== undefined) {
    file.outcome = "unparsed";
    addCandidate(candidates, file, { kind: "legacy-roadmap-fragment", key: "duplicate-phase" }, {
      disposition: "preserved", grammar: "flat",
    }, "duplicate-phase-preserve", 0, file.bytes.length, "preserve");
    addDiagnosis(
      diagnoses, file, "duplicate-phase-number", "blocker",
      "Two roadmap rows claim the same phase number; membership requires a user choice.", "requires-user",
      duplicate.line.start, duplicate.line.end,
    );
    return;
  }
  rows.forEach(({ line, match, style }, index) => {
    if (style === "colon") {
      const phase = String(Number(match[2])).padStart(2, "0");
      file.outcome = "preserved";
      addCandidate(candidates, file, { kind: "legacy-roadmap-fragment", key: `phase-${phase}` }, {
        disposition: "preserved",
        grammar: "colon-phase",
        legacy_phase_number: phase,
        title: match[3].trim(),
        checked: match[1].toLowerCase() === "x",
      }, "unscoped-planning-phase-preserved", line.start, line.end, "preserve");
      addDiagnosis(
        diagnoses, file, "unscoped-planning-phase", "blocker",
        "Roadmap phase has no deterministic milestone identity and remains preserved until a user selects its destination.",
        "requires-user", line.start, line.end,
      );
      const phasePrefix = `.planning/phases/${String(Number(match[2])).padStart(2, "0")}-`;
      const hasSummary = files.some((candidate) => candidate.entry.logical_path.startsWith(phasePrefix) && candidate.entry.logical_path.endsWith("-SUMMARY.md"));
      if (match[1].toLowerCase() === "x" && !hasSummary) {
        addDiagnosis(
          diagnoses, file, "conflicting-completion-evidence", "blocker",
          "Checked roadmap state lacks supporting summary evidence.", "requires-user",
          line.start, line.end,
        );
      }
      return;
    }
    const slice = `S${String(index + 1).padStart(2, "0")}`;
    if (match[2].includes(".")) {
      addCandidate(candidates, file, { kind: "slice", key: `M001/${slice}` }, {
        id: slice, milestone_id: "M001", title: match[3].trim(), canonical_sequence: index + 1,
        legacy_phase_number: String(Number(match[2].split(".")[0])) + "." + match[2].split(".")[1],
        status: match[1].toLowerCase() === "x" ? "complete" : "pending",
      }, "planning-decimal-phase-alias", line.start, line.end);
    } else {
      addCandidate(candidates, file, { kind: "slice", key: `M001/${slice}` }, {
        id: slice, milestone_id: "M001", sequence: index + 1,
        status: match[1].toLowerCase() === "x" ? "complete" : "pending", title: match[3].trim(),
      }, "planning-roadmap-phase", line.start, line.end);
    }
  });
  for (const line of file.lines) {
    if (/^-\s+\[/u.test(line.text) && !rows.some((row) => row.line === line)) {
      addDiagnosis(
        diagnoses, file, "malformed-roadmap-row", "blocker",
        "Malformed roadmap membership cannot be inferred.", "requires-user",
        line.start, line.end, { kind: "roadmap-row", key: "malformed-phase" },
      );
    }
  }
  if (rows.length === 0 && !file.lines.some((line) => /^-\s+\[[^ xX]\]\s+Phase/u.test(line.text))) {
    malformedRoadmap(file, candidates, diagnoses);
  }
}

function interpretPlanningMilestoneRoadmap(
  file: SourceFile,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): boolean {
  const nonblankLines = file.lines.filter((line) => line.text.trim().length > 0);
  const milestoneHeadings = nonblankLines.flatMap((line) => {
    const match = /^##\s+Milestone\s+(M\d+):\s+(.+)$/u.exec(line.text);
    return match === null ? [] : [{ line, match }];
  });
  const phaseRows = nonblankLines.flatMap((line) => {
    const match = /^-\s+Phase\s+(\d+):\s+(.+)$/u.exec(line.text);
    return match === null ? [] : [{ line, match }];
  });
  const hasPlanningMilestoneGrammar = nonblankLines.some((line) => (
    /^##\s+Milestone\b/iu.test(line.text) || /^-\s+Phase\b/iu.test(line.text)
  ));
  if (!hasPlanningMilestoneGrammar) return false;

  const completeGrammar = nonblankLines[0]?.text === "# Roadmap"
    && milestoneHeadings.length === 1
    && milestoneHeadings[0].match[2].trim().length > 0
    && phaseRows.length === 1
    && phaseRows[0].match[2].trim().length > 0
    && nonblankLines.length === 3;
  if (!completeGrammar) return malformedRoadmap(file, candidates, diagnoses);

  const { line, match } = milestoneHeadings[0];
  const id = match[1];
  addCandidate(candidates, file, { kind: "milestone", key: id }, {
    id,
    layout: "planning",
    status: "pending",
    title: match[2].trim(),
  }, "capstone-clean-planning-milestone", line.start, line.end);
  return true;
}

function interpretFlatPlan(
  file: SourceFile,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
  aliases: ReadonlyMap<string, readonly string[]>,
  membership: FlatMembership,
): void {
  const path = /^\.planning\/phases\/([^/]+)\/([^/]+)-PLAN\.md$/u.exec(file.entry.logical_path);
  if (path === null) return;
  const directory = path[1];
  const fileStem = path[2];
  const phase = /^([\d.]+)-/u.exec(directory)?.[1] ?? "";
  const filePlan = fileStem.startsWith(`${phase}-`) ? fileStem.slice(phase.length + 1) : fileStem;
  const frontmatterPlan = frontmatterValue(file, "plan");
  if (frontmatterPlan !== undefined && frontmatterPlan.value !== filePlan) {
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses, file, "plan-number-conflict", "blocker",
      "Filename and frontmatter identify different plan numbers; user choice is required.", "requires-user",
      frontmatterPlan.line.start, frontmatterPlan.line.end,
    );
    return;
  }
  const frontmatterPhase = frontmatterValue(file, "phase");
  if (frontmatterPhase !== undefined && frontmatterPhase.value !== directory) {
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses, file, "plan-phase-conflict", "blocker",
      "Containing directory and frontmatter identify different phases; user choice is required.", "requires-user",
      frontmatterPhase.line.start, frontmatterPhase.line.end,
    );
    return;
  }
  const headingIdentity = firstLine(file, /^#\s+([\d.]+)-([\da-z]+):/iu);
  if (
    headingIdentity !== undefined
    && (normalizePhase(headingIdentity.match[1]) !== normalizePhase(phase) || headingIdentity.match[2] !== filePlan)
  ) {
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses, file, "plan-heading-conflict", "blocker",
      "Plan heading disagrees with its containing path; user choice is required.", "requires-user",
      headingIdentity.line.start, headingIdentity.line.end,
    );
    return;
  }
  const taskTarget = membership.taskTargets.get(file.entry.logical_path);
  if (taskTarget === undefined) {
    wholeFilePreservation(candidates, file, "unresolved-plan-membership-preserved-verbatim");
    addDiagnosis(
      diagnoses, file, "unresolved-plan-membership", "blocker",
      "Plan membership does not identify one roadmap phase and task position.", "requires-user",
    );
    return;
  }
  const objectiveMatch = /<objective>([\s\S]*?)<\/objective>/iu.exec(file.text);
  if (objectiveMatch !== null && objectiveMatch[1].trim().toUpperCase() === "TODO") {
    file.outcome = "unparsed";
    const start = Buffer.byteLength(file.text.slice(0, objectiveMatch.index), "utf8");
    const end = start + Buffer.byteLength(objectiveMatch[0], "utf8");
    addDiagnosis(
      diagnoses, file, "placeholder-plan", "blocker",
      "Placeholder scaffolding cannot become a fabricated task.", "requires-user", start, end,
      { kind: "task", key: taskTarget },
    );
    return;
  }
  const status = frontmatterValue(file, "status");
  if (status?.value === "skipped") {
    addCandidate(candidates, file, { kind: "task", key: taskTarget, field: "status" },
      "cancelled", "legacy-skipped-means-cancelled", status.line.start, status.line.end);
    return;
  }
  const ordering = aliases.get(phase);
  if (ordering !== undefined) {
    const sequence = ordering.indexOf(filePlan) + 1;
    const task = `T${String(sequence).padStart(2, "0")}`;
    const slice = /\/(S\d+)\//u.exec(taskTarget)?.[1] ?? "";
    addCandidate(candidates, file, { kind: "task", key: taskTarget }, {
      id: task, slice_id: slice, title: headingTitle(file), canonical_sequence: sequence,
      numbering_provenance: {
        legacy_phase: String(Number(phase.split(".")[0])) + "." + phase.split(".")[1],
        legacy_plan: filePlan, canonical_task: task, ordering,
      },
    }, "planning-plan-number-alias");
    return;
  }
  const membershipIdentity = /\/(S\d+)\/(T\d+)$/u.exec(taskTarget);
  if (membershipIdentity === null) {
    throw new Error(`legacy import planning membership target ${taskTarget} lacks slice and task identity`);
  }
  const sliceId = membershipIdentity[1];
  const taskId = membershipIdentity[2];
  const sequence = Number(taskId.slice(1));
  addCandidate(candidates, file, { kind: "task", key: taskTarget }, {
    id: taskId, slice_id: sliceId, sequence, status: "planned", title: headingTitle(file), objective: xmlValue(file.text, "objective"),
  }, "planning-plan-task");
}

function interpretFlatSummary(
  file: SourceFile,
  files: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
  membership: FlatMembership,
): void {
  const planPath = file.entry.logical_path.replace(/-SUMMARY\.md$/u, "-PLAN.md");
  const path = /^\.planning\/phases\/([^/]+)\/([\d.]+)-([\da-z]+)-SUMMARY\.md$/iu.exec(file.entry.logical_path);
  const summaryPhase = frontmatterValue(file, "phase");
  const summaryPlan = frontmatterValue(file, "plan");
  if (
    path !== null
    && ((summaryPhase !== undefined && summaryPhase.value !== path[1]) || (summaryPlan !== undefined && summaryPlan.value !== path[3]))
  ) {
    file.outcome = "unparsed";
    addCandidate(candidates, file, { kind: "legacy-artifact", key: file.entry.logical_path }, {
      path: file.entry.logical_path, preservation: "verbatim",
    }, "conflicting-summary-preserved-verbatim", 0, file.bytes.length, "preserve");
    const evidence = summaryPhase !== undefined && summaryPhase.value !== path[1] ? summaryPhase : summaryPlan;
    addDiagnosis(
      diagnoses, file, "summary-identity-conflict", "blocker",
      "Summary path and frontmatter identify different work; user choice is required.", "requires-user",
      evidence?.line.start ?? 0, evidence?.line.end ?? file.bytes.length,
    );
    return;
  }
  const taskTarget = membership.taskTargets.get(planPath);
  const planFile = files.find((candidate) => candidate.entry.logical_path === planPath);
  if (planFile === undefined || planFile.outcome !== "mapped" || taskTarget === undefined) {
    file.parserId = "gsd-lifecycle-truth";
    wholeFilePreservation(candidates, file, "orphan-summary-preserved-verbatim");
    const body = file.lines.find((line) => line.text.trim().length > 0 && !line.text.startsWith("#") && !line.text.includes(":" ) && line.text !== "---");
    const match = /phases\/([\d.]+)/u.exec(file.entry.logical_path);
    const roadmap = files.find((candidate) => candidate.entry.logical_path === ".planning/ROADMAP.md");
    const roadmapPhase = match === null ? "" : String(Number(match[1]));
    const roadmapRow = roadmap?.lines.find((line) => new RegExp(`^-\\s+\\[([ xX])\\]\\s+(?:Phase\\s+)?0*${roadmapPhase}(?:\\s|:|[—–-])`, "u").test(line.text));
    const unchecked = roadmapRow === undefined ? false : /^-\s+\[ \]/u.test(roadmapRow.text);
    if (body !== undefined && unchecked) {
      addDiagnosis(
        diagnoses, file, "conflicting-completion-evidence", "blocker",
        "An orphan summary conflicts with the unchecked roadmap state.", "requires-user",
        body.start, body.end,
      );
    } else {
      addDiagnosis(
        diagnoses, file, "orphan-summary", "blocker",
        "Summary does not identify one existing plan and cannot change lifecycle state.", "requires-user",
        body?.start ?? 0, body?.end ?? file.bytes.length,
      );
    }
    return;
  }
  const body = file.lines.slice().reverse().find((line) => line.text.trim().length > 0 && !line.text.startsWith("#"));
  const taskIdMatch = /\/(T\d+)$/u.exec(taskTarget);
  if (taskIdMatch === null) {
    throw new Error(`legacy import planning summary target ${taskTarget} lacks task identity`);
  }
  const taskId = taskIdMatch[1];
  const sliceId = /\/(S\d+)\//u.exec(taskTarget)?.[1] ?? "";
  addCandidate(candidates, file, { kind: "task", key: taskTarget, field: "status" }, {
    id: taskId, slice_id: sliceId, status: "complete", summary: body?.text.trim() ?? "",
  }, "planning-summary-completion");
}

function interpretMilestoneFiles(
  files: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): Set<string> {
  const handled = new Set<string>();
  const roadmaps = files.filter((file) => /^\.planning\/milestones\/[^/]+-ROADMAP\.md$/u.test(file.entry.logical_path));
  roadmaps.forEach((roadmap, milestoneIndex) => {
    const legacyMilestone = /^\.planning\/milestones\/(.+)-ROADMAP\.md$/u.exec(roadmap.entry.logical_path)?.[1];
    if (legacyMilestone === undefined) return;
    const milestoneId = `M${String(milestoneIndex + 1).padStart(3, "0")}`;
    const phases = roadmap.lines.flatMap((line) => {
      const match = /^-\s+\[([ xX])\]\s+(\d+)\s+[—–-]\s+(.+)$/u.exec(line.text);
      return match === null ? [] : [{ line, match }];
    });
    const malformedPhaseRows = roadmap.lines.filter((line) => /^-\s+\[/u.test(line.text) && !phases.some((phase) => phase.line === line));
    if (phases.length === 0) {
      roadmap.outcome = "unparsed";
      addCandidate(candidates, roadmap, { kind: "legacy-roadmap-fragment", key: legacyMilestone }, {
        disposition: "preserved", grammar: "milestone-directory",
      }, "malformed-roadmap-preserve", 0, roadmap.bytes.length, "preserve");
      addDiagnosis(
        diagnoses, roadmap, "malformed-roadmap-grammar", "blocker",
        "Milestone roadmap has no complete phase membership rows.", "requires-user",
        0, roadmap.bytes.length,
      );
      handled.add(roadmap.entry.logical_path);
      for (const plan of files.filter((file) => file.entry.logical_path.startsWith(`.planning/milestones/${legacyMilestone}-phases/`) && file.entry.logical_path.endsWith("-PLAN.md"))) {
        plan.outcome = "unparsed";
        addCandidate(candidates, plan, { kind: "legacy-artifact", key: plan.entry.logical_path }, {
          path: plan.entry.logical_path, preservation: "verbatim",
        }, "unresolved-milestone-plan-preserve", 0, plan.bytes.length, "preserve");
        addDiagnosis(
          diagnoses, plan, "unresolved-plan-membership", "blocker",
          "Milestone plan has no complete roadmap phase membership.", "requires-user",
        );
        handled.add(plan.entry.logical_path);
      }
      return;
    }
    const duplicate = phases.find(({ match }, index) => phases.findIndex((candidate) => candidate.match[2] === match[2]) !== index);
    if (duplicate !== undefined) {
      const related = files.filter((file) => (
        file.entry.logical_path === roadmap.entry.logical_path
        || file.entry.logical_path.startsWith(`.planning/milestones/${legacyMilestone}-phases/`)
      ));
      for (const file of related) {
        file.outcome = "unparsed";
        addCandidate(candidates, file, { kind: "legacy-artifact", key: file.entry.logical_path }, {
          disposition: "preserved", reason: "duplicate-phase-membership",
        }, "duplicate-phase-preserve", 0, file.bytes.length, "preserve");
        handled.add(file.entry.logical_path);
      }
      addDiagnosis(
        diagnoses, roadmap, "duplicate-phase-number", "blocker",
        `Two milestone roadmap rows claim phase number ${duplicate.match[2]}; membership requires an explicit user choice.`,
        "requires-user", duplicate.line.start, duplicate.line.end,
      );
      return;
    }
    const firstTitle = phases[0]?.match[3].trim() ?? legacyMilestone;
    addCandidate(candidates, roadmap, { kind: "milestone", key: milestoneId }, {
      id: milestoneId, title: `${firstTitle} Migration`, legacy_provenance: { milestone_id: legacyMilestone },
    }, "milestone-directory-roadmap", roadmap.lines[0].start, roadmap.lines[0].end);
    handled.add(roadmap.entry.logical_path);

    const phaseTargets = new Map<string, { sliceId: string; slug: string }>();
    phases.forEach(({ line, match }, phaseIndex) => {
      const sliceId = `S${String(phaseIndex + 1).padStart(2, "0")}`;
      const title = match[3].trim();
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
      phaseTargets.set(match[2], { sliceId, slug });
      addCandidate(candidates, roadmap, { kind: "slice", key: `${milestoneId}/${sliceId}` }, {
        id: sliceId, milestone_id: milestoneId, title,
        status: match[1].toLowerCase() === "x" ? "complete" : "pending", sequence: phaseIndex + 1,
        legacy_provenance: { milestone_id: legacyMilestone, phase_number: match[2], phase_slug: slug },
      }, "milestone-directory-phase", line.start, line.end);
    });
    for (const line of malformedPhaseRows) {
      addDiagnosis(
        diagnoses, roadmap, "malformed-roadmap-row", "blocker",
        "Malformed milestone roadmap membership cannot be inferred.", "requires-user",
        line.start, line.end, { kind: "roadmap-row", key: `${legacyMilestone}-malformed-phase` },
      );
    }

    const requirements = files.find((file) => file.entry.logical_path === `.planning/milestones/${legacyMilestone}-REQUIREMENTS.md`);
    if (requirements !== undefined) {
      const requirementRows: { line: Line; row: RegExpExecArray }[] = [];
      const malformedRows: Line[] = [];
      for (const line of requirements.lines) {
        const row = /^-\s+✅\s+([A-Z]+-\d+):\s+(.+)$/u.exec(line.text);
        if (row === null) {
          if (/^-\s+/u.test(line.text)) malformedRows.push(line);
          continue;
        }
        requirementRows.push({ line, row });
      }
      if (requirementRows.length === 0) {
        requirements.outcome = "unparsed";
        addCandidate(candidates, requirements, { kind: "legacy-artifact", key: requirements.entry.logical_path }, {
          path: requirements.entry.logical_path, preservation: "verbatim",
        }, "malformed-requirements-preserve", 0, requirements.bytes.length, "preserve");
        addDiagnosis(
          diagnoses, requirements, "malformed-requirements", "blocker",
          "Milestone requirements input has no complete requirement rows.", "requires-user",
        );
      }
      for (const { line, row } of requirementRows) {
        addCandidate(candidates, requirements, { kind: "requirement", key: row[1] }, {
          id: row[1], status: "validated", text: row[2].trim(),
        }, "milestone-requirement-row", line.start, line.end);
      }
      for (const line of malformedRows) {
        if (requirementRows.length === 0) break;
        addDiagnosis(
          diagnoses, requirements, "malformed-requirement-row", "blocker",
          "Malformed milestone requirement row cannot be inferred.", "requires-user",
          line.start, line.end,
        );
      }
      handled.add(requirements.entry.logical_path);
    }

    const prefix = `.planning/milestones/${legacyMilestone}-phases/`;
    const phasePlans = files.filter((file) => file.entry.logical_path.startsWith(prefix) && file.entry.logical_path.endsWith("-PLAN.md"));
    const plansByNumber = new Map<string, SourceFile[]>();
    for (const plan of phasePlans) {
      const number = /^(\d+)-/u.exec(plan.entry.logical_path.slice(prefix.length))?.[1] ?? "";
      plansByNumber.set(number, [...(plansByNumber.get(number) ?? []), plan]);
    }
    for (const [number, plans] of plansByNumber) {
      const target = phaseTargets.get(number);
      const directories = [...new Set(plans.map((plan) => plan.entry.logical_path.slice(0, plan.entry.logical_path.lastIndexOf("/"))))];
      const desiredDirectory = target === undefined ? undefined : `${prefix}${number}-${target.slug}`;
      const chosenDirectory = desiredDirectory !== undefined && directories.includes(desiredDirectory)
        ? desiredDirectory
        : directories.length === 1 ? directories[0] : undefined;
      const orderedChosen = plans.filter((plan) => (
        plan.entry.logical_path.slice(0, plan.entry.logical_path.lastIndexOf("/")) === chosenDirectory
      )).sort((left, right) => naturalPlanOrder(
        frontmatterValue(left, "plan")?.value ?? left.entry.logical_path,
        frontmatterValue(right, "plan")?.value ?? right.entry.logical_path,
      ));
      orderedChosen.forEach((plan, planIndex) => {
        const phaseDirectory = plan.entry.logical_path.slice(prefix.length).split("/")[0];
        const filePlan = /\/([^/]+)-PLAN\.md$/u.exec(plan.entry.logical_path)?.[1] ?? "";
        const phaseIdentity = frontmatterValue(plan, "phase");
        const planIdentity = frontmatterValue(plan, "plan");
        const headingIdentity = firstLine(plan, /^#\s+([\d.]+)-([\da-z]+):/iu);
        const shortHeadingIdentity = headingIdentity === undefined ? firstLine(plan, /^#\s+([\da-z]+):/iu) : undefined;
        const objective = xmlValue(plan.text, "objective");
        const match = /<objective>\s*([\s\S]*?)\s*<\/objective>/iu.exec(plan.text);
        const identityConflict = (
          (phaseIdentity !== undefined && phaseIdentity.value !== phaseDirectory)
          || (planIdentity !== undefined && planIdentity.value !== filePlan)
          || (headingIdentity !== undefined && (
            normalizePhase(headingIdentity.match[1]) !== normalizePhase(number)
            || headingIdentity.match[2] !== filePlan
          ))
          || (shortHeadingIdentity !== undefined && shortHeadingIdentity.match[1] !== filePlan)
        );
        const placeholder = objective.trim().toUpperCase() === "TODO";
        if (match === null || target === undefined || identityConflict || placeholder) {
          plan.outcome = "unparsed";
          addCandidate(candidates, plan, { kind: "legacy-artifact", key: plan.entry.logical_path }, {
            path: plan.entry.logical_path, preservation: "verbatim",
          }, "unresolved-milestone-plan-preserve", 0, plan.bytes.length, "preserve");
          addDiagnosis(
            diagnoses, plan,
            identityConflict ? "plan-identity-conflict" : placeholder ? "placeholder-plan" : "unresolved-plan-membership",
            "blocker",
            identityConflict
              ? "Milestone plan identity channels disagree; user choice is required."
              : placeholder
                ? "Placeholder scaffolding cannot become a fabricated task."
              : "Milestone plan lacks one complete roadmap membership and objective.",
            "requires-user",
          );
          return;
        }
        const contentStart = Buffer.byteLength(plan.text.slice(0, match.index), "utf8")
          + Buffer.byteLength(match[0].slice(0, match[0].indexOf(match[1])), "utf8");
        const leading = match[1].length - match[1].trimStart().length;
        const bodyStart = contentStart + Buffer.byteLength(match[1].slice(0, leading), "utf8");
        const bodyEnd = bodyStart + Buffer.byteLength(objective, "utf8");
        const taskId = `T${String(planIndex + 1).padStart(2, "0")}`;
        addCandidate(candidates, plan, { kind: "task", key: `${milestoneId}/${target.sliceId}/${taskId}` }, {
          id: taskId, milestone_id: milestoneId, slice_id: target.sliceId, title: headingTitle(plan), description: objective,
          legacy_provenance: { milestone_id: legacyMilestone, phase_number: number, phase_slug: target.slug, plan_number: frontmatterValue(plan, "plan")?.value ?? "01" },
        }, "milestone-directory-plan", bodyStart, bodyEnd);
      });
      for (const plan of plans) {
        handled.add(plan.entry.logical_path);
        if (orderedChosen.includes(plan)) continue;
        filePreserveDuplicate(plan, candidates);
        const phase = frontmatterValue(plan, "phase");
        addDiagnosis(
          diagnoses, plan, "duplicate-phase-number", "blocker",
          `Two milestone phase directories claim phase number ${number}; membership requires an explicit user choice.`,
          "requires-user", phase?.line.start ?? 0, phase?.line.end ?? plan.bytes.length,
        );
      }
    }
  });
  return handled;
}

function filePreserveDuplicate(file: SourceFile, candidates: PendingCandidate[]): void {
  wholeFilePreservation(candidates, file, "duplicate-phase-preserve", {
    disposition: "preserved", reason: "duplicate-phase-membership",
  });
  file.outcome = "unparsed";
}

const SUPPLEMENTAL: readonly [RegExp, string, string, string][] = [
  [/^\.planning\/decisions\//u, "planning-decision-not-modeled", "unmodeled-planning-decision", "Legacy decision content requires verbatim preservation."],
  [/^\.planning\/quick\//u, "planning-quick-not-modeled", "unmodeled-quick-work", "Quick work has no lossless canonical mapping in this contract."],
  [/^\.planning\/research\//u, "planning-research-not-modeled", "unmodeled-planning-research", "Legacy research requires verbatim preservation."],
  [/^\.planning\/seeds\//u, "planning-seed-not-modeled", "unmodeled-planning-seed", "Legacy seed content requires verbatim preservation."],
  [/\/[^/]+-EXTRA\.md$/u, "planning-phase-extra-not-modeled", "unmodeled-phase-extra", "Unsupported phase attachment requires verbatim preservation."],
  [/\/[^/]+-VERIFICATION\.md$/u, "planning-verification-not-modeled", "unmodeled-phase-verification", "Legacy verification text is evidence, not canonical validation."],
];

function interpretRemaining(
  file: SourceFile,
  files: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
  aliases: ReadonlyMap<string, readonly string[]>,
  membership: FlatMembership,
): void {
  const path = file.entry.logical_path;
  if (path.startsWith(".planning/.archive/")) {
    file.outcome = "ignored-with-reason";
    addDiagnosis(diagnoses, file, "archived-planning-input", "info", "Archived planning input is excluded from canonical work.", "preserved");
    return;
  }
  if (path === ".planning/config.json") {
    wholeFilePreservation(candidates, file, "planning-config-not-canonical");
    addDiagnosis(diagnoses, file, "unmodeled-planning-config", "warning", "Legacy configuration has no lossless canonical field.", "preserved");
    return;
  }
  if (path === ".planning/STATE.md") {
    wholeFilePreservation(candidates, file, "planning-state-not-canonical");
    addDiagnosis(diagnoses, file, "unmodeled-planning-state", "warning", "Legacy state cannot override database authority.", "preserved");
    return;
  }
  for (const [pattern, reason, code, message] of SUPPLEMENTAL) {
    if (!pattern.test(path)) continue;
    wholeFilePreservation(candidates, file, reason);
    addDiagnosis(diagnoses, file, code, "warning", message, "preserved");
    return;
  }
  if (/^\.planning\/milestones\/[^/]+-SUMMARY\.md$/u.test(path)) {
    wholeFilePreservation(candidates, file, "milestone-summary-preserve", { disposition: "preserved", reason: "milestone-summary-not-modeled" });
    return;
  }
  if (/^\.planning\/milestones\/[^/]+-phases\/[^/]+\/[^/]+-SUMMARY\.md$/u.test(path)) {
    wholeFilePreservation(candidates, file, "phase-summary-preserve", { disposition: "preserved", reason: "phase-summary-not-modeled" });
    return;
  }
  if (/^\.planning\/milestones\/[^/]+-phases\/[^/]+\//u.test(path)) {
    wholeFilePreservation(candidates, file, "phase-extra-preserve", { disposition: "preserved", reason: "phase-extra-not-modeled" });
    return;
  }
  if (path === ".planning/PROJECT.md") return interpretProject(file, candidates, diagnoses);
  if (path === ".planning/REQUIREMENTS.md") return interpretRequirements(file, candidates, diagnoses);
  if (path === ".planning/ROADMAP.md") {
    if (
      !interpretMultiRoadmap(file, candidates, diagnoses)
      && !interpretPlanningMilestoneRoadmap(file, candidates, diagnoses)
    ) {
      interpretFlatRoadmap(file, candidates, diagnoses, files);
    }
    return;
  }
  if (path.endsWith("-PLAN.md")) return interpretFlatPlan(file, candidates, diagnoses, aliases, membership);
  if (path.endsWith("-SUMMARY.md")) return interpretFlatSummary(file, files, candidates, diagnoses, membership);
  file.outcome = "unparsed";
  addDiagnosis(diagnoses, file, "unsupported-planning-input", "blocker", "Planning input has no supported deterministic interpretation.", "unsupported");
}

export function interpretLegacyPlanningCapture(
  capture: LegacyImportSourceCapture,
): LegacyImportPlanningInterpretation {
  const files = sourceFiles(capture);
  const candidates: PendingCandidate[] = [];
  const diagnoses: PendingDiagnosis[] = [];
  const validFiles: SourceFile[] = [];
  for (const file of files) {
    if (file.encoding === "utf-8") {
      validFiles.push(file);
      continue;
    }
    file.outcome = "unparsed";
    addDiagnosis(
      diagnoses, file, "unsupported-planning-encoding", "blocker",
      "Planning input is not valid UTF-8 and cannot be interpreted safely.", "unsupported",
      0, file.bytes.length, undefined, file.entry.sha256!,
    );
  }

  const aliases = new Map<string, readonly string[]>();
  const flatPlans = validFiles.flatMap((file) => {
    const match = /^\.planning\/phases\/([\d.]+)-[^/]+\/\1-([\da-z]+)-PLAN\.md$/iu.exec(file.entry.logical_path);
    return match === null ? [] : [{ phase: match[1], plan: match[2], file }];
  });
  for (const phase of new Set(flatPlans.map((plan) => plan.phase))) {
    const plans = flatPlans.filter((plan) => plan.phase === phase && frontmatterValue(plan.file, "plan")?.value === plan.plan);
    if (phase.includes(".") && plans.length > 0) {
      aliases.set(phase, plans.map((plan) => plan.plan).sort(naturalPlanOrder));
    }
  }

  const milestoneLayout = validFiles.some((file) => /^\.planning\/milestones\/[^/]+-ROADMAP\.md$/u.test(file.entry.logical_path));
  const flatLayout = validFiles.some((file) => (
    file.entry.logical_path === ".planning/PROJECT.md"
    || file.entry.logical_path === ".planning/ROADMAP.md"
    || file.entry.logical_path === ".planning/REQUIREMENTS.md"
    || file.entry.logical_path.startsWith(".planning/phases/")
  ));
  if (milestoneLayout && flatLayout) {
    for (const file of validFiles) {
      file.outcome = "unparsed";
      addCandidate(
        candidates, file, { kind: "legacy-artifact", key: file.entry.logical_path },
        { path: file.entry.logical_path, preservation: "verbatim" },
        "competing-planning-layouts-preserve", 0, file.bytes.length, "preserve",
      );
    }
    const evidence = validFiles.find((file) => file.entry.logical_path === ".planning/ROADMAP.md") ?? validFiles[0];
    addDiagnosis(
      diagnoses, evidence, "competing-planning-layouts", "blocker",
      "Flat and milestone-directory planning layouts coexist; milestone membership requires a user choice.",
      "requires-user", 0, evidence.bytes.length, { kind: "planning-layout", key: "project" },
    );
  } else {
    const membership = buildFlatMembership(validFiles);
    const handled = interpretMilestoneFiles(validFiles, candidates, diagnoses);
    for (const file of validFiles) {
      if (!handled.has(file.entry.logical_path)) interpretRemaining(file, validFiles, candidates, diagnoses, aliases, membership);
    }
  }

  return finalizeLegacyImportInterpretation(files, candidates, diagnoses);
}
