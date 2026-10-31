/**
 * What the customer sees of the debt: the pull request comment line and `usabl debt`, from one
 * fixture history.
 *
 * The fixture. Clusters had two dialogs that trap focus; main confirmed one fixed. Jobs has two
 * floored rows; row a showed and hid on one source tree, so it is intermittent. Everything was first
 * seen on 2026-09-17, 41 days before the run. The pull request fixes the last dialog.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../src/run.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';
import { runDebt } from '../../src/history/report.js';
import { serializeRecord } from '../../src/history/record.js';
import type { Deps, Draft, UsablConfig } from '../../src/contracts/index.js';
import { COMMIT_A, COMMIT_B, dialogAt, entryFor, floorOf, fullScreen, makeFakeHistory, recordOf, rowButton, scanOf } from './helpers.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const DIALOG = entryFor(dialogAt(1), 2);
const ROW_A = entryFor(rowButton('a'), 1);
const ROW_B = entryFor(rowButton('b'), 1);
const FLOOR = floorOf([DIALOG, ROW_A, ROW_B]);
const NOW = '2026-10-28T00:00:00.000Z';

function history() {
  const at = (time: string, sourceTree: string, dialog: number, a: number) =>
    recordOf(FLOOR, [fullScreen('clusters', [[DIALOG, dialog]]), fullScreen('jobs', [[ROW_A, a], [ROW_B, 1]])], {
      time, sourceTree, commit: time < '2026-10-02' ? COMMIT_A : COMMIT_B,
    });
  const records = [
    at('2026-09-17T00:00:00.000Z', 't0', 2, 1),
    at('2026-10-01T00:00:00.000Z', 't1', 1, 0),
    at('2026-10-02T00:00:00.000Z', 't1', 1, 1),
  ];
  return makeFakeHistory({
    refs: { 'origin/usabl/history': 'h1', HEAD: COMMIT_B },
    main: { [COMMIT_B]: [COMMIT_A] },
    commits: { h1: { '2026-10.jsonl': records.map((record) => `${serializeRecord(record)}\n`).join('') } },
  }).writer;
}

function depsFor(drafts: Draft[], withHistory: boolean): Deps {
  const policy = { 'usabl.config.json': '{}', '.usabl-evidence.json': JSON.stringify(FLOOR) };
  const deps = makeFakeDeps({
    files: policy, headContents: policy, now: NOW,
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scans: { clusters: scanOf('clusters', drafts) },
  });
  return withHistory ? { ...deps, history: history() } : deps;
}

describe('the pull request comment', () => {
  it('says what the change fixed, what remains, how old the oldest is, and what is intermittent', async () => {
    const comment = projectPrComment(await run(depsFor([], true), config));

    expect(comment).toContain('### Accessibility debt');
    expect(comment).toContain('This PR fixes 1 accessibility barrier. 2 remain; the oldest has been open 41 days. 1 is intermittent.');
    expect(comment).not.toContain('Automatic debt tracking is off');
  });

  it('says tracking is off and how to turn it on when there is no history', async () => {
    const comment = projectPrComment(await run(depsFor([dialogAt(1)], false), config));

    expect(comment).toContain('This PR fixes 1 accessibility barrier. 3 remain.');
    expect(comment).toContain('Automatic debt tracking is off: this run was not given a history reader');
  });
});

describe('usabl debt', () => {
  it('lists remaining debt by screen and rule with first seen, age, trend, and intermittent', async () => {
    const policy = JSON.stringify(FLOOR);
    const outcome = await runDebt(history(), async () => policy, 'HEAD', NOW);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.text.split('\n')).toEqual([
      'usabl debt: 3 accessibility barriers remain on 2 screens. The oldest has been open 41 days. 1 is intermittent. Main confirmed 1 fix, so its slot is closed.',
      '',
      '- clusters, pf-focus-into-dialog: 1 barrier, first seen 2026-09-17 (41 days ago), trend falling',
      '- jobs, button-name: 2 barriers, first seen 2026-09-17 (41 days ago), trend steady, 1 intermittent',
      '',
      'Next: fix the oldest barriers first. A fix closes its slot on its own after two scans of main no longer see it. An intermittent barrier comes and goes with the page content and is not released on its own: fix it, or check the screen against fixed data.',
    ]);
    expect(JSON.parse(outcome.json).rows).toHaveLength(2);
  });

  it('lists the floor and says how to turn tracking on when there is no history branch', async () => {
    const empty = makeFakeHistory({ refs: { HEAD: COMMIT_B }, main: { [COMMIT_B]: [] } }).writer;
    const outcome = await runDebt(empty, async () => JSON.stringify(FLOOR), 'HEAD', NOW);

    expect(outcome.text).toContain('usabl debt: 4 accessibility barriers remain on 2 screens.');
    expect(outcome.text).toContain('- jobs, button-name: 2 barriers, first seen unknown, trend no data');
    expect(outcome.text).toContain('Automatic debt tracking is off: there is no usabl/history branch');
    expect(outcome.text).toContain('run usabl install --ci and merge the usabl-history workflow');
  });

  it('refuses a floor it cannot read', async () => {
    const outcome = await runDebt(undefined, async () => '{', 'HEAD', NOW);

    expect(outcome.exitCode).toBe(4);
  });
});
