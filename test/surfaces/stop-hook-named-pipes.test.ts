/**
 * A named pipe at any path the Stop hook reads from the working tree must not hold the stop. A
 * plain read of a pipe waits until something writes to it. The read holds a thread of Node's
 * shared pool, and a process with such a read pending cannot exit, so the hook outlived the host's
 * limit even after its deadline answered, and the host may then drop the answer. One `mkfifo` in
 * the working tree was enough, and `.usabl/` is ignored by git, so `git status` does not show it.
 *
 * Each case runs the real stop-hook command in a child process on a real git repository, with a
 * pipe at one kind of path. The stop must end well before the host's limit, and its answer must
 * block on the path it did not read, or, for the session pins, which live outside the working
 * tree, state that the pin file was refused.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionPinFileName } from '../../src/surfaces/stop-hook-runner.js';
import {
  answerOf,
  BASE_CONFIG,
  bundle,
  DEADLINE_MS,
  GIVE_UP_MS,
  makeWork,
  removeWork,
  repository,
  stop,
  type StopRun,
} from '../support/real-stop-hook.js';

const CAN_MAKE_PIPES = process.platform !== 'win32';

let work = '';
let dist = '';

beforeAll(async () => {
  work = await makeWork('usabl-named-pipes-');
  dist = await bundle(work, 'real');
}, 120_000);

afterAll(async () => {
  await removeWork(work);
});

function pipe(repo: string, path: string): void {
  execFileSync('mkfifo', [join(repo, path)]);
}

// A change to a file that is not a UI file, so a stop with no pipe is idle and allows.
const IDLE = { base: { 'README.md': 'one\n' }, change: { 'README.md': 'two\n' } };

// The stop ends on its own, long before usabl's deadline would answer for it, and never says
// VERIFIED or saves a receipt.
function expectEndedInTime(run: StopRun, repo: string): void {
  expect(run.exitMs, `the stop did not end before ${GIVE_UP_MS} ms; stderr: ${run.stderr.slice(0, 400)}`).not.toBeNull();
  expect(run.exitMs!).toBeLessThan(DEADLINE_MS);
  expect(run.stdout + run.stderr).not.toContain('VERIFIED');
  const receipt = join(repo, '.usabl', 'receipt.json');
  expect(existsSync(receipt) && statSync(receipt).isFile()).toBe(false);
}

function expectBlockNaming(run: StopRun, path: string): void {
  const answer = answerOf(run);
  expect(answer?.['decision'], `stdout: ${run.stdout.slice(0, 400)}`).toBe('block');
  const reason = String(answer?.['reason']);
  expect(reason).toMatch(/^NOT verified - usabl did not read 1 path\(s\) in this repository/u);
  expect(reason).toContain(`not regular files: ${path}`);
}

const ROUTER =
  "import { Route, Routes } from 'react-router-dom';\nimport { ClustersPage } from './ClustersPage';\n" +
  'export function App() { return (<Routes><Route path="/clusters" element={<ClustersPage />} /></Routes>); }\n';

describe.skipIf(!CAN_MAKE_PIPES)('a named pipe at a path the Stop hook reads', () => {
  for (const path of ['.usabl/bypass-once', '.usabl/receipt.json', 'usabl.routes.json', 'usabl.docs.json']) {
    it(`blocks on ${path} and ends in time`, async () => {
      const repo = await repository(work, path.replace(/[^a-z]/gu, '-'), IDLE.base, IDLE.change);
      await mkdir(join(repo, '.usabl'), { recursive: true });
      pipe(repo, path);

      const run = await stop(dist, repo);

      expectEndedInTime(run, repo);
      expectBlockNaming(run, path);
    }, 60_000);
  }

  it('blocks on the config file and ends in time', async () => {
    const repo = await repository(work, 'config', IDLE.base, IDLE.change);
    await rm(join(repo, 'usabl.config.json'));
    pipe(repo, 'usabl.config.json');

    const run = await stop(dist, repo);

    expectEndedInTime(run, repo);
    expectBlockNaming(run, 'usabl.config.json');
  }, 60_000);

  it('blocks on a requirements file and ends in time', async () => {
    const config = { ...BASE_CONFIG, requirements: 'requirements' };
    const repo = await repository(work, 'requirements', { ...IDLE.base, 'requirements/README.md': 'rules\n' }, IDLE.change, config);
    pipe(repo, 'requirements/a.yaml');

    const run = await stop(dist, repo);

    expectEndedInTime(run, repo);
    expectBlockNaming(run, 'requirements/a.yaml');
  }, 60_000);

  it('blocks on a source file the import graph reads and ends in time', async () => {
    const config = { ...BASE_CONFIG, discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] }, surfaces: [] };
    const repo = await repository(
      work,
      'source',
      { 'src/App.tsx': ROUTER, 'src/ClustersPage.tsx': 'export const ClustersPage = () => null;\n' },
      { 'src/ClustersPage.tsx': "import { P } from './Pipe';\nexport const ClustersPage = () => P;\n" },
      config,
    );
    pipe(repo, 'src/Pipe.tsx');

    const run = await stop(dist, repo);

    expectEndedInTime(run, repo);
    expectBlockNaming(run, 'src/Pipe.tsx');
  }, 60_000);

  it('blocks on the saved session file and ends in time', async () => {
    const repo = await repository(work, 'session', IDLE.base, IDLE.change);
    await mkdir(join(repo, '.usabl/session'), { recursive: true });
    pipe(repo, '.usabl/session/storage-state.json');

    // Outside CI, and with no session named, the stop reads the session usabl session saved.
    const run = await stop(dist, repo, { env: { CI: undefined, USABL_STORAGE_STATE: undefined } });

    expectEndedInTime(run, repo);
    expectBlockNaming(run, '.usabl/session/storage-state.json');
  }, 60_000);

  it.skipIf(typeof process.getuid !== 'function')('states that a pin file is refused and ends in time', async () => {
    const repo = await repository(work, 'pins', IDLE.base, IDLE.change);
    const runtime = await mkdtemp(join(work, 'runtime-'));
    await mkdir(join(runtime, 'usabl-pins'), { mode: 0o700 });
    execFileSync('mkfifo', [join(runtime, 'usabl-pins', sessionPinFileName('pipe-pins', repo))]);

    const run = await stop(dist, repo, { env: { XDG_RUNTIME_DIR: runtime }, sessionId: 'pipe-pins' });

    expectEndedInTime(run, repo);
    expect(run.stdout + run.stderr).toContain('the session pin file is not a regular file');
  }, 60_000);
});
