#!/usr/bin/env node
/**
 * Stop the native runtime started by start.bat / start.command. Graceful: asks the supervisor to stop
 * its own services (via a request file, which also works on Windows where signals cannot be caught).
 * Only stops THIS project's processes; never deletes data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { clearState, isAlive, readState, RUN_DIR, STOP_FILE } from './runtime-files.ts';

const s = readState();
if (!s || !isAlive(s.supervisorPid)) {
  clearState();
  console.log('[stop] Not running.');
  process.exit(0);
}
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(STOP_FILE, new Date().toISOString());
console.log(`[stop] Stop requested (supervisor pid ${s.supervisorPid}); waiting…`);
const deadline = Date.now() + 45_000;
while (Date.now() < deadline) {
  if (!isAlive(s.supervisorPid)) {
    console.log('[stop] Stopped. Data kept in .data/');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.error(`[stop] Supervisor (pid ${s.supervisorPid}) did not stop within 45s. Close its window manually.`);
process.exit(1);
