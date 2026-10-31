/**
 * Debt tracking through a real git remote: two scans of main confirm a fix, each recorded and
 * pushed to the history branch the way the default-branch job does it, and then a pull request
 * clone, reading the branch it fetched, is judged against the effective floor.
 *
 * The browser and the check runner are scripted. Git is real: the history is written with the real
 * port, pushed to a bare remote, fetched by a second clone, and read back as objects.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/run.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { appendRecord } from '../../src/history/append.js';
import { makeHistoryGit } from '../../src/history/git.js';
import { recordMainScan } from '../../src/history/record-run.js';
import { serializeRecord } from '../../src/history/record.js';
import type { Deps, Draft, UsablConfig } from '../../src/contracts/index.js';
import { dialogAt, entryFor, floorOf, scanOf } from './helpers.js';

const execFileAsync = promisify(execFile);
const MARKER = 'zz-marker-zz';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

// A floor of two at one collapsed identity, plus a named barrier whose name carries the marker.
const NAMED = dialogAt(1, {
  rule: 'pf-dialog-label', elementPath: `#${MARKER} > section`, elementName: `Close ${MARKER}`,
  evidence: { name: { value: `Close ${MARKER}`, source: 'attribute', fromTree: true } },
});
const FLOOR = floorOf([entryFor(dialogAt(1), 2), entryFor(NAMED, 1)]);
const POLICY = { 'usabl.config.json': '{}', '.usabl-evidence.json': JSON.stringify(FLOOR), 'src/ClustersPage.tsx': 'page\n' };

function depsAt(cwd: string, drafts: Draft[], over: { headRef: string; writeTree: string }): Deps {
  const deps = makeFakeDeps({
    files: POLICY,
    headContents: POLICY,
    refContents: { 'origin/main': POLICY },
    changed: [{ code: 'M', path: 'src/ClustersPage.tsx' }],
    diffNames: ['src/ClustersPage.tsx'],
    now: '2026-10-28T00:00:00.000Z',
    writeTree: over.writeTree,
    headRef: over.headRef,
    scans: { clusters: scanOf('clusters', drafts) },
  });
  return { ...deps, history: makeHistoryGit({ cwd }) };
}

describe('debt tracking through a real history branch', () => {
  let root = '';
  let origin = '';
  let main = '';
  let pr = '';

  async function scanMainAndPush(drafts: Draft[], tree: string): Promise<void> {
    await git(main, ['fetch', '--quiet', 'origin']);
    const head = await git(main, ['rev-parse', 'HEAD']);
    const outcome = await recordMainScan(depsAt(main, drafts, { headRef: head, writeTree: tree }), config);
    expect(outcome.exitCode).toBe(0);
    const appended = await appendRecord(makeHistoryGit({ cwd: main }), serializeRecord(outcome.record!));
    expect(appended.exitCode).toBe(0);
    await git(main, ['push', '--quiet', 'origin', 'usabl/history']);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-history-real-'));
    origin = join(root, 'origin.git');
    main = join(root, 'main');
    pr = join(root, 'pr');
    await git(root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    await git(root, ['clone', '--quiet', origin, main]);
    await git(main, ['config', 'user.name', 'Test User']);
    await git(main, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(main, 'app.tsx'), 'one\n', 'utf8');
    await git(main, ['add', 'app.tsx']);
    await git(main, ['commit', '--quiet', '-m', 'one']);
    await git(main, ['push', '--quiet', 'origin', 'main']);

    // First scan of main: one of the two floored dialogs is gone, the named one is still there.
    await scanMainAndPush([dialogAt(1), NAMED], 'tree-one');

    await writeFile(join(main, 'app.tsx'), 'two\n', 'utf8');
    await git(main, ['commit', '--quiet', '-am', 'two']);
    await git(main, ['push', '--quiet', 'origin', 'main']);
    // Second scan of main, on the next commit: still one dialog. The fix is now confirmed.
    await scanMainAndPush([dialogAt(1), NAMED], 'tree-two');

    await git(root, ['clone', '--quiet', origin, pr]);
    await git(pr, ['checkout', '--quiet', '-b', 'feature']);
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('judges the pull request against the floor lowered by the confirmed fix', async () => {
    const head = await git(pr, ['rev-parse', 'HEAD']);
    const drafts = [dialogAt(1), dialogAt(7), NAMED];

    const tracked = await run(depsAt(pr, drafts, { headRef: head, writeTree: 'tree-pr' }), config, { trustedRef: 'origin/main' });
    const untracked = await run(
      { ...depsAt(pr, drafts, { headRef: head, writeTree: 'tree-pr' }), history: makeHistoryGit({ cwd: pr, ref: 'origin/no-such-branch' }) },
      config,
      { trustedRef: 'origin/main' },
    );

    expect(untracked.verdict).toBe('verified');
    expect(untracked.debt?.off?.cause).toBe('no-history');
    expect(tracked.verdict).toBe('regression');
    expect(tracked.debt).toMatchObject({ tracking: 'on', floorBarriers: 3, acceptedBarriers: 2, confirmedFixed: 1 });
    expect(tracked.debt?.historyHead).toBe(await git(pr, ['rev-parse', 'origin/usabl/history']));
  });

  it('never puts the marker from page names into the history branch', async () => {
    const blobs = (await git(origin, ['rev-list', '--objects', 'usabl/history']))
      .split('\n')
      .map((line) => line.split(' ')[0]!)
      .filter((sha) => sha.length > 0);
    const contents: string[] = [];
    for (const sha of blobs) contents.push(await git(origin, ['cat-file', '-p', sha]));
    const log = await git(origin, ['log', '--format=%B', 'usabl/history']);

    expect(contents.join('\n')).toContain('usabl.history.v1');
    expect(contents.join('\n')).not.toContain(MARKER);
    expect(log).not.toContain(MARKER);
    expect(JSON.stringify(FLOOR)).toContain(MARKER);
  });
});
