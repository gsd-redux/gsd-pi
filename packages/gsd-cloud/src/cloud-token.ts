import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";

const PREFIX = "v1.";
const ALGORITHM = "aes-256-gcm";

export function protectCloudDeviceToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, cloudTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function unprotectCloudDeviceToken(value: string): string | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  try {
    const payload = Buffer.from(value.slice(PREFIX.length), "base64url");
    if (payload.length <= 28) return undefined;
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv(ALGORITHM, cloudTokenKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function cloudTokenKey(): Buffer {
  const configuredKey = process.env["GSD_CLOUD_TOKEN_KEY"];
  const material = configuredKey && configuredKey.trim()
    ? `env:${configuredKey}`
    : `local:${hostname()}:${userInfo().username}:${homedir()}`;
  return createHash("sha256").update(material, "utf8").digest();
}
