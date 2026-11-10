/**
 * Only `usabl import figma` and `usabl drift design` call the Figma API, and only when a person
 * runs them. Nothing on the check, gate, or hook path can reach that code.
 *
 * - No module a verdict path loads imports src/import/ or src/drift/design.ts.
 * - The CLI names those modules only in dynamic imports, inside the two commands.
 * - fetch.ts is the one file in src/import/ and src/drift/ that calls fetch, and only the two
 *   commands import it.
 * - Only the two commands read FIGMA_TOKEN.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const VERDICT_ENTRY_POINTS = [
  'src/run.ts',
  'src/gate/index.ts',
  'src/deps/build.ts',
  'src/surfaces/stop-hook-runner.ts',
  'src/surfaces/stop-hook-bin.ts',
  'src/surfaces/playwright-helper.ts',
  'src/surfaces/vite-plugin.ts',
  'src/surfaces/webpack-plugin.ts',
  'src/surfaces/overlay-host.ts',
  'src/surfaces/policy-enforce.ts',
  'src/surfaces/pr-comment.ts',
  'src/judge/prepare.ts',
  'src/index.ts',
  'src/cli.ts',
  'src/cli-bin.ts',
];

const NETWORK_MODULES = (file: string): boolean => file.startsWith('src/import/') || file === 'src/drift/design.ts';

// Static imports and re-exports only. A dynamic import() runs only when the code around it runs,
// and the CLI test below pins where those sit.
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

async function staticImports(file: string): Promise<string[]> {
  const source = await readFile(join(ROOT, file), 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[1] ?? match[2] ?? '';
    if (!specifier.startsWith('.')) continue;
    found.push(relative(ROOT, resolve(ROOT, dirname(file), specifier)).replace(/\.js$/u, '.ts'));
  }
  return found;
}

async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of await staticImports(file)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .sort();
}

describe('the Figma API is reachable only from the import and drift design commands', () => {
  it.each(VERDICT_ENTRY_POINTS)('%s imports no Figma module', async (entry) => {
    const files = [...(await reachable(entry))];
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(NETWORK_MODULES)).toEqual([]);
  });

  it('follows imports through files, so an import of the fetch would be found', async () => {
    const files = await reachable('src/drift/design.ts');
    expect(files.has('src/import/figma/fetch.ts')).toBe(true);
    expect(files.has('src/surfaces/scrub.ts')).toBe(true);
  });

  it('the CLI names the Figma modules only in dynamic imports', async () => {
    const source = await readFile(join(ROOT, 'src/cli.ts'), 'utf8');
    const mentions = [...source.matchAll(/['"]\.\/(?:import\/[^'"]*|drift\/design\.js)['"]/gu)];
    expect(mentions.map((match) => match[0]).sort()).toEqual(["'./drift/design.js'", "'./import/figma/cli.js'"]);
    for (const match of mentions) {
      const before = source.slice(Math.max(0, (match.index ?? 0) - 'await import('.length), match.index);
      expect(before, `${match[0]} is not loaded by a dynamic import`).toBe('await import(');
    }
  });

  it('only fetch.ts calls fetch, and only the two commands import it', async () => {
    const files = [...(await sourceFiles('src/import')), 'src/drift/design.ts', 'src/drift/routes.ts'];
    const callers: string[] = [];
    for (const file of files) {
      const source = await readFile(join(ROOT, file), 'utf8');
      if (/\bfetch\s*\(|fetchImpl\s*\(/u.test(source)) callers.push(file);
    }
    expect(callers).toEqual(['src/import/figma/fetch.ts']);

    const importers: string[] = [];
    for (const file of await sourceFiles('src')) {
      if ((await staticImports(file)).includes('src/import/figma/fetch.ts')) importers.push(file);
    }
    expect(importers.sort()).toEqual(['src/drift/design.ts', 'src/import/figma/cli.ts']);
  });

  it('only the two commands read FIGMA_TOKEN', async () => {
    const readers: string[] = [];
    for (const file of await sourceFiles('src')) {
      if ((await readFile(join(ROOT, file), 'utf8')).includes("'FIGMA_TOKEN'")) readers.push(file);
    }
    expect(readers).toEqual(['src/drift/design.ts', 'src/import/figma/cli.ts']);
  });
});
