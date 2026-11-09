/**
 * A changed file reaches the planner with the name git stores, however git would print it.
 *
 * Without -z, git quotes a name with a byte above 0x7f, so a pull request that edits
 * `src/pages/Über.tsx` listed `"src/pages/\303\234ber.tsx"`. That matched no UI glob, the CI run
 * was idle, and the gate passed. These tests list the change from a real git repository the way
 * the CI command does (the merge-base diff joined with the status paths), then plan and run it
 * with a trusted ref. The file system and git are real. Only the check runner is scripted.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { run } from '../../src/run.js';
import { mergeChangedPaths } from '../../src/surfaces/cli.js';

const execFileAsync = promisify(execFile);
const UMLAUT = 'src/pages/Über.tsx';
const TRUSTED_REF = 'main';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

async function write(root: string, path: string, contents: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents, 'utf8');
}

/**
 * main holds the config, the app, and `src/pages/Über.tsx`. A feature branch changes that page,
 * as a pull request would, and is checked out. With `routed`, main's usabl.routes.json names the
 * page as the entry of a screen.
 */
async function repoWithUmlautChange(routed: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-names-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'core.quotePath', 'true']);
  await write(root, 'usabl.config.json', JSON.stringify(config));
  await write(root, 'src/App.tsx', 'export default function App() { return null }\n');
  await write(root, UMLAUT, 'export default function Uber() { return null }\n');
  if (routed) {
    await write(
      root,
      'usabl.routes.json',
      JSON.stringify({ routes: [{ screenId: 'uber', url: '/uber', entryFile: UMLAUT }] }),
    );
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'main']);
  await git(root, ['checkout', '-b', 'feature']);
  await write(root, UMLAUT, 'export default function Uber() { return <main>changed</main> }\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'change the page']);
  return root;
}

function realDeps(root: string, scanned: string[]): Deps {
  const fake = makeFakeDeps();
  return {
    ...fake,
    git: makeGitReader({ cwd: root }),
    fs: makeFsGlob({ cwd: root }),
    checkRunner: {
      scan: async (screen) => {
        scanned.push(screen.id);
        return fake.checkRunner.scan(screen);
      },
    },
  };
}

async function changedFilesAsCi(deps: Deps): Promise<string[]> {
  const diffNames = await deps.git.diffNameOnly(TRUSTED_REF);
  const statusPaths = (await deps.git.statusZ()).map((entry) => entry.path);
  return mergeChangedPaths(diffNames, statusPaths);
}

// Each test spawns a few dozen git processes, which takes more than the default five seconds on a
// busy machine.
const REAL_GIT = { timeout: 30_000 };

describe('a changed file whose name git would quote', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reaches the planner with its true name', async () => {
    root = await repoWithUmlautChange(true);
    const deps = realDeps(root, []);
    const changed = await changedFilesAsCi(deps);
    expect(changed).toEqual([UMLAUT]);
    const coverage = await computeCoverage(deps.fs, config, changed);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['uber']);
  });

  it('is scanned by a run with a trusted ref when a route renders it', async () => {
    root = await repoWithUmlautChange(true);
    const scanned: string[] = [];
    const deps = realDeps(root, scanned);
    const result = await run(deps, config, { trustedRef: TRUSTED_REF, changedFiles: await changedFilesAsCi(deps) });
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(scanned).toEqual(['uber']);
    expect(result.coverage.affected.map((screen) => screen.screenId)).toEqual(['uber']);
  });

  it('is a gap, never nothing to check, in a run with a trusted ref when no screen renders it', async () => {
    root = await repoWithUmlautChange(false);
    const deps = realDeps(root, []);
    const result = await run(deps, config, { trustedRef: TRUSTED_REF, changedFiles: await changedFilesAsCi(deps) });
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.verdict).toBe('not_covered');
    expect(result.coverage.unresolvedFiles).toEqual([UMLAUT]);
  });
});

describe('a changed path that still looks quoted', () => {
  it('is an unresolved gap, never a file outside the UI globs', async () => {
    const quoted = '"src/pages/\\303\\234ber.tsx"';
    const fs = makeFakeDeps({ files: { 'src/App.tsx': '' } }).fs;
    const coverage = await computeCoverage(fs, { ...config, uiFileGlobs: ['src/**/*.tsx'] }, [quoted]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.unresolvedFiles).toEqual([quoted]);
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0]?.state).toBe('unresolved');
    expect(coverage.gaps[0]?.reason).toMatch(/quoted/);
  });
});
