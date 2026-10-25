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
import type { Finding, Result } from '../contracts/index.js';
import { boundField, type BoundedGroup } from '../output/bounded-text.js';
import { NOT_A_LIST, wholeNumberText } from '../output/carried.js';
import { unconfirmedNotice } from '../output/floor-notice.js';
import {
  APPROVAL_REQUIRED_HOW_IT_CLEARS,
  APPROVAL_REQUIRED_HUMAN_LEVER,
  discloseGaps,
  fixOrAbsence,
  gapDetail,
  gapHeadline,
  guardedFilesHeadline,
} from '../output/disclosure.js';
import {
  formatCollapsedGroupStatus,
  formatShowAllHint,
  type CollapsedFindingGroup,
  type NoiseBudgetView,
} from '../output/noise-budget.js';

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

/**
 * The notices for floored barriers the run did not see and cannot call fixed, one framed piece
 * per screen.
 *
 * Each notice names a screen id and rules the Result carried, and a count, so the whole sentence
 * is a piece inside the frame and nothing of it is scaffold. Callers pass these as tail pieces
 * after the gap lines: like a gap, a notice limits what the run can claim, so a shortened message
 * drops every barrier before it drops one. A list that is not a list is reported as unreadable.
 */
export function unconfirmedPieces(result: Result): string[] {
  const entries: unknown = result.floorUnconfirmed;
  if (entries === undefined) {
    return [];
  }
  if (!Array.isArray(entries)) {
    return [NOT_A_LIST];
  }
  return entries.map((entry) => `not claimed fixed: ${boundField(unconfirmedNotice(entry), 'notice')}`);
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

/**
 * A group whose free-text fields are bounded for printing. The count is left alone, so a headline
 * can say how many findings a rule stands for even when the rule was cut short.
 *
 * The screen id, the layer, and the rule are all printed inside the frame, never in a headline.
 * The rule used to be printed outside it, on the argument that the first-party providers author
 * it. That argument is about who wrote a value, and the Result does not record who wrote it: a
 * library caller can supply a check runner of its own, so the decision is by carrier instead.
 */
function boundGroup(group: CollapsedFindingGroup): CollapsedFindingGroup {
  return {
    ...group,
    screenId: boundField(String(group.screenId), 'screenId'),
    layer: boundField(String(group.layer), 'layer'),
    rule: boundField(String(group.rule), 'rule'),
  };
}

/** The barriers a model-facing message lists, ready for assembleBoundedMessage. */
export interface BarrierLines {
  groupHeading?: string;
  groups: BoundedGroup[];
  groupFooter: (shownGroups: number) => string | null;
}

/**
 * The barriers a model-facing message lists, one group per rule.
 *
 * A group's headline, outside the frame, carries only its checked status, severity, and count.
 * Its pieces, inside the frame, name the layer and rule, the screen, any extra pieces the surface
 * adds (the self-check adds the source location), the experience, and the fix. One barrier reads
 * `Barrier: [new serious]` with unnumbered pieces. Several are numbered, so a headline and its
 * pieces match by number and no label is built from a value the Result carried.
 *
 * Each group is handed to the message assembler whole, so a shortened message drops a barrier's
 * headline and its pieces together and never keeps a headline whose rule is nowhere in the
 * message. The footer is built from how many groups survive, so its count is the count shown.
 */
export function barrierLines(
  view: NoiseBudgetView,
  extraPieces: (finding: Finding, label: string) => string[] = () => [],
): BarrierLines {
  const groupFooter = (shownGroups: number): string | null =>
    view.grouped || view.collapsed || shownGroups < view.groups.length
      ? formatShowAllHint(
          { totalFindingCount: view.totalCount, shownGroupCount: shownGroups, totalGroupCount: view.totalGroupCount },
          'gating findings',
        )
      : null;

  if (view.groups.length === 1 && !view.collapsed) {
    const group = boundGroup(view.groups[0]!);
    return {
      groups: [
        {
          headline: `Barrier: ${formatCollapsedGroupStatus(group)}`,
          pieces: [
            `barrier: ${group.layer}/${group.rule}`,
            `screen: ${group.screenId}`,
            ...extraPieces(group.representative, ''),
            `experience: ${boundField(group.representative.whatUserExperiences, 'experience')}`,
            `fix: ${boundField(fixOrAbsence(group.representative), 'fix')}`,
          ],
        },
      ],
      // One barrier is the whole list, so there is no count to disclose beside it.
      groupFooter: () => null,
    };
  }

  const groups = view.groups.map((raw, index): BoundedGroup => {
    const group = boundGroup(raw);
    const n = index + 1;
    return {
      headline: `- barrier ${n}: ${formatCollapsedGroupStatus(group)}`,
      pieces: [
        `barrier ${n}: ${group.layer}/${group.rule}`,
        `screen (${n}): ${group.screenId}`,
        ...extraPieces(group.representative, ` (${n})`),
        `experience (${n}): ${boundField(group.representative.whatUserExperiences, 'experience')}`,
        `fix (${n}): ${boundField(fixOrAbsence(group.representative), 'fix')}`,
      ],
    };
  });
  return { groupHeading: 'Barriers:', groups, groupFooter };
}
