/**
 * The sensitivity measurement is unreachable from a normal run, and nothing that decides a verdict
 * reads what it writes.
 *
 * - No module a verdict path loads imports the sensitivity code: run(), the gate, buildDeps, the
 *   stop hook, the overlay, the CI judge and comment, checkPage, and the library entry.
 * - The CLI loads it only inside the verify command, by a dynamic import.
 * - The browser the normal composition root builds has no mutation hook.
 * - run() never reads .usabl/sensitivity.json, and the file being there changes nothing.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../../src/contracts/index.js';
import { buildDeps } from '../../../src/deps/build.js';
import { makeFakeDeps } from '../../../src/deps/fakes.js';
import { SENSITIVITY_ATTESTATION_PATH } from '../../../src/measure/sensitivity/attestation.js';
import { run } from '../../../src/run.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SENSITIVITY_DIR = 'src/measure/sensitivity/';

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

// Static imports and re-exports only. A dynamic import() is not followed, because it runs only when
// the code around it runs, and the CLI test below pins where the CLI's one dynamic import sits.
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

async function staticImports(file: string): Promise<string[]> {
  const source = await readFile(join(ROOT, file), 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[1] ?? match[2] ?? '';
    if (!specifier.startsWith('.')) continue;
    const target = relative(ROOT, resolve(ROOT, dirname(file), specifier)).replace(/\.js$/, '.ts');
    found.push(target);
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
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['src/Clusters.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

describe('a normal run cannot reach the mutation step', () => {
  it.each(VERDICT_ENTRY_POINTS)('%s imports no sensitivity module', async (entry) => {
    const files = [...(await reachable(entry))];
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => file.startsWith(SENSITIVITY_DIR))).toEqual([]);
  });

  it('follows imports through files, so a sensitivity import would be found', async () => {
    const files = await reachable('src/measure/sensitivity/command.ts');
    expect(files.has('src/measure/sensitivity/attestation.ts')).toBe(true);
    expect(files.has('src/surfaces/scrub.ts')).toBe(true);
  });

  it('the CLI loads the sensitivity modules only inside the verify command', async () => {
    const source = await readFile(join(ROOT, 'src/cli.ts'), 'utf8');
    const start = source.indexOf('async function runVerify(');
    const end = source.indexOf('export async function main(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const mentions = [...source.matchAll(/measure\/sensitivity\//g)].map((match) => match.index ?? -1);
    expect(mentions.length).toBeGreaterThan(0);
    for (const at of mentions) {
      expect(at > start && at < end, `measure/sensitivity is named outside runVerify at ${at}`).toBe(true);
    }
  });

  it('the browser the normal composition root builds has no mutation hook', async () => {
    const deps = await buildDeps(config, { cwd: ROOT, env: {}, warn: () => {} });
    try {
      expect('arm' in deps.browser).toBe(false);
    } finally {
      await deps.browser.close();
    }
  });
});

describe('no verdict path reads the attestation', () => {
  it('only the attestation module names the file', async () => {
    const naming: string[] = [];
    for (const file of await sourceFiles('src')) {
      const source = await readFile(join(ROOT, file), 'utf8');
      if (source.includes('sensitivity.json')) naming.push(file);
    }
    expect(naming).toEqual(['src/measure/sensitivity/attestation.ts']);
    expect(SENSITIVITY_ATTESTATION_PATH).toBe('.usabl/sensitivity.json');
  });

  it('run() never reads the file, and the result is the same with it there', async () => {
    const claim = JSON.stringify({ schemaVersion: 'usabl.sensitivity.v1', levels: { fixture: { totals: { caught: 99 } } } });
    const spec = {
      files: { 'usabl.config.json': '{}', 'src/Clusters.tsx': 'export {}' },
      headContents: { 'usabl.config.json': '{}' },
      changed: [{ code: 'M', path: 'src/Clusters.tsx' }],
      scans: {
        clusters: {
          screenId: 'clusters',
          url: 'http://127.0.0.1:5173/clusters',
          stops: [],
          drafts: [
            {
              rule: 'button-name',
              layer: 'axe',
              severity: 'serious' as const,
              evidenceClass: 'deterministic' as const,
              screenId: 'clusters',
              elementPath: '#save',
              elementName: null,
              role: 'button',
              whatUserExperiences: 'A button has no name.',
              why: '',
              fix: '',
              evidence: {},
              confidence: 'fail' as const,
            },
          ],
          gaps: [],
          applicability: [],
          reachedSelectorPresent: null,
        },
      },
    };

    const read: string[] = [];
    const shown: string[] = [];
    const withFile = makeFakeDeps({ ...spec, files: { ...spec.files, [SENSITIVITY_ATTESTATION_PATH]: claim } });
    const recording = {
      ...withFile,
      fs: {
        ...withFile.fs,
        readFile: async (path: string) => {
          read.push(path);
          return withFile.fs.readFile(path);
        },
      },
      git: {
        ...withFile.git,
        show: async (ref: string, path: string) => {
          shown.push(path);
          return withFile.git.show(ref, path);
        },
      },
    };
    const withResult = await run(recording, config);
    const withoutResult = await run(makeFakeDeps(spec), config);

    expect(read.length).toBeGreaterThan(0);
    expect(read).not.toContain(SENSITIVITY_ATTESTATION_PATH);
    expect(shown).not.toContain(SENSITIVITY_ATTESTATION_PATH);
    expect(withResult.verdict).toBe('regression');
    expect(withResult).toEqual(withoutResult);
  });
});
