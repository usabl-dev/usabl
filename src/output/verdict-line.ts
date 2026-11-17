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
import type { Finding, Result } from '../contracts/index.js';
import { ownEntry, wholeNumberText } from './carried.js';
import { isBlockingBarrier } from './disclosure.js';
import { listFileNotes } from './file-notes.js';
import { hasKnownLimits } from './notes.js';

export interface VerdictLine {
  symbol: string;
  word: string;
  exitCode: number;
  meaning: string;
  // True for the states that carry no verdict: idle, a failed run, and a run that had something
  // to check and reached no verdict. All leave `verdict` null, and they are different facts, so
  // each is named on its own.
  noVerdict: boolean;
  // True when the run reached a verdict and a region the keyboard walk could not read was listed
  // as a known limit. The line then says "with known limits" after the exit code, so a reader
  // never takes the verdict for a check of the whole screen.
  knownLimits?: boolean;
}

const KNOWN_LIMITS_NOTE = 'with known limits';

// Longer than the 78 columns the other meanings fit, so it wraps on a narrow terminal. It says
// whose list the unchecked parts come from, so a reader knows a person chose to leave them out.
const VERIFIED_WITH_LIMITS_MEANING =
  'No new accessibility barrier blocks this change. Parts your team listed as known limits were not checked.';

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
  // Not "passed every check". A verified run routinely carries recorded debt, and on the
  // application this was measured against it carried twenty definite failures the floor had
  // accepted. Verified means no NEW barrier blocks the change, which is what the gate decided and
  // what the overlay's own lead sentence already said.
  verified: 'No new accessibility barrier blocks this change. It can proceed.',
  regression: 'This change adds an accessibility barrier. It is blocked until fixed.',
  not_covered: 'usabl could not check all of this change, so it is blocked as unproven.',
  // Approval happens on the pull request and nowhere else. The surfaces that face a model say
  // who approves it and how the state clears; this line only has room to say where.
  approval_required: 'This change edits guarded policy files. It needs approval on the pull request.',
};

// not_covered has two causes, and the gate's words for them differ. Coverage failed: a gap or a
// file usabl could not map, so part of the change was not checked. Or a new finding could not be
// decided: the change was checked, and a person has to look. The default sentence above is for the
// first cause, and it stays the answer whenever this unit cannot see the second one alone, so an
// unchecked change is never described as checked.
const NOT_COVERED_UNDECIDED_MEANING = 'Checked, but some checks could not decide. A person must review them to pass.';
const NOT_COVERED_BOTH_MEANING = 'usabl could not check all of this change, and some checks could not decide.';

/**
 * The not_covered sentence for the causes this Result shows. It reads the coverage lists and the
 * findings the gate wrote and decides no verdict.
 */
function notCoveredMeaning(result: Result): string | undefined {
  const coverage = result.coverage as { gaps?: unknown; unresolvedFiles?: unknown } | undefined;
  const coverageFailed =
    !Array.isArray(coverage?.gaps) ||
    !Array.isArray(coverage?.unresolvedFiles) ||
    coverage.gaps.length > 0 ||
    coverage.unresolvedFiles.length > 0;
  const findings: unknown = result.findings;
  const undecided =
    Array.isArray(findings) &&
    findings.some(
      (finding: Finding) =>
        typeof finding === 'object' && finding !== null && isBlockingBarrier(finding) && finding.confidence === 'unverified',
    );
  if (!undecided) {
    return undefined;
  }
  return coverageFailed ? NOT_COVERED_BOTH_MEANING : NOT_COVERED_UNDECIDED_MEANING;
}

const IDLE_SYMBOL = '○'; // white circle: nothing happened
const FAILED_SYMBOL = '!';
const NO_VERDICT_SYMBOL = '?';

/**
 * The word for a verdict usabl has no word for.
 *
 * A fixed label, never the verdict that arrived. `Result` is exported and one can be composed
 * outside the engine or parsed from a document, so at runtime `verdict` is any string, and this
 * word is printed in the one position every surface treats as its own: the opening line, outside
 * the untrusted frame on the surfaces that have one. Echoing an unrecognized verdict there would
 * put text usabl did not write where a reader, and on two surfaces a language model, reads
 * usabl's own voice. The reader still learns the state, because the exit code and the meaning
 * sentence are printed beside it. The gap disclosure holds the same line for a gap state.
 */
