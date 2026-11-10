/**
 * The silent change rule: an action step that changes the page, is not announced, and does not
 * move focus to a named control. It needs no contract. It runs inside the loops that already drive
 * steps, the flow provider's loop and the contract step runner, and only reads around each step
 * those loops drive: it never drives a step itself, adds none, and makes no network call.
 *
 * Its findings are preview, so they never decide a verdict. A step it cannot judge is an
 * unverified gap that names the reason, never a finding and never a pass. Every string it shows
 * goes through the scrubber here, and it never shows a value or the name of a removed node.
 */
import type {
  ActionSettle,
  AnnouncementSourcesDrain,
  AxTreeNode,
  AxTreeRead,
  Draft,
  FocusUnreadable,
  Page,
  Step,
} from '../contracts/index.js';
import { AX_TREE_NODE_BUDGET, AX_TREE_TIME_BUDGET_MS } from '../deps/ax-tree.js';
import { firstLine } from '../primitives/first-line.js';
import { scrubOutboundData } from '../surfaces/scrub.js';
import { compareAxTrees, isNoChange, type TreeChange } from './tree-change.js';

export const SILENT_CHANGE_RULE = 'voicing/silent-change';

/** The most added names a finding shows. */
export const ADDED_NAMES_SHOWN = 3;

/** Why a step was not judged. Each is a gap, never a finding and never a pass. */
export type SilentChangeGap =
  | 'navigated'
  | 'not settled'
  | 'still busy'
  | 'tree over budget'
  | 'unreadable control'
  | 'focus unreadable'
  | 'replaced focus'
  | 'announcements undecidable'
  | 'background announcements'
  | 'step not run'
  | 'step threw'
  | 'read failed';

/** An action step: Enter on the focused control, or a click. Tab, type, and key presses are not. */
export function isActionStep(step: Step): boolean {
  return step.do === 'activate' || step.do === 'click';
}

/** Everything the rule read around one action step. */
export interface ActionStepObservation {
  step: Step;
  // The control that received the action, by backend node id, or null when it could not be read.
  acted: number | null;
  focusBefore: number | null;
  focusUnreadableBefore: FocusUnreadable | null;
  focusAfter: number | null;
  focusUnreadableAfter: FocusUnreadable | null;
  urlBefore: string;
  urlAfter: string;
  before: AxTreeRead;
  after: AxTreeRead;
  // Null when the wait for the page to react failed.
  settle: ActionSettle | null;
  // Null when the drain failed.
  drain: AnnouncementSourcesDrain | null;
  // The first read that failed, or null.
  readError: string | null;
}

/** What the rule says about one action step. */
export type StepJudgment =
  | { kind: 'quiet' }
  | { kind: 'finding'; change: TreeChange }
  | { kind: 'gap'; reason: SilentChangeGap };

// The address without its query and fragment. A change there is the URL path changing.
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function perceivedIn(read: AxTreeRead, nodeId: number | null): AxTreeNode | undefined {
  if (read.kind !== 'tree' || nodeId === null) return undefined;
  const found = read.nodes.find((entry) => entry.nodeId === nodeId);
  return found === undefined || found.ignored ? undefined : found;
}

function trimmedName(node: AxTreeNode | undefined): string {
  return node?.name?.trim() ?? '';
}

const UNNAMED_ROLES: ReadonlySet<string> = new Set(['generic', 'none']);

/** The regions that wrote outside any step window, from the drain before the first step. */
export interface BackgroundRegions {
  regions: ReadonlySet<number>;
  // The drain before the first step held text whose region is unknown, so any region may be one.
  unknown: boolean;
}

/**
 * Judges one action step. Pure: the reads in, a judgment out. The order is the rule's: a read
 * that cannot be trusted is a gap before anything is compared, a step that changed nothing is
 * quiet, and only a step that changed the page, was not heard, and moved focus nowhere named is a
 * finding.
 */
