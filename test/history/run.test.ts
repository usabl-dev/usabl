/**
 * The run judged against the effective floor, end to end through run() and the gate.
 *
 * Two properties. With history, a fix main confirmed closes its slot, so a new barrier there is a
 * regression. Without a usable history, every verdict is the verdict of a run that never heard of
 * history, and the Result says tracking is off and why.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../src/run.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { currentHistoryHead, verifyReceipt } from '../../src/evidence/receipt.js';
import { serializeRecord, type HistoryRecord } from '../../src/history/record.js';
import type { Deps, Draft, EvidenceFloor, HistoryReader, Result, UsablConfig } from '../../src/contracts/index.js';
import { COMMIT_A, COMMIT_B, dialogAt, entryFor, floorOf, fullScreen, makeFakeHistory, recordOf, scanOf } from './helpers.js';

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

const DIALOG = entryFor(dialogAt(1), 2);
const FLOOR = floorOf([DIALOG]);

function depsFor(opts: { floor: EvidenceFloor; drafts: Draft[]; history?: HistoryReader; changed?: string }): Deps {
  const policy = { 'usabl.config.json': '{}', '.usabl-evidence.json': JSON.stringify(opts.floor) };
  const deps = makeFakeDeps({
    files: policy,
    headContents: policy,
    changed: [{ code: 'M', path: opts.changed ?? 'fixtures/app/src/ClustersPage.tsx' }],
    now: '2026-10-28T00:00:00.000Z',
    scans: {
      clusters: scanOf('clusters', opts.drafts.filter((draft) => draft.screenId === 'clusters')),
      jobs: scanOf('jobs', []),
    },
  });
  return opts.history === undefined ? deps : { ...deps, history: opts.history };
}

function historyOf(records: HistoryRecord[], head = 'h1') {
  return makeFakeHistory({
    refs: { 'origin/usabl/history': head, HEAD: COMMIT_B },
    main: { [COMMIT_B]: [COMMIT_A] },
    commits: { [head]: { '2026-10.jsonl': records.map((record) => `${serializeRecord(record)}\n`).join('') } },
  });
}

function dialogRun(count: number, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return recordOf(FLOOR, [fullScreen('clusters', [[DIALOG, count]])], over);
}

const CONFIRMED = [dialogRun(1, { sourceTree: 'tree-a' }), dialogRun(1, { sourceTree: 'tree-b', commit: COMMIT_B })];

/** What a run without history decides: everything but the debt field and the history binding. */
function decision(result: Result) {
  return {
    verdict: result.verdict,
    exitCode: result.exitCode,
    accessibilityVerdict: result.accessibilityVerdict,
    summary: result.summary,
    findings: result.findings,
    floorHeadroom: result.floorHeadroom,
    floorUnconfirmed: result.floorUnconfirmed,
    paidDownCount: result.paidDownCount,
    receipt: result.receipt === null ? null : { ...result.receipt, historyHead: null },
  };
}

describe('a pull request judged against the effective floor', () => {
  it('is a regression when a new barrier takes the slot of a fix main confirmed', async () => {
    const drafts = [dialogAt(1), dialogAt(7)];

    const today = await run(depsFor({ floor: FLOOR, drafts }), config);
    const tracked = await run(depsFor({ floor: FLOOR, drafts, history: historyOf(CONFIRMED).writer }), config);

    expect(today.verdict).toBe('verified');
    expect(tracked.verdict).toBe('regression');
    expect(tracked.debt).toMatchObject({ tracking: 'on', floorBarriers: 2, acceptedBarriers: 1, confirmedFixed: 1 });
  });

  it('is not blocked by an intermittent barrier on its screen or any other', async () => {
    const records = [...CONFIRMED, dialogRun(2, { sourceTree: 'tree-b', commit: COMMIT_B })];
    const history = historyOf(records).writer;

    const same = await run(depsFor({ floor: FLOOR, drafts: [dialogAt(1), dialogAt(2)], history }), config);
    const other = await run(depsFor({ floor: FLOOR, drafts: [], history, changed: 'fixtures/app/src/JobsPage.tsx' }), config);

    expect(same.verdict).toBe('verified');
    expect(other.verdict).toBe('verified');
    expect(same.debt).toMatchObject({ intermittent: 2, acceptedBarriers: 2 });
  });

  it('binds the history head into the receipt, so a moved history needs a full run', async () => {
    const store = historyOf(CONFIRMED);
    const deps = depsFor({ floor: FLOOR, drafts: [dialogAt(1)], history: store.writer });

    const result = await run(deps, config);

    expect(result.receipt?.schemaVersion).toBe(2);
    expect(result.receipt?.historyHead).toBe('h1');
    expect((await verifyReceipt(deps, config, result.receipt!, 'tree-0000')).valid).toBe(true);
    store.refs['origin/usabl/history'] = 'h2';
    store.commits['h2'] = store.commits['h1']!;
    expect(await currentHistoryHead(deps)).toBe('h2');
    expect(await verifyReceipt(deps, config, result.receipt!, 'tree-0000')).toEqual({ valid: false, failedFields: ['historyHead'] });
  });
});

describe('without a usable history', () => {
  const scenarios: Array<[string, Draft[]]> = [
    ['verified with carried debt', [dialogAt(1)]],
    ['the headroom case', [dialogAt(1), dialogAt(7)]],
    ['a regression', [dialogAt(1), dialogAt(4), dialogAt(7)]],
    ['a fix', []],
  ];
  const histories: Array<[string, () => HistoryReader | undefined, string]> = [
    ['no reader', () => undefined, 'no-reader'],
    ['no history branch', () => makeFakeHistory({ refs: { HEAD: COMMIT_B }, main: { [COMMIT_B]: [] } }).writer, 'no-history'],
    ['an unreadable history', () => makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1', HEAD: COMMIT_B }, main: { [COMMIT_B]: [] },
      commits: { h1: { '2026-10.jsonl': `${serializeRecord(CONFIRMED[0]!)}\nnot json\n` } },
    }).writer, 'unreadable'],
  ];

  for (const [scenario, drafts] of scenarios) {
    for (const [name, reader, cause] of histories) {
      it(`gives today's verdict for ${scenario} with ${name}, and says tracking is off`, async () => {
        const today = await run(depsFor({ floor: FLOOR, drafts }), config);
        const history = reader();
        const result = await run(depsFor({ floor: FLOOR, drafts, ...(history === undefined ? {} : { history }) }), config);

        expect(decision(result)).toEqual(decision(today));
        expect(result.debt).toMatchObject({ tracking: 'off', off: { cause }, acceptedBarriers: 2, confirmedFixed: 0 });
      });
    }
  }

  it("gives today's verdict for a floor from before row keys, and says why", async () => {
    const v2 = floorOf([DIALOG], 2);
    const drafts = [dialogAt(1), dialogAt(7)];
    const records = CONFIRMED.map((record) => ({ ...record, floorHash: recordOf(v2, []).floorHash }));

    const today = await run(depsFor({ floor: v2, drafts }), config);
    const result = await run(depsFor({ floor: v2, drafts, history: historyOf(records).writer }), config);

    expect(decision(result)).toEqual(decision(today));
    expect(result.debt?.off?.cause).toBe('old-floor');
  });

  it('gives the same verdict for the same tree, floor, history, and date', async () => {
    const drafts = [dialogAt(1), dialogAt(7)];
    const first = await run(depsFor({ floor: FLOOR, drafts, history: historyOf(CONFIRMED).writer }), config);
    const second = await run(depsFor({ floor: FLOOR, drafts, history: historyOf(CONFIRMED).writer }), config);

    expect(second).toEqual(first);
  });
});
