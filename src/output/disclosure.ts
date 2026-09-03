/**
 * One definition of what a surface owes a blocked reader.
 *
 * Every operator surface projects the same Result and they used to decide independently how much
 * of it to show, which is why the pull request comment printed every gap reason and the stop hook
 * printed a count. A count is not actionable. This unit holds the shared answer so the surfaces
 * cannot drift apart again.
 *
 * It returns raw strings and never sanitizes. Sanitizing is the caller's decision because it
 * differs by audience: a person reading a terminal gets neutralized text, and a model reading the
 * stop hook gets the same text inside an untrusted frame.
 *
 * This unit renders no verdict and reads no coverage rule. It formats what the gate already said.
 */
import type { CoverageGap, Finding } from '../contracts/index.js';

/**
 * Printed in place of a fix when the engine recorded none. Only five axe rules carry a curated
 * note, and for every other rule the fix falls back to axe's failureSummary, which can be empty.
 * A blank where the fix belongs reads as a rendering bug, so the absence is stated instead.
 */
export const NO_FIX_RECORDED = 'no fix recorded for this rule';

/**
 * How urgently a reader needs each state, lowest first. Not the order they were recorded.
 *
 * `capability-denied` and `skipped` are usabl saying it did not run a check at all, which limits
 * what the whole run can claim. `not-covered` and `unresolved` are about a screen or a file. A
 * noisy pile of unreachable screens must never be able to bury the fact that a check never ran,
 * so the claim-limiting states are named first and every present state is always named.
 *
 * A keyed record rather than a list, so adding a state to the contract fails to compile until
 * somebody gives it a rank here. The point is not that a new state would otherwise be dropped,
 * because the sweep below catches that. The point is that ranking a state against
 * `capability-denied` is a judgement, and this makes somebody make it rather than let a new state
 * land wherever the code happens to put it.
 */
const STATE_PRIORITY: Record<CoverageGap['state'], number> = {
  'capability-denied': 0,
  skipped: 1,
  'not-covered': 2,
  unresolved: 3,
};

const STATE_ORDER: ReadonlyArray<CoverageGap['state']> = (
  Object.keys(STATE_PRIORITY) as Array<CoverageGap['state']>
).sort((left, right) => STATE_PRIORITY[left] - STATE_PRIORITY[right]);

const RECOGNIZED_STATES: ReadonlySet<string> = new Set<string>(STATE_ORDER);

/**
 * The label for gaps whose state usabl does not recognize.
 *
 * A fixed string, never the state that arrived. The label is printed outside the untrusted frame
 * on model-facing surfaces and without neutralization on the CLI, which is only safe because it
 * is normally one of four values usabl chose. Echoing a caller-supplied state there would put
 * unsanitized text in the one position on these surfaces that is trusted by construction. The
 * reader still learns which gap it was, because the ref and the reason travel in `gapDetail`,
 * which every caller sanitizes.
 */
export const UNRECOGNIZED_GAP_STATE = 'unrecognized';

/** One state of missing coverage: a named example, and how many more share that state. */
export interface GapDisclosure {
  state: CoverageGap['state'] | typeof UNRECOGNIZED_GAP_STATE;
  ref: string;
  reason: string;
  more: number; // further gaps in this state that the surface did not name
}

/**
 * One entry per gap state present, so the number of lines is bounded by the number of states
 * rather than by the number of gaps. Bounding by construction is the point: a surface that
 * assembled every gap and then cut the string to length could cut a closing frame marker and
 * hand a model an unterminated untrusted block.
 *
 * Every gap is accounted for, either by name or in a `more` count. `state` is only a compile-time
 * union: `gate` and `Result` are exported from the package entry point and a Result can arrive as
 * parsed JSON, so at runtime a state can be any string. Walking the known states alone would drop
 * those gaps silently, and a run whose gaps were all unrecognized would print no coverage section
 * at all, which is the exact defect this unit exists to remove. Anything left over is therefore
 * swept into one trailing entry. Trailing because usabl cannot rank a state it does not know, and
 * guessing a rank for it could push a `capability-denied` gap down the list.
 */
export function discloseGaps(gaps: readonly CoverageGap[]): GapDisclosure[] {
  const disclosures: GapDisclosure[] = [];

  for (const state of STATE_ORDER) {
    const inState = gaps.filter((entry) => entry.state === state);
    const first = inState[0];
    if (first === undefined) {
      continue;
    }
    disclosures.push({ state, ref: first.ref, reason: first.reason, more: inState.length - 1 });
  }

  const unrecognized = gaps.filter((entry) => !RECOGNIZED_STATES.has(entry.state));
  const firstUnrecognized = unrecognized[0];
  if (firstUnrecognized !== undefined) {
    disclosures.push({
      state: UNRECOGNIZED_GAP_STATE,
      ref: firstUnrecognized.ref,
      reason: firstUnrecognized.reason,
      more: unrecognized.length - 1,
    });
  }

  return disclosures;
}

/** The label for one state, disclosing how many gaps in it went unnamed. */
export function gapHeadline(disclosure: GapDisclosure): string {
  const more = disclosure.more > 0 ? `, and ${disclosure.more} more with this state` : '';
  return `[${disclosure.state}]${more}`;
}

/**
 * The named example for one state. Raw and page-derived: a ref can be a scanned URL and a reason
 * can carry a provider error message, so every caller sanitizes this before printing it.
 *
 * The ref stands alone when there is no reason. The contract says a reason is never empty and
 * nothing enforces it, so a Result composed by an SDK caller can carry one. Joining an empty
 * reason with a separator reads as text that failed to load, where the ref alone reads as a gap
 * with nothing recorded against it, which is what happened.
 */
export function gapDetail(disclosure: GapDisclosure): string {
  return disclosure.reason.length > 0 ? `${disclosure.ref}: ${disclosure.reason}` : disclosure.ref;
}

/**
 * The fix to print for a finding, or a stated absence.
 *
 * Docs findings carry a syntax-aware fix in their source mapping so the author reads their own
 * markup rather than the DOM. App findings have no mapping and keep `finding.fix`.
 *
 * Recorded decision: when a docs finding has a source mapping whose fix is empty, this falls back
 * to `finding.fix`, which is DOM-phrased. That trades the docs surface's promise of the author's
 * own markup for saying something instead of nothing, and it changes what a docs author reads
 * with no signal that the provenance changed. It is the accepted trade because a blank is worse,
 * and it is written down here so it stays a decision rather than becoming an accident.
 */
export function fixOrAbsence(finding: Finding): string {
  const mapped = finding.docsSource?.fix;
  const fix = mapped !== undefined && mapped.length > 0 ? mapped : finding.fix;
  return fix.length > 0 ? fix : NO_FIX_RECORDED;
}

/**
 * The one barrier a bounded surface names. New and carried findings are what the reader can act
 * on, so they come first; anything else is better than naming nothing.
 */
export function pickBarrier(findings: readonly Finding[]): Finding | null {
  const actionable = findings.find(
    (finding) => finding.status === 'new' || finding.status === 'carried',
  );
  return actionable ?? findings[0] ?? null;
}
