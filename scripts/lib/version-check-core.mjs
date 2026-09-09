#!/usr/bin/env node
// Project/App: gsd-pi
// File Purpose: Shared normalization and comparison for the version-check workflow.

// Turn a raw "GSD version" field value (e.g. "  `GSD v1.18.0`  ") into a bare
// version string ("1.18.0") so it compares equal to the npm latest release
// instead of triggering a bogus upgrade comment (issue #2191).
export function normalizeReportedVersion(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
    .replace(/^gsd\s*v?/i, "")
    .replace(/^v/i, "")
    .trim();
}

// The workflow skips (no comment, no label) when the reported value is not version-like.
export function isVersionLike(value) {
  return /^\d/.test(value);
}

function parseVersion(v) {
  const parts = v.replace(/^v/, "").split(".").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function isOutdated(reported, latest) {
  const r = parseVersion(reported);
  const l = parseVersion(latest);
  if (r[0] !== l[0]) return r[0] < l[0];
  if (r[1] !== l[1]) return r[1] < l[1];
  return r[2] < l[2];
}
