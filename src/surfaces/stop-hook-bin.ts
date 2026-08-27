#!/usr/bin/env node
/**
 * Installed Stop hook entrypoint.
 *
 * This entry always runs when Node executes dist/stop-hook-runner.js. It stays
 * separate from the importable runner so linked packages cannot become a no-op.
 */
import { main } from './stop-hook-runner.js';

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`NOT verified - stop hook error: ${message}\n`);
    process.exit(0);
  });
