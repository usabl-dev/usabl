#!/usr/bin/env node
/**
 * Thin CLI over `run()`. Prints `formatSummary` and exits with `result.exitCode`.
 * Sample `usabl.config.json` URLs (`http://127.0.0.1:5173`) are the fixture app's
 * Vite origin, not a hardcoded engine target. The engine reads config.
 */
import { readFile } from 'node:fs/promises';
import { run } from './run.js';
import { formatSummary } from './output/summary.js';
import type { Deps, UsablConfig } from './contracts/index.js';

async function loadConfig(path = 'usabl.config.json'): Promise<UsablConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as UsablConfig;
}

/**
 * Real browser, git, and CheckRunner wiring is not in this slice.
 * Tests inject `makeFakeDeps`. This must throw. A stub that returned empty scans
 * would mint a fake `verified`.
 */
async function buildDeps(_config: UsablConfig): Promise<Deps> {
  throw new Error('real Deps are not wired; use makeFakeDeps in tests until the browser and git adapters exist');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? 'check';
  if (command !== 'check') {
    process.stderr.write(`unknown command: ${command}\n`);
    return 2;
  }
  const config = await loadConfig();
  const deps = await buildDeps(config);
  const result = await run(deps, config);
  process.stdout.write(formatSummary(result) + '\n');
  return result.exitCode;
}

// Only run when invoked directly as the bin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Same fail-open contract as `run()`: disclose, exit 4, never a silent 0.
      process.stderr.write(`usabl: ${(err as Error).message}\n`);
      process.exit(4);
    });
}
