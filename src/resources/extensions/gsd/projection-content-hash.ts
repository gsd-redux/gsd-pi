import { createHash } from "node:crypto";

export function normalizeForHash(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
}

export function computeProjectionSha(content: string): string {
  return createHash("sha256").update(normalizeForHash(content)).digest("hex").slice(0, 16);
}
