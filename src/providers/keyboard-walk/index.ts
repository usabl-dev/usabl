/**
 * Keyboard walk provider that checks Tab stops for unnamed interactive controls, unknown focus, and keyboard traps.
 * It must never mint a verdict, and it must never guess when the AX node is missing.
 * Missing focus metadata stays unverified so the gate can disclose uncertainty honestly.
 */
import type {
  AxNode,
  CoverageGap,
  Draft,
  Fact,
  FocusUnreadable,
  Page,
  Provider,
  ProviderOutput,
  TranscriptStop,
} from '../../contracts/index.js';
import { ROW_READ_KEY, readFocusedRow } from '../row-scope.js';
import { makeStepRunner } from './steps.js';
import { readWalkEnd, type WalkEnd, type WalkStopIdentity } from './walk-end.js';
import { walkScreenConfig } from '../../intake/keyboard-walk-config.js';

// The most Tab stops a walk takes when neither the screen's settings nor the caller name a cap.
const DEFAULT_TAB_CAP = 200;

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'checkbox',
  'radio',
  'textbox',
  'combobox',
  'tab',
  'switch',
  'option',
]);

export interface KeyboardWalkProviderOptions {
  tabCap?: number;
  wallClockMs?: number;
  now?: () => number;
}

function isUnnamedInteractive(node: AxNode): boolean {
  if (node.role === null) {
    return false;
  }
  return INTERACTIVE_ROLES.has(node.role) && !node.name;
}

function roleFact(role: string | null): { role?: Fact } {
  if (typeof role !== 'string') {
    return {};
  }
  return {
    role: {
      value: role,
      source: 'ax-tree',
      fromTree: true,
    },
  };
}

function tabStopPath(path: string, index: number): string {
  return path === '' ? `tab-stop-${index}` : path;
}

/**
 * The draft with the row of the element the walk has focused, read now, while the walk is at it.
 * A stop's path is a placeholder when it cannot be computed, and as a selector it names nothing.
 * Read later through the path, the row would be lost, or would be the row of whatever element the
 * path names by then.
 */
async function withFocusedRow(page: Page, draft: Draft): Promise<Draft> {
  const row = await readFocusedRow(page);
  return { ...draft, evidence: { ...draft.evidence, extra: { ...draft.evidence.extra, [ROW_READ_KEY]: row } } };
}

function unconfirmedFocusDraft(screenId: string, elementPath: string): Draft {
  return {
    rule: 'keyboard-walk-unconfirmed-focus',
    layer: 'walk',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath,
    elementName: null,
    role: null,
    whatUserExperiences:
      'A focusable element exists but its accessible role and name cannot be determined.',
    why: 'Keyboard users reach this element but AT cannot announce what it is.',
    fix: 'Give the element a semantic HTML role or an explicit ARIA role, plus an accessible name.',
    evidence: {},
    confidence: 'unverified',
  };
}

function unnamedInteractiveDraft(screenId: string, elementPath: string, node: AxNode): Draft {
  return {
    rule: 'keyboard-walk-unnamed-interactive',
    layer: 'walk',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath,
    elementName: null,
    role: node.role,
    whatUserExperiences:
      'An interactive element has no accessible name; screen-reader users hear only the role.',
    why: `A ${node.role} reached via Tab has no accessible name in the AX tree.`,
    fix: 'Add aria-label or visible text to the element.',
    evidence: roleFact(node.role),
    confidence: 'fail',
  };
}

/**
 * A keyboard trap: Tab took focus around a cycle of stops and never reached the body, so a keyboard
 * user cannot leave the group and the controls after it are out of reach. The evidence is the path
 * of each stop of the cycle, in Tab order, and no page text. The path of the first stop names the
 * draft, and it is the stop that has focus when the draft is made.
 */
function keyboardTrapDraft(screenId: string, cycle: readonly string[]): Draft {
  return {
    rule: 'keyboard-walk-trap',
    layer: 'walk',
    severity: 'critical',
    evidenceClass: 'deterministic',
    screenId,
    elementPath: cycle[0] ?? '',
    elementName: null,
    role: null,
    whatUserExperiences:
      'Keyboard focus is trapped in a group of controls. A keyboard user who presses Tab cannot leave the group and cannot reach the rest of the page.',
    why: `Tab moved focus around a cycle of ${cycle.length} control(s) and never reached the end of the page. This fails WCAG 2.1.2 No Keyboard Trap.`,
    fix: 'Let Tab and Shift+Tab move focus out of this group to the controls before and after it. Keep focus inside a group only while it is an open modal dialog: a dialog element opened with showModal(), or an element with role dialog or alertdialog and aria-modal true.',
    evidence: { extra: { cycle: [...cycle] } },
    confidence: 'fail',
  };
}

