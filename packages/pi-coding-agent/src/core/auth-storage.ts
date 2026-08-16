/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@gsd/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@gsd/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
import { normalizePath } from "../utils/paths.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential | AuthCredential[]>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

type ResolvedApiKey = {
	apiKey: string;
	isOAuth: boolean;
};

type RefreshedOAuthApiKey = {
	apiKey: string;
	newCredentials: OAuthCredentials;
};

function isUsableApiKeyCredential(credential: AuthCredential): credential is ApiKeyCredential {
	return credential.type === "api_key" && credential.key.trim().length > 0;
}

function isUsableStoredCredential(credential: AuthCredential): boolean {
	return credential.type === "oauth" || isUsableApiKeyCredential(credential);
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	getCredentialsForProvider(provider: string): AuthCredential[] {
		const entry = this.data[provider];
		if (!entry) return [];
		if (Array.isArray(entry)) return entry;
		return [entry];
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(
		provider: string,
		credential: AuthCredential | AuthCredential[] | undefined,
	): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.getCredentialsForProvider(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data[provider] = credential;
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return this.getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.getCredentialsForProvider(provider).some(isUsableStoredCredential)) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	private providerBackoff = new Map<string, number>();

	isProviderAvailable(provider: string): boolean {
		const expiresAt = this.providerBackoff.get(provider);
		if (expiresAt === undefined) return true;
		if (Date.now() >= expiresAt) {
			this.providerBackoff.delete(provider);
			return true;
		}
		return false;
	}

	markProviderExhausted(provider: string, _errorType?: string): void {
		this.providerBackoff.set(provider, Date.now() + 60_000);
	}

	areAllCredentialsBackedOff(provider: string): boolean {
		return !this.isProviderAvailable(provider);
	}

	getProviderBackoffRemaining(provider: string): number {
		const expiresAt = this.providerBackoff.get(provider);
		if (expiresAt === undefined) return 0;
		return Math.max(0, expiresAt - Date.now());
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.getCredentialsForProvider(provider).some(isUsableStoredCredential)) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<RefreshedOAuthApiKey | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync<RefreshedOAuthApiKey | null>(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const entry = currentData[providerId];
			const oauthEntry = Array.isArray(entry)
				? entry.find((candidate) => candidate.type === "oauth")
				: entry?.type === "oauth"
					? entry
					: undefined;
			if (!oauthEntry || oauthEntry.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < oauthEntry.expires) {
				return { result: { apiKey: provider.getApiKey(oauthEntry), newCredentials: oauthEntry } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				const entries = Array.isArray(value) ? value : value ? [value] : [];
				for (const candidate of entries) {
					if (candidate.type === "oauth") {
						oauthCreds[key] = candidate;
					}
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. OAuth token from auth.json (when provider supports OAuth login)
	 * 3. API key from auth.json (including fallback when OAuth refresh fails)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKeyWithOAuthState(
		providerId: string,
		options?: { includeFallback?: boolean },
	): Promise<ResolvedApiKey | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return { apiKey: runtimeKey, isOAuth: false };
		}

		const creds = this.getCredentialsForProvider(providerId);
		const apiKeyCredential = creds.find(isUsableApiKeyCredential);
		const oauthCredential = creds.find((entry) => entry.type === "oauth");
		// Prefer OAuth for providers that support subscription login (anthropic,
		// github-copilot, openai-codex). Users often have both OAuth and a stale
		// API key on disk; subscription auth should win unless --api-key overrides.
		const cred =
			oauthCredential && getOAuthProvider(providerId)
				? oauthCredential
				: (apiKeyCredential ?? oauthCredential);

		if (cred?.type === "api_key") {
			const apiKey = resolveConfigValue(cred.key);
			return apiKey ? { apiKey, isOAuth: false } : undefined;
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// Unknown OAuth provider, can't get API key
				return undefined;
			}

			const resolveStoredApiKey = (): string | undefined =>
				apiKeyCredential ? resolveConfigValue(apiKeyCredential.key) : undefined;

			// Check if token needs refresh
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// Use locked refresh to prevent race conditions
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return { apiKey: result.apiKey, isOAuth: true };
					}
				} catch (error) {
					this.recordError(error);
				}

				// Refresh failed or returned nothing - re-read file to check if another instance succeeded
				this.reload();
				const updatedCred = this.getCredentialsForProvider(providerId).find(
					(entry) => entry.type === "oauth",
				);

				if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
					return { apiKey: provider.getApiKey(updatedCred), isOAuth: true };
				}

				const storedApiKey = resolveStoredApiKey();
				if (storedApiKey) {
					return { apiKey: storedApiKey, isOAuth: false };
				}
			} else {
				// Token not expired, use current access token
				return { apiKey: provider.getApiKey(cred), isOAuth: true };
			}
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return { apiKey: envKey, isOAuth: false };

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			const apiKey = this.fallbackResolver?.(providerId);
			return apiKey ? { apiKey, isOAuth: false } : undefined;
		}

		return undefined;
	}

	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		return (await this.getApiKeyWithOAuthState(providerId, options))?.apiKey;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
