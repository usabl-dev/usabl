/**
 * What `usabl install --ci` reads from git: the default branch of origin, and whether that branch
 * already holds the same usabl.config.json (and usabl.routes.json) as the working tree. The judge
 * reads those files at the base commit of each pull request, so the report must know whether they
 * are there yet. When git cannot answer, the answer is "not shown", never "there".
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallFs } from '../../src/install/index.js';
import { gateWorkflowFor } from '../../src/install/ci.js';
import { configOnDefaultBranch, findDefaultBranch, gitRunner, NO_GIT, workflowTrigger } from '../../src/install/repo-git.js';
import { fakeGit } from './fake-git.js';

const CONFIG = '{\n  "appBaseUrl": "http://127.0.0.1:9000"\n}\n';
const ROUTES = '{\n  "routes": []\n}\n';

function fsOf(files: Record<string, string>): InstallFs {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async () => [],
    writeFile: async () => {
      throw new Error('this test writes nothing');
    },
  };
}

describe('workflowTrigger', () => {
  it('reads the event line only inside the top-level on: block', () => {
    // A run-name block scalar above on: holds text shaped like a trigger. GitHub reads it as the
    // run name. The trigger the gate runs on is the one under on:, and it names main.
    const raw = `run-name: |\n  pull_request:\n    branches: ["trunk"]\n${gateWorkflowFor('main')}`;
    expect(raw.split('\n')[10]).toBe('    branches: ["main"]');
    expect(workflowTrigger(raw, 'pull_request')).toEqual({ name: 'main', line: 11 });
  });

  it('names no branch when the event is only outside the on: block', () => {
    const below = 'name: g\non:\n  workflow_dispatch:\njobs:\n  pull_request:\n    branches: ["trunk"]\n';
    expect(workflowTrigger(below, 'pull_request')).toBeNull();
    const noOn = 'name: g\nrun-name: |\n  pull_request:\n    branches: ["trunk"]\n';
    expect(workflowTrigger(noOn, 'pull_request')).toBeNull();
    // An on: that is not at the top level is not the trigger.
    const nested = 'name: g\njobs:\n  on:\n  pull_request:\n    branches: ["trunk"]\n';
    expect(workflowTrigger(nested, 'pull_request')).toBeNull();
  });

  it('keeps reading the on: block past a blank line or a comment at the start of a line', () => {
    const raw = gateWorkflowFor('trunk').replace('on:\n', 'on:\n\n# Pull requests into trunk.\n');
    expect(workflowTrigger(raw, 'pull_request')).toEqual({ name: 'trunk', line: 10 });
  });

  it('counts a lone CR as a line break, as an editor shows it', () => {
    const raw = `# a\r# b\r# c\n${gateWorkflowFor('trunk')}`;
    expect(workflowTrigger(raw, 'pull_request')).toEqual({ name: 'trunk', line: 11 });
  });

  it('still names no branch in a file with CR LF line ends', () => {
    expect(workflowTrigger(gateWorkflowFor('trunk').replace(/\n/g, '\r\n'), 'pull_request')).toBeNull();
  });

  it('names no branch longer than 255 characters, so a printed name stays short', () => {
    expect(workflowTrigger(gateWorkflowFor('b'.repeat(255)), 'pull_request')).toEqual({ name: 'b'.repeat(255), line: 8 });
    expect(workflowTrigger(gateWorkflowFor('b'.repeat(256)), 'pull_request')).toBeNull();
    expect(workflowTrigger(gateWorkflowFor('b'.repeat(200_000)), 'pull_request')).toBeNull();
  });
});

describe('findDefaultBranch', () => {
  it('reads the branch origin names as its default', async () => {
    expect(await findDefaultBranch(fakeGit('trunk', {}))).toEqual({ kind: 'found', name: 'trunk' });
    expect(await findDefaultBranch(fakeGit('release/2.x', {}))).toEqual({ kind: 'found', name: 'release/2.x' });
  });

  it('reports not found when git cannot answer', async () => {
    expect((await findDefaultBranch(NO_GIT)).kind).toBe('unknown');
  });
});

describe('configOnDefaultBranch', () => {
  it('is true only when the default branch holds the same config bytes as the working tree', async () => {
    const fs = fsOf({ 'usabl.config.json': CONFIG });
    expect(await configOnDefaultBranch(fs, fakeGit('main', { 'usabl.config.json': CONFIG }))).toBe(true);
    expect(await configOnDefaultBranch(fs, fakeGit('main', { 'usabl.config.json': CONFIG.replace('9000', '9001') }))).toBe(false);
    expect(await configOnDefaultBranch(fs, fakeGit('main', {}))).toBe(false);
  });

  it('checks usabl.routes.json too when the working tree has one', async () => {
    const fs = fsOf({ 'usabl.config.json': CONFIG, 'usabl.routes.json': ROUTES });
    expect(await configOnDefaultBranch(fs, fakeGit('main', { 'usabl.config.json': CONFIG }))).toBe(false);
    expect(await configOnDefaultBranch(fs, fakeGit('main', { 'usabl.config.json': CONFIG, 'usabl.routes.json': ROUTES }))).toBe(true);
  });

  it('is false when the default branch cannot be found, git cannot answer, or there is no config yet', async () => {
    expect(await configOnDefaultBranch(fsOf({ 'usabl.config.json': CONFIG }), fakeGit(null, {}))).toBe(false);
    expect(await configOnDefaultBranch(fsOf({ 'usabl.config.json': CONFIG }), NO_GIT)).toBe(false);
    expect(await configOnDefaultBranch(fsOf({}), fakeGit('main', { 'usabl.config.json': CONFIG }))).toBe(false);
  });
});

describe('gitRunner on a real repository', () => {
  let work: string;

  function git(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'usabl-repo-git-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function upstreamWith(files: Record<string, string>, branch = 'main'): Promise<string> {
    const upstream = join(work, 'upstream');
    git(work, ['init', '--quiet', '-b', branch, upstream]);
    git(upstream, ['config', 'user.name', 'usabl repo git test']);
    git(upstream, ['config', 'user.email', 'repo-git@usabl.invalid']);
    for (const [path, contents] of Object.entries(files)) await writeFile(join(upstream, path), contents);
    git(upstream, ['add', '.']);
    git(upstream, ['commit', '--quiet', '-m', 'seed']);
    return upstream;
  }

  it('shows the config on the default branch of a clone', async () => {
    const upstream = await upstreamWith({ 'usabl.config.json': CONFIG });
    git(work, ['clone', '--quiet', upstream, 'app']);
    const app = join(work, 'app');

    const fs = fsOf({ 'usabl.config.json': CONFIG });
    expect(await configOnDefaultBranch(fs, gitRunner(app))).toBe(true);
    expect(await configOnDefaultBranch(fsOf({ 'usabl.config.json': `${CONFIG} ` }), gitRunner(app))).toBe(false);
  });

  it('does not show the config when the default branch lacks it', async () => {
    const upstream = await upstreamWith({ 'README.md': 'app\n' });
    git(work, ['clone', '--quiet', upstream, 'app']);

    expect(await configOnDefaultBranch(fsOf({ 'usabl.config.json': CONFIG }), gitRunner(join(work, 'app')))).toBe(false);
  });

  it('answers null outside a git repository', async () => {
    expect(await gitRunner(work).run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).toBeNull();
    expect((await findDefaultBranch(gitRunner(work))).kind).toBe('unknown');
  });
});
