/**
 * xAI Grok (SuperGrok / X Premium subscription) OAuth flow
 *
 * PKCE authorization-code flow against xAI's official OAuth service
 * (https://auth.x.ai), using the public desktop client id shipped with the
 * official Grok CLI. No client secret is involved. Endpoints are pinned to
 * the values published at https://auth.x.ai/.well-known/openid-configuration.
 *
 * Security invariant: access tokens obtained here must only ever be sent to
 * https://api.x.ai. The provider's modifyModels hook enforces that invariant
 * by rewriting any xai model whose baseUrl points at a different origin.
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
	import("node:http").then((m) => {
		_http = m;
	});
}

import type { Api, Model } from "../../types.js";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
// Public desktop OAuth client id used by the official Grok CLI. Not a secret.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
// Preferred loopback port (matches the Grok CLI registration); falls back to
// an ephemeral port if busy — loopback redirects allow any port per RFC 8252.
const PREFERRED_CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";

/** The only origin OAuth bearer tokens may be sent to. */
export const XAI_API_ORIGIN = "https://api.x.ai";
const XAI_API_BASE_URL = "https://api.x.ai/v1";

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed"; message: string; status?: number };
type TokenResult = TokenSuccess | TokenFailure;

function createState(): string {
	if (!_randomBytes) {
		throw new Error("xAI OAuth is only available in Node.js environments");
	}
	return _randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function parseTokenResponse(json: {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}, previousRefreshToken?: string): TokenResult {
	// xAI may omit refresh_token on refresh responses — keep the previous one.
	const refresh = json.refresh_token || previousRefreshToken;
	if (!json.access_token || !refresh) {
		return {
			type: "failed",
			message: `xAI token response missing fields: ${JSON.stringify(Object.keys(json))}`,
		};
	}
	const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
	return {
		type: "success",
		access: json.access_token,
		refresh,
		expires: Date.now() + expiresIn * 1000,
	};
}

async function exchangeAuthorizationCode(code: string, verifier: string, redirectUri: string): Promise<TokenResult> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		return {
			type: "failed",
			status: response.status,
			message: `xAI token exchange failed (${response.status}): ${text || response.statusText}`,
		};
	}

	return parseTokenResponse(
		(await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number },
	);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				type: "failed",
				status: response.status,
				message: `xAI token refresh failed (${response.status}): ${text || response.statusText}`,
			};
		}

		return parseTokenResponse(
			(await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number },
			refreshToken,
		);
	} catch (error) {
		return {
			type: "failed",
			message: `xAI token refresh error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	return url.toString();
}

type OAuthServerInfo = {
	port: number | null;
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
};

function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	if (!_http) {
		throw new Error("xAI OAuth is only available in Node.js environments");
	}

	let settleWait: ((value: { code: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== CALLBACK_PATH) {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthSuccessHtml("xAI authentication completed. You can close this window."));
			settleWait?.({ code });
		} catch {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
		}
	});

	const listenOn = (port: number, allowFallback: boolean): Promise<OAuthServerInfo> =>
		new Promise((resolve) => {
			server.removeAllListeners("error");
			server
				.listen(port, CALLBACK_HOST, () => {
					const address = server.address();
					const boundPort = address && typeof address === "object" ? address.port : port;
					resolve({
						port: boundPort,
						close: () => server.close(),
						cancelWait: () => {
							settleWait?.(null);
						},
						waitForCode: () => waitForCodePromise,
					});
				})
				.on("error", (_err: NodeJS.ErrnoException) => {
					if (allowFallback) {
						// Preferred port busy — retry on an ephemeral port.
						resolve(listenOn(0, false));
						return;
					}
					settleWait?.(null);
					resolve({
						port: null,
						close: () => {
							try {
								server.close();
							} catch {
								// ignore
							}
						},
						cancelWait: () => {},
						waitForCode: async () => null,
					});
				});
		});

	return listenOn(PREFERRED_CALLBACK_PORT, true);
}

/**
 * Login with xAI Grok OAuth (SuperGrok / X Premium subscription).
 *
 * Opens a browser PKCE flow against auth.x.ai with a loopback callback.
 * Headless fallback: the user pastes the redirect URL (or bare code) instead.
 */
export async function loginXai(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
}): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();
	const server = await startLocalOAuthServer(state);
	const redirectUri = `http://${CALLBACK_HOST}:${server.port ?? PREFERRED_CALLBACK_PORT}${CALLBACK_PATH}`;
	const url = buildAuthorizeUrl(challenge, state, redirectUri);

	options.onAuth({
		url,
		instructions:
			"A browser window should open. Log in with your xAI (SuperGrok / X Premium) account. On headless machines, open the URL elsewhere and paste the redirect URL back here.",
	});

	let code: string | undefined;
	try {
		if (options.onManualCodeInput) {
			// Race between browser callback and manual input
			let manualCode: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualCode = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
			} else if (manualCode) {
				const parsed = parseAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== state) {
					throw new Error("State mismatch");
				}
				code = parsed.code;
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualCode) {
					const parsed = parseAuthorizationInput(manualCode);
					if (parsed.state && parsed.state !== state) {
						throw new Error("State mismatch");
					}
					code = parsed.code;
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
			}
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code (or full redirect URL):",
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== state) {
				throw new Error("State mismatch");
			}
			code = parsed.code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		const tokenResult = await exchangeAuthorizationCode(code, verifier, redirectUri);
		if (tokenResult.type !== "success") {
			throw new Error(tokenResult.message);
		}

		return {
			access: tokenResult.access,
			refresh: tokenResult.refresh,
			expires: tokenResult.expires,
		};
	} finally {
		server.close();
	}
}

/**
 * Refresh xAI OAuth token
 */
export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	const result = await refreshAccessToken(refreshToken);
	if (result.type !== "success") {
		throw new Error(result.message);
	}
	return {
		access: result.access,
		refresh: result.refresh,
		expires: result.expires,
	};
}

/**
 * Token origin guard: with OAuth credentials in play, every xai model must
 * point at https://api.x.ai so the bearer token can never leak to another
 * origin (e.g. via a custom model definition that reuses provider "xai").
 */
export function enforceXaiTokenOrigin(models: Model<Api>[]): Model<Api>[] {
	return models.map((model) => {
		if (model.provider !== "xai") return model;
		let origin: string;
		try {
			origin = new URL(model.baseUrl).origin;
		} catch {
			origin = "";
		}
		if (origin === XAI_API_ORIGIN) return model;
		return { ...model, baseUrl: XAI_API_BASE_URL };
	});
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "Grok (SuperGrok / X Premium Subscription)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXai({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
		return enforceXaiTokenOrigin(models);
	},
};
