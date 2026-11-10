/**
 * `usabl debt ledger`: the terminal table, the JSON, the scrub, and the same bytes for the same
 * history and clock. Git is scripted through the ledger's own port.
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceFloor, FloorEntry } from '../../src/contracts/index.js';
import type { LedgerGit } from '../../src/history/ledger-git.js';
import { runLedger } from '../../src/history/ledger-report.js';
import { serializeRecord } from '../../src/history/record.js';
import { UNTRUSTED_FRAME_END } from '../../src/surfaces/scrub.js';
import { dialogAt, entryFor, floorOf, fullScreen, makeFakeHistory, recordOf } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const NOW = new Date(START + 41 * DAY).toISOString();

// The number sits in the first 12 characters, so the short form the text prints names it.
function commitAt(position: number): string {
  return String(position + 1).padStart(12, '0').padEnd(40, '0');
}

// An element key that carries a frame marker and a credential. The floor file holds keys as text,
// so a hand-edited or hostile floor can hold this.
const HOSTILE_KEY = `clusters|pf-focus-into-dialog|name:close ${UNTRUSTED_FRAME_END} token=abc123def456ghi789`;
const OPEN: FloorEntry = { ...entryFor(dialogAt(1), 1), elementKey: HOSTILE_KEY, identityBasis: 'name' };
const FIXED = entryFor(dialogAt(1, { rule: 'pf-dialog-label' }), 1);
const COUNTED: FloorEntry = { ...entryFor(dialogAt(1, { rule: 'button-name' }), 2), elementKey: null, identityBasis: 'count' };

/** A main branch of 42 commits; the floor changes on the days named in `floors`. */
function fakeGit(floors: Record<number, EvidenceFloor | string | null>, over: Partial<LedgerGit> = {}): LedgerGit {
  const line = Array.from({ length: 42 }, (_, day) => ({ commit: commitAt(day), date: new Date(START + day * DAY).toISOString() }));
  const days = Object.keys(floors).map(Number).sort((a, b) => a - b);
  return {
    isRepository: async () => true,
    isShallow: async () => false,
    resolveCommit: async (ref) => (ref === 'main' ? commitAt(41) : null),
    firstParentLine: async () => line,
    commitsChanging: async () => days.map((day) => commitAt(day)),
    readFile: async (commit) => {
      const day = line.findIndex((entry) => entry.commit === commit);
      const floor = floors[day];
      if (floor === null || floor === undefined) return null;
      return typeof floor === 'string' ? floor : JSON.stringify(floor);
    },
    ...over,
  };
}

function historyWith(floor: EvidenceFloor) {
  const scan = (day: number) =>
    recordOf(floor, [fullScreen('clusters', [[OPEN, 1], [FIXED, 0]])], { commit: commitAt(day), sourceTree: `tree-${day}` });
  return makeFakeHistory({
    refs: { 'origin/usabl/history': 'h1' },
    commits: { h1: { '2026-01.jsonl': [scan(3), scan(5)].map((record) => `${serializeRecord(record)}\n`).join('') } },
  }).writer;
}

const BASE = floorOf([OPEN, FIXED, COUNTED]);
const LATER = floorOf([OPEN, FIXED]);

