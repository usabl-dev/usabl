/**
 * The docs gate runs on pull requests into the default branch, taken the same way as the app gate
 * and the history workflow. Its judge reads usabl.config.json and usabl.docs.json at the base
 * commit of each pull request, so `usabl install --docs-ci` says to merge them to the default branch
 * first, unless git shows they are already there with the same bytes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import type { EnginePin } from '../../src/install/build-info.js';
import {
  classifyDocsGateWorkflow,
  docsGateWorkflowFor,
  pinEngineRef,
  USABL_DOCS_GATE_WORKFLOW,
  USABL_DOCS_GATE_WORKFLOW_PATH,
} from '../../src/install/ci.js';
import { installDocsCi } from '../../src/install/docs-ci.js';
import { gitRunner, NO_GIT } from '../../src/install/repo-git.js';
import { fakeGit } from './fake-git.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const FILLED: EnginePin = { kind: 'filled', sha: SHA, version: '0.3.0' };
const CONFIG = JSON.stringify({ appBaseUrl: 'http://127.0.0.1:9000' });
const DOCS = JSON.stringify({ docsBaseUrl: 'http://127.0.0.1:8100' });
const ROUTES = JSON.stringify({ routes: [] });
const REPO = { 'usabl.config.json': CONFIG, 'usabl.docs.json': DOCS };

function memoryFs(files: Record<string, string>): InstallFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

const parse = (text: string): { on: { pull_request: { branches: string[] } } } => load(text) as { on: { pull_request: { branches: string[] } } };
const triggerLine = (text: string): number => text.split('\n').findIndex((line) => /^ {4}branches:/.test(line)) + 1;
const mergeFirst = (target: string): string =>
  `Merge usabl.config.json and usabl.docs.json to ${target} first, in their own pull request. The judge reads them at the base commit of each pull request, so a pull request that adds them together with the workflow cannot pass.`;

describe('docsGateWorkflowFor', () => {
  it('names the branch in the pull request trigger only', () => {
    const trunk = docsGateWorkflowFor('trunk');
    expect(parse(trunk).on.pull_request.branches).toEqual(['trunk']);
    const main = USABL_DOCS_GATE_WORKFLOW.split('\n');
    expect(trunk.split('\n').flatMap((line, index) => (line === main[index] ? [] : [index + 1]))).toEqual([triggerLine(trunk)]);
    expect(() => docsGateWorkflowFor('a b')).toThrow();
  });

  it('is recognised for any plain branch, and every near miss of the trigger is drifted', () => {
    const pinned = pinEngineRef(docsGateWorkflowFor('trunk'), SHA);
    expect(classifyDocsGateWorkflow(docsGateWorkflowFor('trunk'))).toBe('unpinned');
    expect(classifyDocsGateWorkflow(pinned)).toBe('wired');
    for (const line of ['    branches: [trunk]', '    branches: ["trunk", "main"]', '    branches: ["a b"]']) {
      expect(classifyDocsGateWorkflow(pinned.replace('    branches: ["trunk"]', line)), line).toBe('drifted');
    }
  });
});

describe('installDocsCi', () => {
  it('writes the default branch git names, and prints no merge step when the files are there', async () => {
    const fs = memoryFs(REPO);
    const result = await installDocsCi(fs, FILLED, fakeGit('trunk', REPO));

    expect(result.exitCode).toBe(0);
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(docsGateWorkflowFor('trunk'), SHA));
    expect(result.message).toContain(`${USABL_DOCS_GATE_WORKFLOW_PATH} runs on pull requests into trunk, the default branch git records for origin.`);
    expect(result.message).not.toContain('first, in their own pull request');
    expect(result.message).not.toContain('Check the branch name');
  });

  it('says to merge the files the judge reads at the base commit when git does not show them there', async () => {
    for (const onBranch of [{}, { 'usabl.config.json': CONFIG }, { ...REPO, 'usabl.docs.json': `${DOCS} ` }]) {
      const result = await installDocsCi(memoryFs(REPO), FILLED, fakeGit('trunk', onBranch));
      expect(result.message, JSON.stringify(onBranch)).toContain(mergeFirst('trunk'));
    }
  });

  it('names usabl.docs.json in the merge step even before the repository has one', async () => {
    const result = await installDocsCi(memoryFs({ 'usabl.config.json': CONFIG }), FILLED, fakeGit('trunk', { 'usabl.config.json': CONFIG }));
    expect(result.message).toContain(mergeFirst('trunk'));
  });

  it('adds usabl.routes.json to the merge step when the repository has one', async () => {
    const result = await installDocsCi(memoryFs({ ...REPO, 'usabl.routes.json': ROUTES }), FILLED, fakeGit('trunk', REPO));
    expect(result.message).toContain(
      'Merge usabl.config.json, usabl.docs.json, and usabl.routes.json to trunk first, in their own pull request.',
    );
  });

  it('writes main and prints the branch step when git names no branch', async () => {
    const fs = memoryFs(REPO);
    const result = await installDocsCi(fs, FILLED, NO_GIT);

    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(USABL_DOCS_GATE_WORKFLOW, SHA));
    expect(result.message).toContain(
      `So ${USABL_DOCS_GATE_WORKFLOW_PATH} runs on pull requests into main. If your default branch has another name, put it in place of main on line ${triggerLine(USABL_DOCS_GATE_WORKFLOW)} of ${USABL_DOCS_GATE_WORKFLOW_PATH}.`,
    );
    expect(result.message).toContain(mergeFirst('your default branch'));
  });

  it('keeps the branch its own file names on a re-run, and says when it is not the default branch', async () => {
    const fs = memoryFs({ ...REPO, [USABL_DOCS_GATE_WORKFLOW_PATH]: pinEngineRef(docsGateWorkflowFor('develop'), SHA) });
    const result = await installDocsCi(fs, FILLED, fakeGit('trunk', REPO));

    expect(result.exitCode).toBe(0);
    expect(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH]).toBe(pinEngineRef(docsGateWorkflowFor('develop'), SHA));
    expect(result.message).toContain(
      `${USABL_DOCS_GATE_WORKFLOW_PATH} runs on pull requests into develop, but the default branch git records for origin is trunk. Put trunk in place of develop on line ${triggerLine(USABL_DOCS_GATE_WORKFLOW)}, or the docs gate never runs and "usabl-required" never reports.`,
    );
  });

  it('keeps the repository variable steps and the facts the docs gate report states', async () => {
    const result = await installDocsCi(memoryFs(REPO), FILLED, fakeGit('trunk', REPO));
    for (const text of ['USABL_DOCS_BUILD_COMMAND', 'USABL_DOCS_BUILT_ROOT', 'USABL_DOCS_SERVE_PORT', 'docsBaseUrl', 'not evidence', 'review from code owners']) {
      expect(result.message).toContain(text);
    }
  });
});

describe('installDocsCi on a real clone whose default branch is trunk', () => {
  let work: string;

  function git(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'usabl-docs-gate-branch-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('writes trunk and leaves out the merge step when trunk holds both files', async () => {
    const upstream = join(work, 'upstream');
    git(work, ['init', '--quiet', '-b', 'trunk', upstream]);
    git(upstream, ['config', 'user.name', 'usabl docs gate branch test']);
    git(upstream, ['config', 'user.email', 'docs-gate-branch@usabl.invalid']);
    await writeFile(join(upstream, 'usabl.config.json'), CONFIG);
    await writeFile(join(upstream, 'usabl.docs.json'), DOCS);
    git(upstream, ['add', '.']);
    git(upstream, ['commit', '--quiet', '-m', 'seed']);
    git(work, ['clone', '--quiet', upstream, 'docs']);

    const fs = memoryFs(REPO);
    const result = await installDocsCi(fs, FILLED, gitRunner(join(work, 'docs')));

    expect(parse(fs.store[USABL_DOCS_GATE_WORKFLOW_PATH] ?? '').on.pull_request.branches).toEqual(['trunk']);
    expect(result.message).not.toContain('first, in their own pull request');
  });
});
