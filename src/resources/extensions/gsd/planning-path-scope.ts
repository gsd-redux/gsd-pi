// Project/App: GSD-2
// File Purpose: Validates planned task paths stay within the active working directory.

import { isAbsolute, relative, resolve, win32 } from "node:path";
import { normalizePlannedFileReference } from "./files.js";

export interface PlanningPathScopeField {
  field: string;
  values: string[];
}

export interface PlanningTextScopeField {
  field: string;
  text: string;
}

function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function isInsideBase(basePath: string, candidate: string): boolean {
  if (win32.isAbsolute(candidate)) {
    if (!win32.isAbsolute(basePath)) return false;
    const base = win32.resolve(basePath);
    const abs = win32.resolve(candidate);
    const rel = win32.relative(base, abs);
    return rel === "" || (!!rel && !rel.startsWith("..") && !win32.isAbsolute(rel));
  }

  const base = resolve(basePath);
  const abs = resolve(candidate);
  const rel = relative(base, abs);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Planning IO fields are execution contracts. Absolute paths are only safe when
 * they stay inside the active working directory; in worktree mode, an absolute
 * path to the original checkout makes executors edit the wrong tree.
 */
export function validatePlanningPathScope(
  basePath: string,
  fields: PlanningPathScopeField[],
): string | null {
  for (const { field, values } of fields) {
    for (const raw of values) {
      const candidate = normalizePlannedFileReference(raw);
      if (!isAbsolutePath(candidate)) continue;
      if (isInsideBase(basePath, candidate)) continue;
      return `${field} contains absolute path outside working directory: ${candidate}. Use a path relative to ${basePath}.`;
    }
  }

  return null;
}

function extractAbsolutePathReferences(text: string): string[] {
  const matches = text.matchAll(/(^|[\s`'"(<[{])((?:[A-Za-z]:[\\/]|\/)[^\s`'"<>)\]}]+)/g);
  return Array.from(matches, (match) => match[2] ?? "")
    .map((value) => value.replace(/[.,;:!?]+$/g, ""))
    .filter((value) => value !== "/" && !value.startsWith("//"));
}

/**
 * Free-form task prose still drives executor behavior. Reject absolute paths
 * there too, otherwise a plan can pass IO validation while telling execution
 * to edit the original checkout instead of the active worktree.
 */
export function validatePlanningTextPathScope(
  basePath: string,
  fields: PlanningTextScopeField[],
): string | null {
  for (const { field, text } of fields) {
    for (const candidate of extractAbsolutePathReferences(text)) {
      if (!isAbsolutePath(candidate)) continue;
      if (isInsideBase(basePath, candidate)) continue;
      return `${field} contains absolute path outside working directory: ${candidate}. Use relative paths or refer to the working directory (${basePath}).`;
    }
  }

  return null;
}