export function judgeActionStep(observation: ActionStepObservation, background: BackgroundRegions): StepJudgment {
  const gap = (reason: SilentChangeGap): StepJudgment => ({ kind: 'gap', reason });
  const { before, after, drain } = observation;
  if (observation.readError !== null || drain === null) return gap('read failed');
  if (pathOf(observation.urlBefore) !== pathOf(observation.urlAfter)) return gap('navigated');
  if (before.kind === 'tree' && after.kind === 'tree' && before.documentNodeId !== after.documentNodeId) return gap('navigated');
  if (observation.settle === null || !observation.settle.settled) return gap('not settled');
  if (before.kind !== 'tree' || after.kind !== 'tree') return gap('tree over budget');
  if (after.nodes.some((entry) => !entry.ignored && entry.busy)) return gap('still busy');

  // A step that changed nothing has nothing to say, whichever control it acted on.
  if (isNoChange(compareAxTrees(before.nodes, after.nodes, null))) return { kind: 'quiet' };
  const acted = observation.acted;
  if (acted === null) {
    return gap(observation.step.do === 'activate' && observation.focusUnreadableBefore !== null ? 'focus unreadable' : 'unreadable control');
  }
  const change = compareAxTrees(before.nodes, after.nodes, acted);
  if (isNoChange(change)) return { kind: 'quiet' };

  // Did focus move to a named control. Identity is the backend node id. Focus on the control that
  // received the action is never a move: a mouse click focuses it before the click fires.
  const { focusAfter, focusBefore } = observation;
  // The focus read follows same-origin child frames, and the tree read covers only the main frame.
  // Focus on a node that is not the acted control and is not in the tree after the step, such as a
  // control in a child frame, cannot be judged: it is never a move and never a finding.
  const focusOutsideTree = focusAfter !== null && focusAfter !== acted && after.nodes.every((entry) => entry.nodeId !== focusAfter);
  const focusKnown = observation.focusUnreadableAfter === null && !focusOutsideTree;
  const landed = perceivedIn(after, focusAfter);
  const landedName = trimmedName(landed);
  const elsewhere = focusAfter !== null && focusAfter !== focusBefore && focusAfter !== acted;
  // A new node with the name of the control, or of what had focus, may be the same control drawn
  // again. The read cannot tell a re-render from a move.
  const replaced =
    elsewhere &&
    landedName.length > 0 &&
    (landedName === trimmedName(perceivedIn(before, focusBefore)) || landedName === trimmedName(perceivedIn(before, acted)));
  const moved = elsewhere && !replaced && landed !== undefined && landedName.length > 0 && landed.role !== null && !UNNAMED_ROLES.has(landed.role);
  // A name change on the acted control while it keeps focus is the control speaking for itself.
  const renamed = focusAfter === acted && landedName.length > 0 && landedName !== trimmedName(perceivedIn(before, acted));
  if (focusKnown && (moved || renamed)) return { kind: 'quiet' };

  // Was anything heard. A record that holds only a removal is never heard, and speech from a
  // region that also wrote outside any step window may not come from this step.
  const sources = drain.sources;
  const speechUnknown = drain.undecidable !== null || (sources === null && drain.texts.length > 0);
  let heard = false;
  let backgroundSpeech = false;
  if (!speechUnknown && sources !== null) {
    for (const source of sources) {
      if (source.removalOnly) continue;
      if (background.unknown || background.regions.has(source.region)) {
        backgroundSpeech = true;
      } else {
        heard = true;
      }
    }
  }
  if (heard) return { kind: 'quiet' };

  // An undecidable drain is named first. When the flow requirement reports the same drain as its
  // own gap, that gap already covers this step, and the rule's gap is dropped as a repeat.
  if (drain.undecidable !== null) return gap('announcements undecidable');
  if (!focusKnown) return gap('focus unreadable');
  if (replaced) return gap('replaced focus');
  if (speechUnknown) return gap('announcements undecidable');
  if (backgroundSpeech) return gap('background announcements');
  return { kind: 'finding', change };
}

// ---- drafts ----

