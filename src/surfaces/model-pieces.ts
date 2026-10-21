/**
 * The pieces the two model-facing surfaces, the stop hook and the self-check, build the same way.
 *
 * Both print plain text to a language model, and their seal is the untrusted frame. The rule on
 * both is by carrier, the same rule the pull request comment follows: every value the Result
 * carried goes inside the frame or is type-checked, whoever authored it. Scaffold, the text
 * outside the frame, is usabl's own words, checked counts, and known enum words only.
 *
 * Held here so the two surfaces cannot disagree about what is scaffold and what is a piece.
 * This unit formats text only. It must never decide a verdict.
 */
import type { Result } from '../contracts/index.js';
import { boundField } from '../output/bounded-text.js';
import { NOT_A_LIST, wholeNumberText } from '../output/carried.js';
import {
  APPROVAL_REQUIRED_HOW_IT_CLEARS,
  APPROVAL_REQUIRED_HUMAN_LEVER,
  discloseGaps,
  gapDetail,
  gapHeadline,
  guardedFilesHeadline,
} from '../output/disclosure.js';

/**
 * What the run did not examine, one entry per gap state, bounded by the number of states.
 *
 * Each entry pairs the gap headline, which names a known state or the word for an unknown one and
 * counts the rest, with the detail, so a model can map a reason to its state inside the frame.
 * The ref and the reason are bounded on their own before the headline is attached, so the count
 * is never cut. A gap list that is not a list is reported as unreadable rather than walked.
 */
export function notEvaluatedPieces(result: Result): string[] {
  const gaps: unknown = result.coverage.gaps;
  if (!Array.isArray(gaps)) {
    return [NOT_A_LIST];
  }
  return discloseGaps(gaps).map((disclosure) => {
    const detail = gapDetail({
      ...disclosure,
      ref: boundField(disclosure.ref, 'gapRef'),
      reason: boundField(disclosure.reason, 'gapReason'),
    });
    return `- ${gapHeadline(disclosure)}: ${detail}`;
  });
}

/** The label of the framed piece that names the guarded files. */
export const GUARDED_FILES_LABEL = 'guarded files';

/**
 * What a reader is told when guarded files changed: which files, how the state clears, and the
 * one lever a person has.
 *
 * The paths are carried by the Result, and a pull request author chooses the name of any file
 * they add under a guarded directory, so a path is text someone else wrote. The paths therefore go
 * inside the frame as one piece, bounded as a whole, where a model still reads every name. The
 * scaffold line says how many changed and where the names are, so the model knows to look there,
 * and the count is printed only when it is a whole number. The piece is placed directly after the
 * gate's summary, and callers keep it when the message is shortened, because the next step tells
 * the model to raise these files with the user and it cannot name a file it was not given.
 */
export function guardedFileLines(result: Result): { scaffold: string[]; piece: string | null } {
  const paths: unknown = result.dirtyGuardedPaths;
  const tail = [APPROVAL_REQUIRED_HOW_IT_CLEARS, APPROVAL_REQUIRED_HUMAN_LEVER];
  if (!Array.isArray(paths)) {
    return { scaffold: [`${guardedFilesHeadline(2)}: ${NOT_A_LIST.replace(/^- /, '')}`, ...tail], piece: null };
  }
  if (paths.length === 0) {
    return { scaffold: [`${guardedFilesHeadline(0)}: none recorded`, ...tail], piece: null };
  }
  return {
    scaffold: [
      `${guardedFilesHeadline(paths.length)}: ${wholeNumberText(paths.length)}, named under "${GUARDED_FILES_LABEL}" in the untrusted text below`,
      ...tail,
    ],
    piece: `${GUARDED_FILES_LABEL}: ${boundField(paths.map(String).join(', '), 'candidates')}`,
  };
}