// One stop of the walk: its path, the page's key for its element, and the paths of the open modal
// dialogs that hold it.
interface WalkedStop extends WalkStopIdentity {
  modals: readonly string[];
}

// Whether one open modal dialog holds every stop of a cycle. A modal dialog may keep focus inside
// itself, so such a cycle is read as expected, not as a keyboard trap. Only the stops of the cycle
// are judged, never the stops walked before it.
function cycleInsideOneModal(cycle: readonly WalkedStop[]): boolean {
  const [first, ...rest] = cycle;
  if (first === undefined) {
    return false;
  }
  return first.modals.some((modal) => rest.every((stop) => stop.modals.includes(modal)));
}

// Why the walk stopped. Only 'complete' means the focus order itself ended, by handing focus to the
// body after the last control, and one more Tab confirmed it. 'focus-trap' and 'modal-dialog' mean
// focus went back to a stop it had already reached without passing through the body, so the walk
// never reached the rest of the page. 'end-unconfirmed' means focus reached the body, but one more
// Tab did not go back to the start of the focus order, so a script dropped focus in the middle of the
// page. 'body-focused' means a script put focus on the body itself, or the page could not say
// whether it did, so the walk cannot tell where the focus order ends. The others mean evidence is
// missing: the budget ran out, or focus moved somewhere the walk cannot tell one control from
// another.
type StopReason =
  | 'complete'
  | 'wall-clock'
  | 'tab-cap'
  | 'focus-trap'
  | 'modal-dialog'
  | 'end-unconfirmed'
  | 'body-focused'
  | FocusUnreadable;

const STOP_REASON_OF_END: Record<WalkEnd, StopReason> = {
  confirmed: 'complete',
  unconfirmed: 'end-unconfirmed',
  'body-focused': 'body-focused',
};

// The budget one walk ran with, so a gap can name the limit it hit.
interface WalkBudget {
  tabCap: number;
  wallClockMs: number | undefined;
}

const TRUNCATION_WHY: Record<Exclude<StopReason, 'complete'>, (stops: number, budget: WalkBudget) => string> = {
  'wall-clock': (stops, budget) =>
    `The keyboard walk ran out of its time budget of ${budget.wallClockMs ?? 0} ms after ${stops} tab stop(s), before focus reached the end of the page.`,
  'tab-cap': (stops, budget) =>
    `The keyboard walk reached its limit of ${budget.tabCap} tab stops after ${stops} tab stop(s), before focus reached the end of the page.`,
  'closed-shadow-root': (stops) =>
    `After ${stops} tab stop(s), focus moved into a closed shadow root, where the keyboard walk cannot tell one control from another.`,
  'frame-unreadable': (stops) =>
    `After ${stops} tab stop(s), focus moved into a frame the keyboard walk cannot read, such as a frame from another origin or the frame of an object, embed, or fencedframe element.`,
  'focus-too-deep': (stops) =>
    `After ${stops} tab stop(s), focus moved under more shadow roots and frames than the keyboard walk follows.`,
  'focus-trap': (stops) =>
    `After ${stops} tab stop(s), focus went back to a control the keyboard walk had already reached, without reaching the end of the page, so the controls after the trap were never walked.`,
  'modal-dialog': (stops) =>
    `After ${stops} tab stop(s), focus went back to a control it had already reached, and every control in that cycle is inside one open modal dialog. Focus stayed inside the dialog, and the rest of the page was not walked.`,
  'end-unconfirmed': (stops) =>
    `After ${stops} tab stop(s), focus moved to the document body, but one more Tab did not go back to a control the keyboard walk had already reached. A script may have moved focus away from a control or stopped the Tab key, so the controls after that point may never have been walked.`,
  'body-focused': (stops) =>
    `After ${stops} tab stop(s), a script moved focus to the document body itself, so the next Tab starts again from the top of the page and the keyboard walk cannot tell where the focus order ends. The controls after that point may never have been walked.`,
};

