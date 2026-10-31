/**
 * Reading the history for a run. Every way the history can be missing or wrong is an off result
 * with its cause, never a throw.
 */
import { describe, expect, it } from 'vitest';
import { readHistory } from '../../src/history/read.js';
import { serializeRecord } from '../../src/history/record.js';
import { COMMIT_A, COMMIT_B, COMMIT_C, dialogAt, entryFor, floorOf, fullScreen, makeFakeHistory, recordOf } from './helpers.js';

const DIALOG = entryFor(dialogAt(1), 2);
const FLOOR = floorOf([DIALOG]);

function lines(...records: ReturnType<typeof recordOf>[]): string {
  return records.map((record) => `${serializeRecord(record)}\n`).join('');
}

function run(count: number, over: Parameters<typeof recordOf>[2] = {}) {
  return recordOf(FLOOR, [fullScreen('clusters', [[DIALOG, count]])], over);
}

describe('readHistory', () => {
  it('is off with no reader, and says so', async () => {
    expect(await readHistory(undefined, 'HEAD')).toEqual({ kind: 'off', cause: 'no-reader', detail: null, head: null });
  });

  it('is off when there is no history branch', async () => {
    const store = makeFakeHistory({ main: { [COMMIT_A]: [] }, refs: { HEAD: COMMIT_A } });

    expect(await readHistory(store.writer, 'HEAD')).toMatchObject({ kind: 'off', cause: 'no-history' });
  });

  it('is off when the base commit cannot be resolved', async () => {
    const store = makeFakeHistory({ refs: { 'origin/usabl/history': 'h1' }, commits: { h1: {} } });

    expect(await readHistory(store.writer, 'origin/main')).toMatchObject({ kind: 'off', cause: 'no-base', head: 'h1' });
  });

  it('is off, naming the file and line, when one record cannot be read', async () => {
    const store = makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1', HEAD: COMMIT_A },
      main: { [COMMIT_A]: [] },
      commits: { h1: { '2026-10.jsonl': `${lines(run(1))}{"schema":"usabl.history.v1"}\n` } },
    });

    expect(await readHistory(store.writer, 'HEAD')).toEqual({
      kind: 'off', cause: 'unreadable', head: 'h1',
      detail: '2026-10.jsonl line 2.time is missing',
    });
  });

  it('reads only records at the base commit or its ancestors, in file and line order', async () => {
    const store = makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1', 'origin/main': COMMIT_B },
      main: { [COMMIT_B]: [COMMIT_A], [COMMIT_C]: [COMMIT_B, COMMIT_A] },
      commits: {
        h1: {
          '2026-09.jsonl': lines(run(2, { commit: COMMIT_A, time: '2026-09-30T00:00:00.000Z' })),
          '2026-10.jsonl': lines(run(1, { commit: COMMIT_B, time: '2026-10-01T00:00:00.000Z' }), run(1, { commit: COMMIT_C, time: '2026-10-02T00:00:00.000Z' })),
          'README.md': 'not a history file',
        },
      },
    });

    const read = await readHistory(store.writer, 'origin/main');

    expect(read.kind).toBe('on');
    if (read.kind !== 'on') return;
    expect(read.records.map((record) => record.commit)).toEqual([COMMIT_A, COMMIT_B]);
  });
});