function describeStep(step: Step): string {
  return typeof step.selector === 'string' ? `${step.do} ${step.selector}` : step.do;
}

function stepEvidence(step: Step): Record<string, string> {
  return typeof step.selector === 'string' ? { do: step.do, selector: step.selector } : { do: step.do };
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

const MANUAL_CHECK = 'Check this step by hand with a screen reader.';

const GAP_TEXT: Record<SilentChangeGap, { why: string; fix: string }> = {
  navigated: {
    why: 'the page navigated, or its address path changed, during the step, so the two tree reads describe different pages',
    fix: MANUAL_CHECK,
  },
  'not settled': {
    why: 'the page was still changing at the end of the settle window, so the read after the step may be early',
    fix: `${MANUAL_CHECK} A page that stops changing soon after the action can be judged.`,
  },
  'still busy': {
    why: 'a node was still marked aria-busy at the end of the window, so the update may not be done',
    fix: 'Set aria-busy back to false when the update is done.',
  },
  'tree over budget': {
    why: `a read of the accessibility tree needed more than ${AX_TREE_TIME_BUDGET_MS} ms or ${AX_TREE_NODE_BUDGET} nodes`,
    fix: MANUAL_CHECK,
  },
  'unreadable control': {
    why: 'the control the step acts on could not be resolved to one element in the document or in an open shadow root, or its selector has a combinator on a page with an open shadow root, where the click can match across the shadow boundary',
    fix: 'Name the control with a CSS selector that matches one element, in the document or in one open shadow root. On a page with an open shadow root, use a selector with no combinator, such as an id.',
  },
  'focus unreadable': {
    why: 'the element that has focus could not be read, such as one inside a closed shadow root, a frame from another origin, or a child frame the tree read does not cover',
    fix: MANUAL_CHECK,
  },
  'replaced focus': {
    why: 'focus ended on a new node with the same name as the control, so a re-render cannot be told from a move',
    fix: MANUAL_CHECK,
  },
  'announcements undecidable': {
    why: 'the live-region record cannot say which announcements a screen reader spoke',
    fix: MANUAL_CHECK,
  },
  'background announcements': {
    why: 'the only announcements in the window came from a live region that also wrote outside any step, so they may not come from this step',
    fix: MANUAL_CHECK,
  },
  'step not run': {
    why: 'the flow does not run this step, so nothing was judged for it',
    fix: 'Write the step as one the flow runs: tab, activate, press with a key, or click with a selector.',
  },
  'step threw': {
    why: 'the step failed, so it and the steps after it were not judged',
    fix: 'Fix the step so it runs on this screen, then run the check again.',
  },
  'read failed': {
    why: 'a read the check needs failed',
    fix: MANUAL_CHECK,
  },
};

interface DraftPlace {
  screenId: string;
  index: number;
  step: Step;
  elementPath: string;
  role: string | null;
}

function findingDraft(place: DraftPlace, change: TreeChange): Draft {
  const counts = `${total(change.added)} added, ${total(change.removed)} removed, ${total(change.changed)} changed`;
  return {
    rule: SILENT_CHANGE_RULE,
    layer: 'voicing',
    severity: 'serious',
    evidenceClass: 'preview',
    screenId: place.screenId,
    elementPath: place.elementPath,
    elementName: null,
    role: place.role,
    whatUserExperiences: `After step ${place.index} (${describeStep(place.step)}), the page changed, but a screen reader user hears nothing: no live region announced it, and focus did not move to a named control.`,
    why: `The step changed the accessibility tree outside the control's own state (nodes: ${counts}), and nothing in the step's window told assistive technology about it.`,
    fix: 'Announce the outcome in a live region that is shown and inside the open modal, or move focus to a control whose name states it.',
    evidence: {
      extra: {
        step: stepEvidence(place.step),
        added: change.added,
        removed: change.removed,
        changed: change.changed,
        addedNames: change.addedNames.slice(0, ADDED_NAMES_SHOWN),
      },
    },
    confidence: 'fail',
  };
}

function gapDraft(place: DraftPlace, reason: SilentChangeGap, detail: string | null): Draft {
  const text = GAP_TEXT[reason];
  return {
    rule: SILENT_CHANGE_RULE,
    layer: 'voicing',
    severity: 'serious',
    evidenceClass: 'preview',
    screenId: place.screenId,
    elementPath: place.elementPath,
    elementName: null,
    role: place.role,
    whatUserExperiences: `Whether a screen reader user hears what step ${place.index} (${describeStep(place.step)}) changed is unknown.`,
    why: `usabl could not judge the step: ${text.why}${detail === null ? '' : ` (${detail})`}.`,
    fix: text.fix,
    evidence: { extra: { step: stepEvidence(place.step), reason } },
    confidence: 'unverified',
  };
}

// ---- the watch the step loops call ----

/** How one step's window ended, as the loop that drove it saw it. */
export interface StepWindow {
  // Null when the wait failed or the loop does not wait.
  settle: ActionSettle | null;
  // Null when the drain failed.
  drain: AnnouncementSourcesDrain | null;
}

/**
 * The hooks a step loop calls. Every hook reads only, and none throws: a read that fails becomes
 * a gap on its step, so the loop's own behaviour does not change.
 */
export interface StepObserver {
  // The drain the loop takes before its first step, or null when it failed.
  start(drain: AnnouncementSourcesDrain | null): void;
  before(page: Page, step: Step, index: number): Promise<void>;
  after(page: Page, step: Step, index: number, window: StepWindow): Promise<void>;
  threw(step: Step, index: number, error: unknown): void;
}

export interface SilentChangeWatch extends StepObserver {
  // The loop drove nothing for this step, because it does not run its kind.
  notRun(step: Step, index: number): void;
  // Emit nothing for this step: the requirement's own draft already says whether it was heard.
  quiet(index: number): void;
  // Drop the rule's gap with this reason on this step: the requirement's own gap already says it.
  dropGap(index: number, reason: SilentChangeGap): void;
  // The drafts for every step judged so far, in step order, scrubbed.
  drafts(screenId: string): Draft[];
}

interface Pending {
  acted: number | null;
  focusBefore: number | null;
  focusUnreadableBefore: FocusUnreadable | null;
  urlBefore: string;
  before: AxTreeRead;
  elementPath: string;
  role: string | null;
  readError: string | null;
}

type Outcome = { index: number; step: Step; elementPath: string; role: string | null } & (
  | { judgment: StepJudgment }
  | { judgment: { kind: 'gap'; reason: SilentChangeGap }; detail: string | null }
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EMPTY_TREE: AxTreeRead = { kind: 'tree', documentNodeId: null, nodes: [] };

/** A new watch for one run of one step loop. */
export function makeSilentChangeWatch(): SilentChangeWatch {
  let background: BackgroundRegions = { regions: new Set(), unknown: false };
  const pending = new Map<number, Pending>();
  const outcomes: Outcome[] = [];
  const quieted = new Set<number>();
  const droppedGaps = new Map<number, SilentChangeGap>();

  // Runs one read. A read that throws records the first failure and gives the fallback.
  async function read<T>(state: { readError: string | null }, fallback: T, reader: () => Promise<T>): Promise<T> {
    try {
      return await reader();
    } catch (error) {
      state.readError ??= errorText(error);
      return fallback;
    }
  }

  return {
    start(drain) {
      if (drain === null) {
        background = { regions: new Set(), unknown: true };
        return;
      }
      const regions = new Set<number>();
      let unknown = false;
      if (drain.sources === null) {
        unknown = drain.texts.length > 0;
      } else {
        for (const source of drain.sources) {
          // A removal is not a write: a toast that dismissed itself earlier is not a ticker.
          if (!source.removalOnly) regions.add(source.region);
        }
      }
      background = { regions, unknown };
    },

    async before(page, step, index) {
      if (!isActionStep(step)) return;
      const state: Pending = {
        acted: null,
        focusBefore: null,
        focusUnreadableBefore: null,
        urlBefore: '',
        before: EMPTY_TREE,
        elementPath: typeof step.selector === 'string' ? step.selector : `step-${index}`,
        role: null,
        readError: null,
      };
      state.urlBefore = await read(state, '', () => page.currentUrl());
      if (step.do === 'click' && typeof step.selector === 'string') {
        const selector = step.selector;
        state.acted = await read(state, null, () => page.controlNodeId(selector));
      }
      state.focusUnreadableBefore = await read(state, null, () => page.activeFocusUnreadable());
      state.focusBefore = await read(state, null, () => page.focusedNodeId());
      if (step.do === 'activate') {
        state.acted = state.focusUnreadableBefore === null ? state.focusBefore : null;
        state.elementPath = await read(state, state.elementPath, () => page.activePath());
      }
      state.before = await read(state, EMPTY_TREE, () => page.fullAxTree());
      state.role = perceivedIn(state.before, state.acted)?.role ?? null;
      pending.set(index, state);
    },

    async after(page, step, index, window) {
      const state = pending.get(index);
      if (state === undefined || !isActionStep(step)) return;
      pending.delete(index);
      const urlAfter = await read(state, '', () => page.currentUrl());
      const after = await read(state, EMPTY_TREE, () => page.fullAxTree());
      const focusAfter = await read(state, null, () => page.focusedNodeId());
      const focusUnreadableAfter = await read(state, null, () => page.activeFocusUnreadable());
      const judgment = judgeActionStep(
        {
          step,
          acted: state.acted,
          focusBefore: state.focusBefore,
          focusUnreadableBefore: state.focusUnreadableBefore,
          focusAfter,
          focusUnreadableAfter,
          urlBefore: state.urlBefore,
          urlAfter,
          before: state.before,
          after,
          settle: window.settle,
          drain: window.drain,
          readError: state.readError,
        },
        background,
      );
      if (judgment.kind === 'gap' && judgment.reason === 'read failed') {
        // Only the first line of the error, as for a step that threw: its later lines can quote the
        // element's markup.
        const detail = state.readError === null ? 'the drain failed' : firstLine(state.readError) || null;
        outcomes.push({ index, step, elementPath: state.elementPath, role: state.role, judgment, detail });
        return;
      }
      outcomes.push({ index, step, elementPath: state.elementPath, role: state.role, judgment });
    },

    threw(step, index, error) {
      const state = pending.get(index);
      pending.delete(index);
      outcomes.push({
        index,
        step,
        elementPath: state?.elementPath ?? (typeof step.selector === 'string' ? step.selector : `step-${index}`),
        role: state?.role ?? null,
        judgment: { kind: 'gap', reason: 'step threw' },
        detail: firstLine(errorText(error)) || null,
      });
    },

    notRun(step, index) {
      outcomes.push({
        index,
        step,
        elementPath: typeof step.selector === 'string' ? step.selector : `step-${index}`,
        role: null,
        judgment: { kind: 'gap', reason: 'step not run' },
        detail: null,
      });
    },

    quiet(index) {
      quieted.add(index);
    },

    dropGap(index, reason) {
      droppedGaps.set(index, reason);
    },

    drafts(screenId) {
      const drafts: Draft[] = [];
      for (const outcome of outcomes) {
        if (quieted.has(outcome.index) || outcome.judgment.kind === 'quiet') continue;
        if (outcome.judgment.kind === 'gap' && droppedGaps.get(outcome.index) === outcome.judgment.reason) continue;
        const place: DraftPlace = { screenId, index: outcome.index, step: outcome.step, elementPath: outcome.elementPath, role: outcome.role };
        const draft =
          outcome.judgment.kind === 'finding'
            ? findingDraft(place, outcome.judgment.change)
            : gapDraft(place, outcome.judgment.reason, 'detail' in outcome ? outcome.detail : null);
        // Page text and error messages leave through the scrubber, here in the provider.
        drafts.push(scrubOutboundData(draft));
      }
      return drafts;
    },
  };
}