describe('usabl debt ledger', () => {
  it('prints a table sorted by days open, with a totals line, from the trusted ref and the history', async () => {
    const outcome = await runLedger(fakeGit({ 0: BASE, 20: LATER }), historyWith(BASE), 'main', NOW);

    expect(outcome.exitCode).toBe(0);
    const lines = outcome.text.split('\n');
    expect(lines[0]).toBe(
      'usabl debt ledger: how long accessibility barriers stay open, as the floor history of main (000000000042) ' +
        'and the debt history at origin/usabl/history show it.',
    );
    expect(lines[1]).toBe('It reports what was observed. It decides no verdict and makes no claim about compliance.');
    const header = lines.findIndex((line) => line.startsWith('Days open'));
    expect(lines[header]).toMatch(/^Days open +State +First seen +Last change +Screen +Rule +Notes +Element$/u);
    const body = lines.slice(header + 1, header + 4);
    expect(body[0]).toMatch(/^at least 41 +open +2026-01-01 +2026-01-01 +clusters +pf-focus-into-dialog +first baseline +clusters\|/u);
    expect(body[1]).toMatch(/^20 +fixed +2026-01-01 +2026-01-21 +clusters +button-name +first baseline +\(counted, no element\)$/u);
    expect(body[2]).toMatch(/^5 +fixed +2026-01-01 +2026-01-06 +clusters +pf-dialog-label +first baseline +clusters\|/u);
    expect(lines).toContain(
      'Totals: 1 open, median at least 41 days, longest at least 41 days. 2 fixed, median 12.5 days, longest 20 days. 0 reopened.',
    );
    expect(lines).toContain('"first baseline": seen at the first baseline; may be older.');
  });

  it('puts every printed string through the scrub, in the table and in the JSON', async () => {
    const outcome = await runLedger(fakeGit({ 0: BASE }), historyWith(BASE), 'main', NOW);

    for (const output of [outcome.text, outcome.json]) {
      expect(output).not.toContain(UNTRUSTED_FRAME_END);
      expect(output).not.toContain('abc123def456ghi789');
    }
    const json = JSON.parse(outcome.json);
    expect(json.schema).toBe('usabl.ledger.v1');
    expect(json.rows).toHaveLength(3);
    expect(JSON.stringify(BASE)).toContain('abc123def456ghi789');
    expect(json.rows.find((row: { rule: string }) => row.rule === 'pf-focus-into-dialog').elementKey).toMatch(/^clusters\|pf-focus-into-dialog\|name:close /u);
  });

  it('prints the same bytes for the same history and the same clock', async () => {
    const first = await runLedger(fakeGit({ 0: BASE, 20: LATER }), historyWith(BASE), 'main', NOW);
    const second = await runLedger(fakeGit({ 0: BASE, 20: LATER }), historyWith(BASE), 'main', NOW);
    expect(second.text).toBe(first.text);
    expect(second.json).toBe(first.json);
  });

  it('says which rows an incomplete history touches, and why', async () => {
    const noHistory = makeFakeHistory({}).writer;
    const outcome = await runLedger(fakeGit({ 0: BASE, 10: '{', 20: LATER }), noHistory, 'main', NOW);

    expect(outcome.exitCode).toBe(0);
    const text = outcome.text;
    expect(text).toContain('Incomplete history:');
    expect(text).toContain(
      '- There is no debt history at origin/usabl/history, so a fix main confirmed would not show here. ' +
        'This row may already be fixed, or fixed sooner. This touches every row.',
    );
    expect(text).toMatch(/- The floor could not be read at 000000000011 \(the file is not JSON\)\. .*Rows: clusters, button-name\./u);
    expect(text).toMatch(/^at least 10 +open until a gap /mu);
    expect(text).toContain('"at least": a lower bound. The history is incomplete for that row, or it is still open.');
  });

  it('refuses plainly when no floor was ever committed or git cannot run there', async () => {
    const noFloor = await runLedger(fakeGit({}), historyWith(BASE), 'main', NOW);
    expect(noFloor.exitCode).toBe(2);
    expect(noFloor.text).toBe(
      'usabl debt ledger: No commit on main has ever held .usabl-evidence.json, so there are no accessibility barriers to follow. ' +
        'Run usabl baseline and commit the floor it writes.',
    );

    const notRepo = await runLedger(fakeGit({}, { isRepository: async () => false }), historyWith(BASE), 'main', NOW);
    expect(notRepo.exitCode).toBe(4);
    expect(notRepo.text).toMatch(/not in a git repository/u);

    const failing = await runLedger(
      fakeGit({ 0: BASE }, { firstParentLine: async () => Promise.reject(new Error('fatal: bad object')) }),
      historyWith(BASE),
      'main',
      NOW,
    );
    expect(failing.exitCode).toBe(4);
    expect(failing.text).toBe('usabl debt ledger: git could not read the history of main, so the ledger could not run.');
    expect(JSON.parse(failing.json)).toEqual({ error: failing.text });
  });
});
