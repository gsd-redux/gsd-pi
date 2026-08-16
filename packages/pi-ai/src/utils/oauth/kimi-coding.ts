/**
 * Kimi Code (subscription) OAuth flow
 *
 * RFC 8628 device authorization grant against https://auth.kimi.com with JSON
 * responses. The access token authenticates requests to
 * https://api.kimi.com/coding as an `Authorization: Bearer` header.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REFRESH_MAX_RETRIES = 3;

interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

interface TokenResult {
	access: string;
	refresh: string;
	expires: number;
}

function getOauthHost(): string {
	const override =
		(typeof process !== "undefined" && process.env
			? process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST
			: undefined) || undefined;
	return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function formUrlEncode(fields: Record<string, string>): string {
	return new URLSearchParams(fields).toString();
}

async function readJson(response: Response): Promise<any | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" ? json : null;
	} catch {
		return null;
	}
}

/** The verification URI is opened in the user's browser; only http(s) URLs are trusted. */
function trustedHttpUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href;
	} catch {
		return null;
	}
}

async function startDeviceAuthorization(oauthHost: string, signal?: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: formUrlEncode({ client_id: CLIENT_ID }),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`,
		);
	}
	const json = await readJson(response);
	const deviceCode = json?.device_code;
	const userCode = json?.user_code;
	const verificationUri = json?.verification_uri;
	const verificationUriComplete = json?.verification_uri_complete;
	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof verificationUriComplete !== "string" ||
		!trustedHttpUrl(verificationUriComplete) ||
		!trustedHttpUrl(verificationUri)
	) {
		throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
	}
	const interval = json?.interval;
	const expiresIn = json?.expires_in;
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete,
		intervalSeconds:
			typeof interval === "number" && Number.isFinite(interval) && interval > 0
				? interval
				: DEFAULT_POLL_INTERVAL_SECONDS,
		expiresInSeconds:
			typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
				? expiresIn
				: DEVICE_CODE_TIMEOUT_SECONDS,
	};
}

function parseTokenResponse(json: any, operation: string): TokenResult {
	const accessToken = json?.access_token;
	const refreshToken = json?.refresh_token;
	const expiresIn = json?.expires_in;
	const invalidFields: string[] = [];
	if (typeof accessToken !== "string" || !accessToken) {
		invalidFields.push("access_token");
	}
	if (typeof refreshToken !== "string" || !refreshToken) {
		invalidFields.push("refresh_token");
	}
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		invalidFields.push("expires_in");
	}
	if (invalidFields.length > 0) {
		throw new Error(`Kimi Code token ${operation} response has invalid fields: ${invalidFields.join(", ")}`);
	}
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + expiresIn * 1000,
	};
}

function abortableSleep(ms: number, signal: AbortSignal | undefined, cancelMessage: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(cancelMessage));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(cancelMessage));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function pollForToken(oauthHost: string, device: DeviceAuthorization, signal?: AbortSignal): Promise<TokenResult> {
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	let intervalMs = Math.max(1000, device.intervalSeconds * 1000);
	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		await abortableSleep(Math.min(intervalMs, deadline - Date.now()), signal, "Login cancelled");
		const response = await fetch(`${oauthHost}/api/oauth/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: formUrlEncode({
				client_id: CLIENT_ID,
				device_code: device.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
			signal: requestSignal(signal),
		});
		if (response.status >= 500) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ""}`,
			);
		}
		const json = await readJson(response);
		if (response.ok && typeof json?.access_token === "string") {
			return parseTokenResponse(json, "poll");
		}
		const error = json?.error;
		const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
		if (error === "authorization_pending") {
			continue;
		}
		if (error === "slow_down") {
			// RFC 8628 section 3.5: increase the poll interval by 5 seconds.
			intervalMs += 5000;
			continue;
		}
		if (error === "expired_token") {
			throw new Error("Kimi Code device authorization expired. Please restart login.");
		}
		if (error === "access_denied") {
			throw new Error("Kimi Code login was denied.");
		}
		throw new Error(
			`Kimi Code device token request failed (status ${response.status})${typeof error === "string" ? `: ${error}${description}` : ""}`,
		);
	}
	throw new Error("Device flow timed out");
}

function isRetryableRefreshFailure(response: Response): boolean {
	return response.status === 429 || response.status >= 500;
}

function safeRefreshErrorSuffix(json: any): string {
	switch (json?.error) {
		case "invalid_client":
		case "invalid_grant":
		case "invalid_request":
		case "invalid_scope":
		case "unauthorized_client":
		case "unsupported_grant_type":
			return `: ${json.error}`;
		default:
			return "";
	}
}

async function refreshKimiToken(oauthHost: string, refreshTokenValue: string, signal?: AbortSignal): Promise<TokenResult> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await abortableSleep(1000 * 2 ** (attempt - 1), signal, "Kimi Code token refresh aborted");
		}
		if (signal?.aborted) {
			throw new Error("Kimi Code token refresh aborted");
		}
		let response: Response;
		try {
			response = await fetch(`${oauthHost}/api/oauth/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: formUrlEncode({
					client_id: CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: refreshTokenValue,
				}),
				signal: requestSignal(signal),
			});
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			continue;
		}
		const json = await readJson(response);
		if (response.ok) {
			return parseTokenResponse(json, "refresh");
		}
		// Unauthorized: the stored credential is dead; clear it and re-login.
		if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant") {
			throw new Error(
				`Kimi Code token refresh unauthorized (status ${response.status})${safeRefreshErrorSuffix(json)}`,
			);
		}
		if (isRetryableRefreshFailure(response) && attempt < REFRESH_MAX_RETRIES) {
			lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`);
			continue;
		}
		throw new Error(`Kimi Code token refresh failed with status ${response.status}${safeRefreshErrorSuffix(json)}`);
	}
	throw lastError ?? new Error("Kimi Code token refresh failed");
}

/**
 * Run the Kimi Code device-authorization login flow.
 */
export async function loginKimiCoding(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const oauthHost = getOauthHost();
	const device = await startDeviceAuthorization(oauthHost, callbacks.signal);
	callbacks.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	const token = await pollForToken(oauthHost, device, callbacks.signal);
	return { ...token };
}

/**
 * Refresh Kimi Code OAuth credentials.
 */
export async function refreshKimiCodingToken(refreshTokenValue: string): Promise<OAuthCredentials> {
	const token = await refreshKimiToken(getOauthHost(), refreshTokenValue);
	return { ...token };
}

export const kimiCodingOAuthProvider: OAuthProviderInterface = {
	id: "kimi-coding",
	name: "Kimi Code (subscription)",
	async login(callbacks) {
		return loginKimiCoding(callbacks);
	},
	async refreshToken(credentials) {
		return refreshKimiCodingToken(credentials.refresh);
	},
	getApiKey(credentials) {
		return credentials.access;
	},
};
