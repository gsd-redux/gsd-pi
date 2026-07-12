import { existsSync, readFileSync, rmSync } from "node:fs";

import {
  computeProjectionSha,
  deriveCompatProjectionKey,
  readCompatMarker,
  writeCompatMarker,
} from "./compat/compat-marker.js";
import { deleteArtifactByPath, getArtifact } from "./gsd-db.js";
import { gsdProjectionRoot, gsdRoot } from "./paths.js";

export function removeOwnedPlanProjection(basePath: string, planPath: string): boolean {
  const projectionKey = deriveCompatProjectionKey(planPath, [gsdProjectionRoot(basePath), gsdRoot(basePath)]);
  const artifact = getArtifact(projectionKey);
  const marker = readCompatMarker(basePath);

  if (existsSync(planPath)) {
    const content = readFileSync(planPath, "utf8");
    const contentSha = computeProjectionSha(content);
    const markerOwnsCurrentContent = marker.projections[projectionKey]?.sha === contentSha;
    const artifactOwnsCurrentContent = artifact?.artifact_type === "PLAN" &&
      computeProjectionSha(artifact.full_content) === contentSha;
    if (!markerOwnsCurrentContent && !artifactOwnsCurrentContent) return false;
    rmSync(planPath, { force: true });
  } else if (artifact?.artifact_type !== "PLAN") {
    return false;
  }

  if (artifact?.artifact_type === "PLAN") deleteArtifactByPath(projectionKey);
  if (marker.projections[projectionKey]) {
    delete marker.projections[projectionKey];
    writeCompatMarker(basePath, marker);
  }
  return true;
}
