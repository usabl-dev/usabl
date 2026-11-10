/**
 * The ledger is measurement only. No verdict path may import it: the gate, the run, the stop hook,
 * the CI enforce step, and checkPage. This walks the static imports of each one through the source
 * tree and checks that no ledger module is reached.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const LEDGER_MODULES = ['src/history/ledger.ts', 'src/history/ledger-git.ts', 'src/history/ledger-report.ts'];
const VERDICT_PATHS = [
  'src/gate/index.ts',
  'src/run.ts',
  'src/surfaces/stop-hook.ts',
  'src/surfaces/stop-hook-runner.ts',
  'src/surfaces/stop-hook-bin.ts',
  'src/surfaces/policy-enforce.ts',
  'src/surfaces/playwright-helper.ts',
];

// Static imports and re-exports, with or without "type", and dynamic imports of a literal path.
const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gu;

async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = await readFile(join(ROOT, file), 'utf8');
    } catch {
      // An import written inside a comment or a string, such as router examples. A real import of a
      // missing file fails the typecheck, so skipping it here hides nothing.
      continue;
    }
    seen.add(file);
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? '';
      if (!spec.startsWith('.')) continue;
      const target = relative(ROOT, resolve(dirname(join(ROOT, file)), spec)).replace(/\.js$/u, '.ts');
      // A data file, such as JSON, holds no imports.
      if (target.endsWith('.ts')) queue.push(target);
      else if (!/\.[a-z]+$/u.test(target)) queue.push(`${target}.ts`);
    }
  }
  return seen;
}

describe('the ledger stays off every verdict path', () => {
  it('walks real imports: the run reaches the debt tracking it uses', async () => {
    const fromRun = await reachable('src/run.ts');
    expect(fromRun.has('src/history/tracking.ts')).toBe(true);
    expect(fromRun.has('src/gate/index.ts')).toBe(true);
  });

  it('walks real imports: the CLI, which is not a verdict path, reaches the ledger', async () => {
    const fromCli = await reachable('src/cli.ts');
    for (const module of LEDGER_MODULES) expect(fromCli.has(module), module).toBe(true);
  });

  it.each(VERDICT_PATHS)('%s does not import the ledger', async (entry) => {
    const graph = await reachable(entry);
    for (const module of LEDGER_MODULES) {
      expect(graph.has(module), `${entry} reaches ${module}`).toBe(false);
    }
  });
});