// The way to raise a budget, for each kind of user: the setting in usabl.config.json for the CLI,
// the stop hook, the overlay, and CI, and the checkPage option for a Playwright test. The screen
// id comes from the operator's config or routes, never from the page.
function budgetFix(screenId: string, setting: 'tabCap' | 'wallClockMs'): string {
  return (
    `To raise it, set keyboardWalk.perSurface.${screenId}.${setting} in usabl.config.json, or in a Playwright test pass ` +
    `the ${setting} option of checkPage. Or split the screen so its focus order fits one walk.`
  );
}
const UNREADABLE_FIX =
  'Check the controls past this point by hand. To let usabl walk them, use an open shadow root, or show the frame in an iframe served from the same origin as the screen.';

const TRUNCATION_FIX: Record<Exclude<StopReason, 'complete'>, (screenId: string) => string> = {
  'wall-clock': (screenId) => budgetFix(screenId, 'wallClockMs'),
  'tab-cap': (screenId) => budgetFix(screenId, 'tabCap'),
  'closed-shadow-root': () => UNREADABLE_FIX,
  'frame-unreadable': () => UNREADABLE_FIX,
  'focus-too-deep': () => UNREADABLE_FIX,
  'focus-trap': () => 'Fix the keyboard trap reported on this screen so Tab can reach the rest of the page, then check the screen again.',
  'modal-dialog': () =>
    'Point this screen at a state where no modal dialog is open when the page loads, so the walk covers the page, and check the dialog on a screen of its own.',
  'end-unconfirmed': () =>
    'Find the script on this screen that blurs a control when it gets focus or stops the Tab key, so Tab moves through every control to the end of the page, then check the screen again.',
  'body-focused': () =>
    'Find the script on this screen that moves focus to the document body, so Tab moves through every control to the end of the page, then check the screen again.',
};

/**
 * The coverage gap for a walk that was cut short. A gap, never a draft: a draft could be accepted
 * onto the evidence floor and carried, and then every later run read verified while the controls
 * past the cut were never walked. A gap keeps the screen not covered until the walk completes.
 * Every reason the walk can stop short of the end gives this same gap. The ref is the screen's
 * url, as for other gaps about one screen. The reason holds counts and engine words, never page
 * text.
 */
function truncatedWalkGap(
  screen: { id: string; url: string },
  reason: Exclude<StopReason, 'complete'>,
  stopsWalked: number,
  budget: WalkBudget,
): CoverageGap {
  return {
    ref: screen.url,
    state: 'not-covered',
    reason:
      `${cutShortLead(screen)} ${TRUNCATION_WHY[reason](stopsWalked, budget)} Accessibility barriers past that point are unknown. ` +
      TRUNCATION_FIX[reason](screen.id),
  };
}

function cutShortLead(screen: { id: string }): string {
  return `on screen ${screen.id}, the keyboard walk was cut short, so this screen is not covered.`;
}

/**
 * Whether a gap is the one this walk gives a screen when it was cut short. For measurement only,
 * such as the sensitivity runner, which reads a defect the walk caught as caught even though the
 * same defect cut the walk short. Nothing that decides a verdict reads it.
 */
export function isCutShortWalkGap(gap: CoverageGap, screen: { id: string; url: string }): boolean {
  return gap.state === 'not-covered' && gap.ref === screen.url && gap.reason.startsWith(cutShortLead(screen));
}