const UNRECOGNIZED_VERDICT_WORD = 'UNRECOGNIZED VERDICT';

/**
 * The exit code as text, or a word saying it was not one.
 *
 * The contract types this a number and a Result from `run()` always carries one, but a composed
 * or parsed Result can carry anything, and this is printed as usabl's own text. A value that is
 * not a whole number is named as unknown rather than pasted into the line.
 */
function formatExitCode(exitCode: number): string {
  return wholeNumberText(exitCode);
}

/**
 * Names the state of a Result for a reader who sees this line first.
 *
 * `verdict` null with exit 4 is a run usabl could not finish. `verdict` null with
 * `nothingToCheck` true is idle: nothing to check. Any other null verdict is a run that had
 * something to check and reached no verdict, which only a Result composed outside run() can
 * carry; it proved nothing about the change, in the words the stop hook and the self-check use
 * for it. Reading it as idle told the reader nothing UI-touching changed, the opposite of what
 * happened. All three say NO VERDICT so none can be mistaken for a pass, and the word after it
 * tells the first two apart. None names the word "verified" in any form, so none can be skimmed
 * as a pass.
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
  if (result.verdict === null && result.coverage?.nothingToCheck !== true) {
    // The stop hook and the self-check say this in a longer sentence. This one keeps the same
    // words inside the 80 columns the terminal report holds its own lines to.
    return {
      symbol: NO_VERDICT_SYMBOL,
      word: 'NO VERDICT',
      exitCode: result.exitCode,
      meaning: 'usabl did not reach a verdict, so the run proved nothing about this change.',
      noVerdict: true,
    };
  }
  if (result.verdict === null) {
    // When the planner left changed files out on purpose, files under the UI globs did change, so
    // "No UI files changed" would not be true.
    const excludedAny = listFileNotes(result.coverage?.excludedFiles).count > 0;
    return {
      symbol: IDLE_SYMBOL,
      word: 'NO VERDICT: IDLE',
      exitCode: result.exitCode,
      meaning: excludedAny
        ? 'Every changed file usabl would check was left out on purpose. No pass, no fail.'
        : 'No UI files changed, so there was nothing to check. No pass, no fail.',
      noVerdict: true,
    };
  }
  // A listed region is a known limit. Only the verified meaning changes, because it is the one a
  // reader could take for a check of everything. A blocked verdict already says it is blocked.
  const knownLimits = hasKnownLimits(result);
  const meaning =
    (result.verdict === 'not_covered' ? notCoveredMeaning(result) : undefined) ??
    ownEntry(VERDICT_MEANINGS, result.verdict) ??
    'usabl reached a verdict it has no words for.';
  return {
    symbol: ownEntry(VERDICT_SYMBOLS, result.verdict) ?? '',
    word: ownEntry(VERDICT_WORDS, result.verdict) ?? UNRECOGNIZED_VERDICT_WORD,
    exitCode: result.exitCode,
    meaning: knownLimits && result.verdict === 'verified' ? VERIFIED_WITH_LIMITS_MEANING : meaning,
    noVerdict: false,
    ...(knownLimits ? { knownLimits: true } : {}),
  };
}

/**
 * The verdict word and exit code with no symbol, for readers that gain nothing from one. Known
 * limits, then a note when given, go inside the parentheses after the exit code, so they are read
 * with the verdict.
 */
export function formatVerdictWord(line: VerdictLine, note?: string): string {
  const notes = [...(line.knownLimits === true ? [KNOWN_LIMITS_NOTE] : []), ...(note === undefined ? [] : [note])];
  const suffix = notes.map((text) => `, ${text}`).join('');
  return `${line.word} (exit ${formatExitCode(line.exitCode)}${suffix})`;
}

/** The full verdict line: symbol, word, and exit code. */
export function formatVerdictLine(line: VerdictLine): string {
  const symbol = line.symbol.length > 0 ? `${line.symbol} ` : '';
  return `${symbol}${formatVerdictWord(line)}`;
}
