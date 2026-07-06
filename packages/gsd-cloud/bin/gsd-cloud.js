#!/usr/bin/env node
// Project/App: Open GSD
// File Purpose: gsd-cloud CLI entry — inject the default gateway then delegate to the daemon.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = dirname(fileURLToPath(import.meta.url));
const target = join(binDir, '..', 'dist', 'inject-gateway.js');

if (!existsSync(target)) {
  process.stderr.write('gsd-cloud: build output missing. Run `pnpm --filter @opengsd/gsd-cloud run build`.\n');
  process.exit(1);
}

const { injectDefaultGateway } = await import('../dist/inject-gateway.js');
const { handleCloudRuntimeCommand } = await import('@opengsd/daemon');

const argv = injectDefaultGateway(process.argv.slice(2));

try {
  await handleCloudRuntimeCommand(argv, { binaryName: 'gsd-cloud' });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gsd-cloud: fatal: ${msg}\n`);
  process.exit(1);
}
