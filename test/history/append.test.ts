/**
 * Appending a record to the history branch. Append-only, and nothing is written when the record
 * or the history cannot be read.
 */
import { describe, expect, it } from 'vitest';
import { appendRecord } from '../../src/history/append.js';
import { parseHistoryFile, serializeRecord } from '../../src/history/record.js';
import { COMMIT_A, COMMIT_B, floorOf, makeFakeHistory, recordOf } from './helpers.js';

const RECORD = recordOf(floorOf([]), [], { commit: COMMIT_B, time: '2026-10-28T00:00:00.000Z' });

describe('appendRecord', () => {
  it('starts the history when there is no branch yet', async () => {
    const store = makeFakeHistory({ main: { [COMMIT_B]: [] } });

    const outcome = await appendRecord(store.writer, serializeRecord(RECORD));

    expect(outcome.exitCode).toBe(0);
    expect(store.branches['usabl/history']).toBe(outcome.commit);
    expect(parseHistoryFile(store.commits[outcome.commit!]!['2026-10.jsonl']!, '2026-10.jsonl')).toEqual([RECORD]);
    expect(outcome.message).toContain('git push origin usabl/history');
  });

  it('adds the record as the last line and keeps every other file as it was', async () => {
    const earlier = serializeRecord(recordOf(floorOf([]), [], { commit: COMMIT_A, time: '2026-10-01T00:00:00.000Z' }));
    const september = serializeRecord(recordOf(floorOf([]), [], { commit: COMMIT_A, time: '2026-09-01T00:00:00.000Z' }));
    const store = makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1' },
      main: { [COMMIT_B]: [COMMIT_A] },
      commits: { h1: { '2026-09.jsonl': `${september}\n`, '2026-10.jsonl': `${earlier}\n` } },
    });

    const outcome = await appendRecord(store.writer, serializeRecord(RECORD));
    const files = store.commits[outcome.commit!]!;

    expect(files['2026-09.jsonl']).toBe(`${september}\n`);
    expect(files['2026-10.jsonl']).toBe(`${earlier}\n${serializeRecord(RECORD)}\n`);
  });

  it('refuses a record that carries an element key, and writes nothing', async () => {
    const store = makeFakeHistory();
    const leaking = { ...RECORD, screens: [{ screenId: 'jobs', coverage: 'full', identities: [{ id: 'jobs|button-name|name:edit', rule: 'button-name', basis: 'name', count: 1 }] }] };

    const outcome = await appendRecord(store.writer, JSON.stringify(leaking));

    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain('Nothing was appended');
    expect(store.branches).toEqual({});
  });

  it('refuses to append to a history it cannot read, and says how to recover', async () => {
    const store = makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1' },
      main: { [COMMIT_B]: [] },
      commits: { h1: { '2026-10.jsonl': 'not json\n' } },
    });

    const outcome = await appendRecord(store.writer, serializeRecord(RECORD));

    expect(outcome.exitCode).toBe(4);
    expect(outcome.message).toContain('2026-10.jsonl line 1 is not JSON');
    expect(store.branches).toEqual({});
  });
});
