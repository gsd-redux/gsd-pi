// GSD-2 / unit-runtime concurrent-lock fixture
//
// Spawned by unit-runtime-concurrent.test.ts. Each child process performs a
// single read-modify-write cycle against the shared record under the
// per-record advisory lock. If the lock works, every increment is preserved
// and the final count equals the number of children spawned.

import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "../../unit-runtime.ts";

const base = process.argv[2];
if (!base) {
  console.error("missing base path");
  process.exit(2);
}

const existing = readUnitRuntimeRecord(base, "execute-task", "M001/S01/T01");
const prev = existing?.progressCount ?? 0;
writeUnitRuntimeRecord(base, "execute-task", "M001/S01/T01", 1000, {
  phase: "dispatched",
  progressCount: prev + 1,
});
