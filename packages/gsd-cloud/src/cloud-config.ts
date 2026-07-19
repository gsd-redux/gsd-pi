import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns";
import type { LookupOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadConfig } from "./config.js";
import { protectCloudDeviceToken } from "./cloud-token.js";
import type { DaemonConfig } from "./types.js";

export interface PairingExchangeResult {
  runtimeId: string;
  deviceToken: string;
}

export async function exchangePairingCode(params: {
  gatewayUrl: string;
  code: string;
  runtimeName?: string;
}): Promise<PairingExchangeResult> {
  const pairingUrl = new URL("/pairing/exchange", parseCloudGatewayUrl(params.gatewayUrl));
  const body = await postJsonToValidatedGateway(pairingUrl, {
    code: params.code,
    runtimeName: params.runtimeName,
  });
  if (typeof body.runtimeId !== "string" || typeof body.deviceToken !== "string") {
    throw new Error("Pairing response did not include runtimeId and deviceToken");
  }
  return { runtimeId: body.runtimeId, deviceToken: body.deviceToken };
}

export function parseCloudGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud gateway URL must be an absolute HTTP(S) URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Cloud gateway URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Cloud gateway URL must not include credentials");
  }
  if (url.hash) {
    throw new Error("Cloud gateway URL must not include a fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Plain HTTP cloud gateway URLs are only allowed for localhost");
  }
  if (url.protocol === "https:" && isPrivateIpHost(url.hostname)) {
    throw new Error("Cloud gateway URL must not target private or loopback IP addresses");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  return url;
}

export function saveCloudConfig(
  configPath: string,
  nextCloud: NonNullable<DaemonConfig["cloud"]>,
  projectDirs?: string[],
): DaemonConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> ?? {};
  } catch {
    raw = {};
  }
  const existingCloud = raw.cloud != null && typeof raw.cloud === "object"
    ? raw.cloud as Record<string, unknown>
    : {};
  const { device_token: _legacyDeviceToken, ...preservedCloud } = existingCloud;
  const { device_token: deviceToken, ...cloud } = nextCloud;
  raw.cloud = {
    ...preservedCloud,
    ...cloud,
    gateway_url: parseCloudGatewayUrl(nextCloud.gateway_url).toString(),
    ...(deviceToken ? { device_token_encrypted: protectCloudDeviceToken(deviceToken) } : {}),
  };
  if (projectDirs) {
    const projects = raw.projects != null && typeof raw.projects === "object"
      ? raw.projects as Record<string, unknown>
      : {};
    raw.projects = { ...projects, scan_roots: projectDirs };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeConfigFile(configPath, stringifyYaml(raw));
  return loadConfig(configPath);
}

export function clearCloudConfig(configPath: string): DaemonConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> ?? {};
  } catch {
    raw = {};
  }
  delete raw.cloud;
  mkdirSync(dirname(configPath), { recursive: true });
  writeConfigFile(configPath, stringifyYaml(raw));
  return loadConfig(configPath);
}

export function redactedCloudStatus(config: DaemonConfig): Record<string, unknown> {
  const cloud = config.cloud;
  if (!cloud) return { configured: false };
  return {
    configured: true,
    enabled: cloud.enabled ?? true,
    gateway_url: cloud.gateway_url,
    runtime_id: cloud.runtime_id ?? null,
    runtime_name: cloud.runtime_name ?? null,
    ["device_" + "token"]: cloud.device_token ? "[redacted]" : null,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPrivateIpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) === 6) return isPrivateIpv6(host);
  return false;
}

export function validateGatewayNetworkTarget(url: URL): void {
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  if (isPrivateIpHost(url.hostname)) {
    throw new Error("Cloud gateway URL must not target private or loopback IP addresses");
  }
}

export function createGatewayLookup(url: URL): LookupFunction {
  const allowLoopback = url.protocol === "http:" && isLoopbackHost(url.hostname);
  const rejected = (address: string): boolean =>
    !address || (!allowLoopback && isPrivateIpHost(address));
  // Node's socket connect (autoSelectFamily / Happy Eyeballs, default-on since
  // Node 20) calls a custom lookup with `all: true` and expects an ARRAY
  // callback. Forcing `all: false` + a scalar callback made every real gateway
  // request throw "Invalid IP address: undefined". Honor both forms; the SSRF
  // guard is applied to every resolved address (reject the whole lookup if any
  // is private/loopback — an attacker-controlled resolver must not slip one in).
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const wantsAll =
      typeof options === "object" && options !== null && (options as LookupOptions).all === true;
    const base: LookupOptions =
      typeof options === "number" ? { family: options } : { ...(options as LookupOptions) };
    if (wantsAll) {
      lookup(hostname, { ...base, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = addresses as Array<{ address: string; family: number }>;
        if (!list.length || list.some((entry) => rejected(entry.address))) {
          return callback(new Error("Cloud gateway URL resolved to a private or loopback address"));
        }
        callback(null, list);
      });
      return;
    }
    lookup(hostname, { ...base, all: false }, (err, address, family) => {
      if (err) return callback(err, address, family);
      if (rejected(address)) {
        return callback(new Error("Cloud gateway URL resolved to a private or loopback address"), address, family);
      }
      callback(null, address, family);
    });
  }) as unknown as LookupFunction;
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  return host === "::"
    || host === "::1"
    || host.startsWith("fc")
    || host.startsWith("fd")
    || host.startsWith("fe80:")
    || host.startsWith("2001:db8:");
}

function writeConfigFile(configPath: string, contents: string): void {
  writeFileSync(configPath, contents, { encoding: "utf-8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}

const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;

export function postJsonToValidatedGateway(
  url: URL,
  payload: Record<string, unknown>,
  timeoutMs: number = GATEWAY_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  validateGatewayNetworkTarget(url);
  const body = JSON.stringify(payload);
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
      lookup: createGatewayLookup(url),
    }, (res) => {
      const statusCode = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const responseText = Buffer.concat(chunks).toString("utf-8");
        const parsed = parseJsonObject(responseText);
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(typeof parsed.error === "string" ? parsed.error : `Pairing failed with HTTP ${statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Gateway request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
