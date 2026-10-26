#!/usr/bin/env node
// Stand-in for the claude binary in tests: replays a recorded stream-json file.
// FAKE_STREAM picks the file; FAKE_HANG=1 waits for SIGINT before exiting without a result.
// Exits 3 if HYDE_SECRET reached it, so tests can prove the environment was scrubbed.
import { readFileSync } from 'node:fs';

if (process.env.FAKE_HANG === '1') {
  process.stdout.write(readFileSync(process.env.FAKE_STREAM, 'utf8').split('\n')[0] + '\n');
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(readFileSync(process.env.FAKE_STREAM, 'utf8'));
  process.exitCode = process.env.HYDE_SECRET ? 3 : 0;
}
