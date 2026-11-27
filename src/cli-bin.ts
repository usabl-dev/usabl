#!/usr/bin/env node
/**
 * Installed CLI entrypoint.
 *
 * This file always runs when Node executes dist/cli.js. Keeping the side effect in
 * its own build entry prevents code splitting from moving import.meta.url into a
 * shared chunk and turning the installed binary into a successful no-op.
 */
// First, so the stop-hook command starts its worker before the rest of usabl loads, and both load
// at once. The rest is loaded after it for the same reason.
import './surfaces/stop-hook-early.js';

const { main } = await import('./cli.js');

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // CLI failures disclose the error and stay distinct from a gate verdict.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`usabl: ${message}\n`);
    process.exitCode = 4;
  });
