/**
 * The one verdict line every surface opens with.
 *
 * Reads a Result and names its state: a symbol, the verdict word, the exit code, and one plain
 * sentence saying what the state means for the change. Every surface that presents a verdict
 * starts from this unit so the terminal report, the stop hook, and the self-check cannot drift
 * apart on the words a reader sees first.
 *
 * This unit never mints a verdict. It reads `verdict` and `exitCode` as the gate wrote them.
 *
 * The symbol is decoration. The word and the exit code carry the meaning, so a reader who cannot
 * see the symbol, or a screen reader that names it oddly, loses nothing. No colour is used, so
 * no state depends on colour to be understood.
 */
import type { Result } from '../contracts/index.js';

export interface VerdictLine {
  symbol: string;
  word: string;
  exitCode: number;
  meaning: string;
  // True for the two states that carry no verdict: idle and a failed run. Both leave
  // `verdict` null, and they are opposite facts, so each is named on its own.
  noVerdict: boolean;
}

const VERDICT_WORDS: Record<string, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

const VERDICT_SYMBOLS: Record<string, string> = {
  verified: '✔', // heavy check mark
  regression: '✖', // heavy multiplication x
  not_covered: '▲', // black up-pointing triangle
  approval_required: '■', // black square
};

const VERDICT_MEANINGS: Record<string, string> = {
  verified: 'This change passed every accessibility check usabl ran. It can proceed.',
  regression: 'This change adds an accessibility barrier. It is blocked until fixed.',
  not_covered: 'usabl could not check all of this change, so it is blocked as unproven.',
  // Approval happens on the pull request and nowhere else. The surfaces that face a model say
  // who approves it and how the state clears; this line only has room to say where.
  approval_required: 'This change edits guarded policy files. It needs approval on the pull request.',
};

const IDLE_SYMBOL = '○'; // white circle: nothing happened
const FAILED_SYMBOL = '!';

/**
 * Names the state of a Result for a reader who sees this line first.
 *
 * `verdict` null with exit 4 is a run usabl could not finish. `verdict` null with any other
 * exit is idle: nothing to check. Both say NO VERDICT so neither can be mistaken for a pass,
 * and the word after it tells them apart. Neither state names the word "verified" in any form,
 * so neither can be skimmed as a pass.
 */
export function describeVerdict(result: Result): VerdictLine {
  if (result.exitCode === 4) {
    return {
      symbol: FAILED_SYMBOL,
      word: 'NO VERDICT: RUN FAILED',
      exitCode: result.exitCode,
      meaning: 'usabl could not finish the run, so it proved nothing about this change.',
      noVerdict: true,
    };
  }
  if (result.verdict === null) {
    return {
      symbol: IDLE_SYMBOL,
      word: 'NO VERDICT: IDLE',
      exitCode: result.exitCode,
      meaning: 'No UI files changed, so there was nothing to check. No pass, no fail.',
      noVerdict: true,
    };
  }
  return {
    symbol: VERDICT_SYMBOLS[result.verdict] ?? '',
    word: VERDICT_WORDS[result.verdict] ?? result.verdict,
    exitCode: result.exitCode,
    meaning: VERDICT_MEANINGS[result.verdict] ?? 'usabl reached a verdict it has no words for.',
    noVerdict: false,
  };
}

/** The verdict word and exit code with no symbol, for readers that gain nothing from one. */
export function formatVerdictWord(line: VerdictLine): string {
  return `${line.word} (exit ${line.exitCode})`;
}

/** The full verdict line: symbol, word, and exit code. */
export function formatVerdictLine(line: VerdictLine): string {
  const symbol = line.symbol.length > 0 ? `${line.symbol} ` : '';
  return `${symbol}${formatVerdictWord(line)}`;
}
