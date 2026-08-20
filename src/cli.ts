#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { run } from './run.js';
import { formatSummary } from './output/summary.js';
import type { Deps, UsablConfig } from './contracts/index.js';

async function loadConfig(path = 'usabl.config.json'): Promise<UsablConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as UsablConfig;
}

/**
 * Build real Deps. Full implementations (Playwright browser, git plumbing, axe/pf/walk
 * CheckRunner) land in Phases 2-3. This wiring point stays stable.
 */
async function buildDeps(_config: UsablConfig): Promise<Deps> {
  throw new Error('real Deps are implemented in Phases 2-3; use makeFakeDeps in tests until then');
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
      process.stderr.write(`usabl: ${(err as Error).message}\n`);
      process.exit(4);
    });
}
