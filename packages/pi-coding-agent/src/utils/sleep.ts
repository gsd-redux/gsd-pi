/**
 * Sleep helper that respects abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		// Remove the abort listener on normal resolution so a long-lived signal
		// reused across repeated sleeps (retry/backoff loops) doesn't accumulate
		// listeners until it's finally aborted.
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