export function makeKeyboardWalkProvider(options: KeyboardWalkProviderOptions = {}): Provider {
  const now = options.now ?? (() => Date.now());
  const stepRunner = makeStepRunner();

  return {
    id: 'keyboard-walk',
    layer: 'walk',
    capabilities: ['live'],
    // The walk runs on every screen it is given.
    appliesBeforeScan: () => ({ applies: true }),
    // This walk traverses the real focus order, which only describes what a keyboard user meets
    // when it starts from the page as loaded. An opened or dismissed widget rewrites that order.
    requiresPristinePage: true,
    async run(ctx): Promise<ProviderOutput> {
      // The budget of this screen: its own settings in the config the run was given, and the
      // engine defaults for whatever they leave out. Under a trusted ref that config is the trusted
      // one, so a pull request cannot set its own.
      const own = walkScreenConfig(ctx.config, ctx.screen.id);
      const budget: WalkBudget = {
        tabCap: own?.tabCap ?? options.tabCap ?? DEFAULT_TAB_CAP,
        wallClockMs: own?.wallClockMs ?? options.wallClockMs,
      };
      const { tabCap, wallClockMs } = budget;
      await ctx.page.focusBody();

      // The budget is anchored per run, not per provider. One instance walks every screen in a
      // run, and page loads, transcripts, and other providers spend real time between screens.
      // Anchored at construction, that time is already gone when the first walk starts, so the
      // walk returns nothing on every screen while coverage still reads clean.
      const deadline = wallClockMs === undefined ? null : now() + wallClockMs;

      const drafts: Draft[] = [];
      const seenPaths = new Set<string>();
      const walked: WalkedStop[] = [];
      // Every stop Tab reached, the body stop included, for checkPage's blank-page check only.
      const transcript: TranscriptStop[] = [];
      let stopsWalked = 0;
      // Falling out of the loop means the cap ran out, so that is the honest default.
      let stopReason: StopReason = 'tab-cap';

      for (let i = 0; i < tabCap; i += 1) {
        if (deadline !== null && now() >= deadline) {
          stopReason = 'wall-clock';
          break;
        }

        const stops = await stepRunner.run(ctx.page, [{ do: 'tab' }]);
        for (const stop of stops) {
          transcript.push({ ...stop, index: i });
        }
        // Inside a closed shadow root or a frame the walk cannot read, every control has the path
        // of the host or the frame, so a repeated path proves nothing. The walk ends there and says
        // so, rather than read the second control as a completed cycle.
        const unreadable = await ctx.page.activeFocusUnreadable();
        if (unreadable !== null) {
          stopReason = unreadable;
          break;
        }
        const path = tabStopPath(stops[0]?.elementPath ?? '', i);
        // A stop seen before is a cycle. The body check runs after this one in the same iteration,
        // and an iteration that finds focus on the body ends the walk, so the body is never in
        // seenPaths and a cycle here never passed through it: Tab can no longer reach the rest of
        // the page. Inside one open modal dialog that is read as expected. Anywhere else it is a
        // keyboard trap. Either way the rest of the page was never walked, so the walk ends with a
        // gap, never as complete.
        if (seenPaths.has(path)) {
          const cycle = walked.slice(walked.findIndex((stop) => stop.path === path));
          if (cycleInsideOneModal(cycle)) {
            stopReason = 'modal-dialog';
          } else {
            stopReason = 'focus-trap';
            drafts.push(await withFocusedRow(ctx.page, keyboardTrapDraft(ctx.screen.id, cycle.map((stop) => stop.path))));
          }
          break;
        }
        seenPaths.add(path);

        // Browsers move focus to the document body after the last Tab stop and
        // before cycling to the first control. That ends the walk. It is not an
        // unnamed focusable element. A script that blurs a control, or stops Tab and drops focus,
        // also leaves focus on the body, in the middle of the page, so one more Tab confirms it.
        if (await ctx.page.activeElementIs('body')) {
          stopReason = STOP_REASON_OF_END[await readWalkEnd(ctx.page, walked)];
          break;
        }

        stopsWalked += 1;
        walked.push({ path, key: await ctx.page.activeElementKey(), modals: await ctx.page.activeModalDialogs() });

        const node = await ctx.page.activeNode();
        if (node === null) {
          drafts.push(await withFocusedRow(ctx.page, unconfirmedFocusDraft(ctx.screen.id, path)));
          continue;
        }

        if (isUnnamedInteractive(node)) {
          drafts.push(await withFocusedRow(ctx.page, unnamedInteractiveDraft(ctx.screen.id, path, node)));
        }
      }

      // A walk cut short returns the same empty or short list as a clean screen. Saying so as a
      // coverage gap on the screen puts the gate on not_covered instead of a false pass, and a gap
      // is never floored or carried.
      const gaps = stopReason === 'complete' ? [] : [truncatedWalkGap(ctx.screen, stopReason, stopsWalked, budget)];

      // The record is measurement for checkPage's blank-page check. It is not a draft and decides
      // nothing here. A walk that was cut short says so, and that check then does not read it.
      return { drafts, gaps, walk: { stops: transcript, complete: stopReason === 'complete' } };
    },
  };
}
