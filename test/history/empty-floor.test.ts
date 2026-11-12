/**
 * A repository with no evidence floor file is judged against an empty floor. The run path and
 * `usabl debt` each built that empty floor on their own, at different versions. An empty floor
 * holds nothing, so its version cannot raise a gap or hide a barrier, and these tests pin that:
 * a missing floor file reads exactly as an empty floor file at version 2 or version 3.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../src/run.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runDebt } from '../../src/history/report.js';
import { serializeRecord } from '../../src/history/record.js';
import type { Deps, Draft, HistoryReader, Result, UsablConfig } from '../../src/contracts/index.js';
import { COMMIT_A, COMMIT_B, dialogAt, entryFor, floorOf, fullScreen, makeFakeHistory, recordOf, rowButton, scanOf } from './helpers.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [
    { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] },
    { id: 'jobs', url: 'http://127.0.0.1:5173/jobs', files: ['fixtures/app/src/JobsPage.tsx'] },
  ],
  guardedPaths: ['usabl.config.json'],
};
const NOW = '2026-10-28T00:00:00.000Z';

// Each way a repository can say "no accepted debt": no file at all, or an empty file at either
// version the engine has used for one.
const FLOOR_FILES: Record<string, string | null> = {
  missing: null,
  'version 2': JSON.stringify({ version: 2, entries: [] }),
  'version 3': JSON.stringify({ version: 3, entries: [] }),
};

// A history written against a different floor. An empty floor has no entry to track in it.
function history(): HistoryReader {
  const dialog = entryFor(dialogAt(1), 1);
  const record = recordOf(floorOf([dialog]), [fullScreen('clusters', [[dialog, 1]])]);
  return makeFakeHistory({
    refs: { 'origin/usabl/history': 'h1', HEAD: COMMIT_B },
    main: { [COMMIT_B]: [COMMIT_A] },
    commits: { h1: { '2026-10.jsonl': `${serializeRecord(record)}\n` } },
  }).writer;
}

function depsFor(floorFile: string | null, drafts: Draft[], withHistory: boolean): Deps {
  const policy: Record<string, string> = { 'usabl.config.json': '{}' };
  if (floorFile !== null) policy['.usabl-evidence.json'] = floorFile;
  const deps = makeFakeDeps({
    files: policy,
    headContents: policy,
    now: NOW,
    changed: [
      { code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' },
      { code: 'M', path: 'fixtures/app/src/JobsPage.tsx' },
    ],
    scans: {
      clusters: scanOf('clusters', drafts.filter((draft) => draft.screenId === 'clusters')),
      jobs: scanOf('jobs', drafts.filter((draft) => draft.screenId === 'jobs')),
    },
  });
  return withHistory ? { ...deps, history: history() } : deps;
}

function outcome(result: Result) {
  return {
    verdict: result.verdict,
    exitCode: result.exitCode,
    accessibilityVerdict: result.accessibilityVerdict,
    accessibilityExitCode: result.accessibilityExitCode,
    summary: result.summary,
    gaps: result.coverage.gaps,
    findings: result.findings,
    floorHeadroom: result.floorHeadroom,
    floorUnconfirmed: result.floorUnconfirmed,
    paidDownCount: result.paidDownCount,
    debt: result.debt,
  };
}

describe('a missing floor file on the run path', () => {
  // A dialog and a button in a keyed table row. The row draft is the one an old floor version
  // would raise a row key gap for, so it shows the empty floor raises none at any version.
  const cases: Array<[string, Draft[], Result['verdict']]> = [
    ['no barrier', [], 'verified'],
    ['new barriers', [dialogAt(1), rowButton('a')], 'regression'],
  ];

  for (const [label, drafts, verdict] of cases) {
    for (const withHistory of [false, true]) {
      it(`reads as an empty floor at every version: ${label}, ${withHistory ? 'with' : 'without'} history`, async () => {
        const results = await Promise.all(
          Object.values(FLOOR_FILES).map((file) => run(depsFor(file, drafts, withHistory), config)),
        );
        const [missing, ...explicit] = results.map(outcome);

        expect(missing!.verdict).toBe(verdict);
        expect(missing!.gaps).toEqual([]);
        for (const other of explicit) expect(other).toEqual(missing);
      });
    }
  }
});

describe('a missing floor file on usabl debt', () => {
  for (const withHistory of [false, true]) {
    it(`reports as an empty floor at every version, ${withHistory ? 'with' : 'without'} history`, async () => {
      const outcomes = await Promise.all(
        Object.values(FLOOR_FILES).map((file) =>
          runDebt(withHistory ? history() : undefined, async () => file, 'HEAD', NOW),
        ),
      );
      const [missing, ...explicit] = outcomes;

      expect(missing!.exitCode).toBe(0);
      for (const other of explicit) expect(other).toEqual(missing);
    });
  }
});
