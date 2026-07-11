import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function canonicalConfigPath(configPath: string): string {
  const absolutePath = resolve(configPath);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function runtimeArtifactPath(
  configPath: string,
  artifact: "status" | "state" | "log" | "start.lock",
): string {
  const canonicalPath = canonicalConfigPath(configPath);
  const legacy = basename(canonicalPath) === "daemon.yaml";
  const namespace = legacy
    ? ""
    : `-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16)}`;
  let suffix: string;
  switch (artifact) {
    case "status": suffix = "-status.json"; break;
    case "state": suffix = ".json"; break;
    case "log": suffix = ".log"; break;
    case "start.lock": suffix = ".start.lock"; break;
  }
  return join(dirname(canonicalPath), `cloud-runtime${namespace}${suffix}`);
}
