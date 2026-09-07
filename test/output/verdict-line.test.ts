import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { describeVerdict, formatVerdictLine, formatVerdictWord } from '../../src/output/verdict-line.js';

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: {
    changedFiles: [],
    affected: [],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  ...over,
});

const STATES: Array<{ name: string; result: Result; word: string; exit: number }> = [
  { name: 'verified', result: baseResult({}), word: 'VERIFIED', exit: 0 },
  { name: 'regression', result: baseResult({ verdict: 'regression', exitCode: 1 }), word: 'REGRESSION', exit: 1 },
  { name: 'not_covered', result: baseResult({ verdict: 'not_covered', exitCode: 3 }), word: 'NOT COVERED', exit: 3 },
  {
    name: 'approval_required',
    result: baseResult({ verdict: 'approval_required', exitCode: 2 }),
    word: 'APPROVAL REQUIRED',
    exit: 2,
  },
  { name: 'idle', result: baseResult({ verdict: null, exitCode: 0 }), word: 'NO VERDICT: IDLE', exit: 0 },
  { name: 'crash', result: baseResult({ verdict: null, exitCode: 4 }), word: 'NO VERDICT: RUN FAILED', exit: 4 },
];

describe('describeVerdict', () => {
  for (const state of STATES) {
    it(`names ${state.name} with its word, exit code, and one sentence`, () => {
      const line = describeVerdict(state.result);

      expect(line.word).toBe(state.word);
      expect(line.exitCode).toBe(state.exit);
      expect(line.symbol.length).toBeGreaterThan(0);
      // One sentence: ends with a period and fits inside 80 columns under a two-space indent.
      expect(line.meaning.endsWith('.')).toBe(true);
      expect(line.meaning.length).toBeLessThanOrEqual(78);
      expect(formatVerdictWord(line)).toBe(`${state.word} (exit ${state.exit})`);
      expect(formatVerdictLine(line)).toBe(`${line.symbol} ${state.word} (exit ${state.exit})`);
    });
  }

  it('gives every state a different word and a different symbol', () => {
    const lines = STATES.map((state) => describeVerdict(state.result));

    expect(new Set(lines.map((line) => line.word)).size).toBe(STATES.length);
    // Idle and a failed run share the NO VERDICT prefix on purpose; the symbol still differs.
    expect(new Set(lines.map((line) => line.symbol)).size).toBe(STATES.length);
  });

  it('never lets idle or a failed run name the word verified', () => {
    for (const name of ['idle', 'crash']) {
      const state = STATES.find((entry) => entry.name === name)!;
      const line = describeVerdict(state.result);
      const text = `${formatVerdictLine(line)} ${line.meaning}`.toLowerCase();

      expect(line.noVerdict).toBe(true);
      expect(text).not.toContain('verified');
      expect(text).toContain('no verdict');
    }
  });

  it('tells a failed run apart from idle', () => {
    const idle = describeVerdict(STATES[4]!.result);
    const crash = describeVerdict(STATES[5]!.result);

    expect(crash.word).toContain('RUN FAILED');
    expect(crash.word).not.toContain('IDLE');
    expect(idle.word).toContain('IDLE');
    expect(idle.word).not.toContain('FAILED');
    expect(crash.meaning).not.toBe(idle.meaning);
  });

  it('reads the exit code before the verdict so a crash with any verdict shape is a failed run', () => {
    const line = describeVerdict(baseResult({ verdict: null, exitCode: 4, summary: 'unhandled error: boom' }));

    expect(line.word).toBe('NO VERDICT: RUN FAILED');
    expect(line.exitCode).toBe(4);
  });

  it('uses no colour: the line carries no escape sequence in any state', () => {
    for (const state of STATES) {
      const line = describeVerdict(state.result);
      expect(`${formatVerdictLine(line)} ${line.meaning}`).not.toContain("\u001b");
    }
  });
});
