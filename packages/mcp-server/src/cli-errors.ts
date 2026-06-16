type GlobalErrorEvent = 'uncaughtException' | 'unhandledRejection';

interface GlobalErrorRuntime {
  on(event: GlobalErrorEvent, listener: (error: unknown) => void): unknown;
  stderr: {
    write(message: string): unknown;
  };
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function installGlobalErrorHandlers(runtime: GlobalErrorRuntime = process as GlobalErrorRuntime): void {
  runtime.on('uncaughtException', (error) => {
    runtime.stderr.write(`[gsd-mcp-server] Uncaught exception: ${formatUnknownError(error)}\n`);
  });

  runtime.on('unhandledRejection', (reason) => {
    runtime.stderr.write(`[gsd-mcp-server] Unhandled rejection: ${formatUnknownError(reason)}\n`);
  });
}
