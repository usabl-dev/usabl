/**
 * The ledger's two sources read from a real git repository: the floor file's history on the
 * trusted branch and the debt history branch. The repository is scripted in a temp folder with
 * fixed committer dates, so the expected days can be counted by hand.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceFloor, FloorEntry } from '../../src/contracts/index.js';
import { appendRecord } from '../../src/history/append.js';
import { makeHistoryGit } from '../../src/history/git.js';
import { buildLedger } from '../../src/history/ledger.js';
import { makeLedgerGit, readLedgerSources } from '../../src/history/ledger-git.js';
import { serializeRecord } from '../../src/history/record.js';
import { dialogAt, entryFor, floorOf, fullScreen, recordOf, rowButton } from './helpers.js';

const execFileAsync = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-01-01T00:00:00.000Z');

function dayAt(day: number): string {
  return new Date(START + day * DAY).toISOString();
}

async function git(cwd: string, args: string[], day?: number): Promise<string> {
  const env = day === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: dayAt(day), GIT_COMMITTER_DATE: dayAt(day) };
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', env });
  return stdout.trim();
}

const A = entryFor(dialogAt(1, { evidence: { name: { value: 'Close', source: 'attribute', fromTree: true } } }), 1);
const B = entryFor(dialogAt(1, { rule: 'pf-dialog-label' }), 1);
const N = entryFor(dialogAt(1, { rule: 'aria-required-attr' }), 1);
// The same table control, collapsed across rows in a version 2 floor and keyed per row in version 3.
const R_OLD: FloorEntry = { ...entryFor(rowButton('one'), 2), elementKey: null, identityBasis: 'count' };
const R_NEW = entryFor(rowButton('one'), 1);

const BASELINE = floorOf([A, B, R_OLD], 2);
const WITH_N = floorOf([A, B, R_OLD, N], 2);
const MIGRATED = floorOf([A, B, N, R_NEW], 3);
const PRUNED = floorOf([B, N, R_NEW], 3);

// The scripted history of main, by day from 2026-01-01:
//
//   day  0  c0  baseline floor (version 2): A, B, R_OLD
//   day  6  c1  a later baseline floors N
//   day  8  c2  app change; a scan of main sees B absent
//   day 10  c3  app change; a second scan sees B absent, so the fix is confirmed here
//   day 15  c4  app change; a scan sees B again on a new source tree
//   day 19      on a side branch, the floor is migrated to version 3: R_OLD becomes R_NEW
//   day 20  c5  that branch is merged into main
//   day 27  c6  floor prune removes A
//   day 30      the run's clock
//
// The hand count the ledger must match:
//
//   identity  first seen           what happened                         state     days open
//   A         day 0, first floor   left the floor on day 27              fixed     27
//   B         day 0, first floor   fixed day 10, seen again day 15       reopened  10 + 15 = 25
//   N         day 6                still in the floor                    open      24
//   R_OLD     day 0, first floor   left at the day 20 migration (a gap)  open      20, a lower bound
//   R_NEW     day 20               entered at the migration              open      10, a lower bound
const NOW = dayAt(30);

describe('the ledger sources in a real repository', () => {
  let root = '';
  let repo = '';

  async function commitFloor(floor: EvidenceFloor, day: number, message: string): Promise<void> {
    await writeFile(join(repo, '.usabl-evidence.json'), `${JSON.stringify(floor, null, 2)}\n`, 'utf8');
    await git(repo, ['add', '.usabl-evidence.json']);
    await git(repo, ['commit', '--quiet', '-m', message], day);
  }

  async function commitApp(text: string, day: number): Promise<string> {
    await writeFile(join(repo, 'app.tsx'), `${text}\n`, 'utf8');
    await git(repo, ['add', 'app.tsx']);
    await git(repo, ['commit', '--quiet', '-m', text], day);
    return git(repo, ['rev-parse', 'HEAD']);
  }

  async function scan(commit: string, day: number, floor: EvidenceFloor, bCount: number, tree: string): Promise<void> {
    const record = recordOf(floor, [fullScreen('clusters', [[A, 1], [B, bCount], [N, 1]])], {
      commit,
      time: dayAt(day),
      sourceTree: tree,
    });
    const appended = await appendRecord(makeHistoryGit({ cwd: repo, ref: 'usabl/history' }), serializeRecord(record));
    expect(appended.exitCode).toBe(0);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-ledger-git-'));
    repo = join(root, 'repo');
    await git(root, ['init', '--quiet', '--initial-branch=main', repo]);
    await git(repo, ['config', 'user.name', 'Test User']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(repo, 'app.tsx'), 'zero\n', 'utf8');
    await git(repo, ['add', 'app.tsx']);
    await commitFloor(BASELINE, 0, 'baseline');
    await commitFloor(WITH_N, 6, 'floor N');
    await scan(await commitApp('two', 8), 8, WITH_N, 0, 'tree-two');
    await scan(await commitApp('three', 10), 10, WITH_N, 0, 'tree-three');
    await scan(await commitApp('four', 15), 15, WITH_N, 1, 'tree-four');
    await git(repo, ['switch', '--quiet', '-c', 'migrate']);
    await commitFloor(MIGRATED, 19, 'migrate the floor');
    await git(repo, ['switch', '--quiet', 'main']);
    await git(repo, ['merge', '--quiet', '--no-ff', 'migrate', '-m', 'merge the migration'], 20);
    await commitFloor(PRUNED, 27, 'prune A');
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('matches the hand count', async () => {
    const read = await readLedgerSources(makeLedgerGit({ cwd: repo }), makeHistoryGit({ cwd: repo, ref: 'usabl/history' }), 'main');
    if (read.kind !== 'read') throw new Error(read.message);
    expect(read.input.shallow).toBe(false);
    expect(read.input.snapshots.map((snapshot) => snapshot.date)).toEqual([dayAt(0), dayAt(6), dayAt(20), dayAt(27)]);
    const ledger = buildLedger({ ...read.input, now: NOW });

    expect(ledger.rows.map((row) => [row.rule, row.elementKey, row.state, row.daysOpen, row.mayBeMore, row.mayBeLess])).toEqual([
      [A.rule, A.elementKey, 'left-the-floor', 27, true, true],
      [B.rule, B.elementKey, 'reopened', 25, true, true],
      [N.rule, N.elementKey, 'open', 24, false, false],
      [R_OLD.rule, R_OLD.elementKey, 'open', 20, true, true],
      [R_NEW.rule, R_NEW.elementKey, 'open', 10, true, true],
    ]);
    const b = ledger.rows[1];
    expect(b?.spans.map((span) => [span.start.date, span.end?.date ?? null, span.end?.by ?? null])).toEqual([
      [dayAt(0), dayAt(10), 'history'],
      [dayAt(15), null, null],
    ]);
    expect(ledger.rows.filter((row) => row.firstSeenAtFirstBaseline).map((row) => row.rule)).toEqual([A.rule, B.rule, R_OLD.rule]);
    expect(ledger.rows[3]?.incomplete.map((gap) => gap.cause)).toEqual(['floor-rewritten', 'not-seen']);
    expect(ledger.rows[4]?.incomplete.map((gap) => gap.cause)).toEqual(['floor-rewritten', 'not-seen']);
    expect(ledger.history).toMatchObject({ kind: 'on', records: 3, skipped: 0 });
    // Only N is exact, so it is the only number in a median.
    expect(ledger.totals).toEqual({
      open: { rows: 3, exactRows: 1, medianDays: 24, longestDays: 24 },
      fixed: { rows: 0, exactRows: 0, medianDays: null, longestDays: null },
      'left-the-floor': { rows: 1, exactRows: 0, medianDays: null, longestDays: null },
      reopened: { rows: 1, exactRows: 0, medianDays: null, longestDays: null },
    });
  });

  it('reads the committed floor, never the working tree', async () => {
    await writeFile(join(repo, '.usabl-evidence.json'), '{"version": 3, "entries": []}\n', 'utf8');
    const read = await readLedgerSources(makeLedgerGit({ cwd: repo }), makeHistoryGit({ cwd: repo, ref: 'usabl/history' }), 'main');
    await writeFile(join(repo, '.usabl-evidence.json'), `${JSON.stringify(PRUNED, null, 2)}\n`, 'utf8');
    if (read.kind !== 'read') throw new Error(read.message);
    expect(buildLedger({ ...read.input, now: NOW }).rows).toHaveLength(5);
  });

  it('says when the history branch is missing', async () => {
    const read = await readLedgerSources(makeLedgerGit({ cwd: repo }), makeHistoryGit({ cwd: repo, ref: 'origin/usabl/history' }), 'main');
    if (read.kind !== 'read') throw new Error(read.message);
    expect(read.input.history).toEqual({ kind: 'off', ref: 'origin/usabl/history', cause: 'no-history', detail: null });
  });

  it('says a shallow clone may hide older evidence, and which records it could not place', async () => {
    const shallow = join(root, 'shallow');
    await git(root, ['clone', '--quiet', '--depth', '2', '--no-single-branch', `file://${repo}`, shallow]);
    const read = await readLedgerSources(makeLedgerGit({ cwd: shallow }), makeHistoryGit({ cwd: shallow, ref: 'origin/usabl/history' }), 'origin/main');
    if (read.kind !== 'read') throw new Error(read.message);
    expect(read.input.shallow).toBe(true);
    const ledger = buildLedger({ ...read.input, now: NOW });
    const n = ledger.rows.find((row) => row.rule === N.rule);
    expect(n?.mayBeMoreReasons).toEqual(['shallow']);
    expect(n?.incomplete.map((gap) => gap.cause)).toEqual(['not-seen', 'record-off-line', 'shallow']);
    expect(ledger.rows.some((row) => row.firstSeenAtFirstBaseline)).toBe(false);
  });

  it('refuses a folder that is not a git repository, and a branch that never committed a floor', async () => {
    const plain = await mkdtemp(join(root, 'plain-'));
    const notRepo = await readLedgerSources(makeLedgerGit({ cwd: plain }), makeHistoryGit({ cwd: plain }), 'HEAD');
    expect(notRepo).toMatchObject({ kind: 'refused', reason: 'not-a-repository' });

    const empty = join(root, 'empty');
    await git(root, ['init', '--quiet', '--initial-branch=main', empty]);
    await git(empty, ['config', 'user.name', 'Test User']);
    await git(empty, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(empty, 'app.tsx'), 'one\n', 'utf8');
    await git(empty, ['add', 'app.tsx']);
    await git(empty, ['commit', '--quiet', '-m', 'one'], 0);
    const noFloor = await readLedgerSources(makeLedgerGit({ cwd: empty }), makeHistoryGit({ cwd: empty }), 'HEAD');
    expect(noFloor).toMatchObject({ kind: 'refused', reason: 'no-floor' });

    const noRef = await readLedgerSources(makeLedgerGit({ cwd: empty }), makeHistoryGit({ cwd: empty }), 'origin/no-such-branch');
    expect(noRef).toMatchObject({ kind: 'refused', reason: 'no-ref' });
  });
});
