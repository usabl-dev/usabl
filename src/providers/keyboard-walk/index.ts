/**
 * Keyboard walk provider that checks Tab stops for unnamed interactive controls, unknown focus, and keyboard traps.
 * It must never mint a verdict, and it must never guess when the AX node is missing.
 * Missing focus metadata stays unverified so the gate can disclose uncertainty honestly.
 */
import type { AxNode, Draft, Fact, FocusUnreadable, Page, Provider } from '../../contracts/index.js';
import { ROW_READ_KEY, readFocusedRow } from '../row-scope.js';
import { makeStepRunner } from './steps.js';

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
interface WalkedStop {
  path: string;
  key: string | null;
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
// page. The others mean evidence is missing: the budget ran out, or focus moved somewhere the walk
// cannot tell one control from another.
type StopReason =
  | 'complete'
  | 'wall-clock'
  | 'tab-cap'
  | 'focus-trap'
  | 'modal-dialog'
  | 'end-unconfirmed'
  | FocusUnreadable;

const TRUNCATION_WHY: Record<Exclude<StopReason, 'complete'>, (stops: number) => string> = {
  'wall-clock': (stops) =>
    `The keyboard walk ran out of its time budget after ${stops} tab stop(s), before focus reached the end of the page.`,
  'tab-cap': (stops) =>
    `The keyboard walk reached its limit on tab stops after ${stops} tab stop(s), before focus reached the end of the page.`,
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
};

const BUDGET_FIX = 'Raise the keyboard walk budget for this screen, or split the screen so its focus order fits one walk.';
const UNREADABLE_FIX =
  'Check the controls past this point by hand. To let usabl walk them, use an open shadow root, or show the frame in an iframe served from the same origin as the screen.';

const TRUNCATION_FIX: Record<Exclude<StopReason, 'complete'>, string> = {
  'wall-clock': BUDGET_FIX,
  'tab-cap': BUDGET_FIX,
  'closed-shadow-root': UNREADABLE_FIX,
  'frame-unreadable': UNREADABLE_FIX,
  'focus-too-deep': UNREADABLE_FIX,
  'focus-trap': 'Fix the keyboard trap reported on this screen so Tab can reach the rest of the page, then check the screen again.',
  'modal-dialog':
    'Point this screen at a state where no modal dialog is open when the page loads, so the walk covers the page, and check the dialog on a screen of its own.',
  'end-unconfirmed':
    'Find the script on this screen that blurs a control when it gets focus or stops the Tab key, so Tab moves through every control to the end of the page, then check the screen again.',
};

function truncatedWalkDraft(
  screenId: string,
  reason: Exclude<StopReason, 'complete'>,
  stopsWalked: number,
): Draft {
  return {
    rule: 'keyboard-walk-truncated',
    layer: 'walk',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath: '',
    elementName: null,
    role: null,
    whatUserExperiences:
      'Part of the keyboard path through this screen was never walked, so accessibility barriers past that point are unknown.',
    why: TRUNCATION_WHY[reason](stopsWalked),
    fix: TRUNCATION_FIX[reason],
    evidence: {},
    confidence: 'unverified',
  };
}

/**
 * Whether focus on the body is the end of the focus order. In Chromium, Tab after the last control
 * moves focus to the body, and the next Tab goes back to the first control. So one more Tab must land
 * on a stop the walk already reached. Any walked stop counts, not only the first, and a stop counts
 * when the element is the same. A first control that went away during the walk, such as a timed
 * banner, moves every control after it, so the control the Tab lands on has a new path and is still
 * the same element. A list that re-rendered puts a new element at the path of the first stop, so a
 * path match counts too: at any stop when the browser gives no node id, and only at the first stop
 * when it gives one for both elements.
 * A walk that reached no stop has nothing to wrap to, and on a page with nothing to focus the next
 * Tab leaves focus on the body. That walk is left to the body-only detector, which reads the
 * transcript. If the next Tab lands on a control instead, a script dropped focus before the walk
 * reached it.
 */
async function endConfirmed(page: Page, walked: readonly WalkedStop[]): Promise<boolean> {
  await page.tab();
  const confirmed = await landedOnWalkedStop(page, walked);
  // Flows and voice contracts run after the walk on the same page and start from wherever focus
  // is. Before the end was confirmed, the walk left focus on the body, so the next Tab went to the
  // first control. The extra Tab moved focus off the body and may have made a focus handler write
  // into a live region. Both are undone here: what that Tab announced is discarded, and focus goes
  // back to the body, so the next check starts where it always did and hears nothing the walk did.
  await page.drainAnnouncements();
  await page.focusBody();
  return confirmed;
}

async function landedOnWalkedStop(page: Page, walked: readonly WalkedStop[]): Promise<boolean> {
  if (walked.length === 0) {
    return page.activeElementIs('body');
  }
  if ((await page.activeFocusUnreadable()) !== null || (await page.activeElementIs('body'))) {
    return false;
  }
  const path = await page.activePath();
  const key = await page.activeElementKey();
  return walked.some((stop, index) => {
    if (key !== null && stop.key === key) {
      return true;
    }
    // When the browser gives a node id for both, a different id is a different element. A path
    // match then counts only for the first stop walked, where a list that re-rendered puts a new
    // element at the start of the focus order. At any later stop it could be another element that
    // took a walked path while focus fell to the body in the middle of the page.
    const bothKnown = key !== null && stop.key !== null;
    return stop.path === path && (!bothKnown || index === 0);
  });
}

export function makeKeyboardWalkProvider(options: KeyboardWalkProviderOptions = {}): Provider {
  const tabCap = options.tabCap ?? 200;
  const now = options.now ?? (() => Date.now());
  const wallClockMs = options.wallClockMs;
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
    async run(ctx): Promise<Draft[]> {
      await ctx.page.focusBody();

      // The budget is anchored per run, not per provider. One instance walks every screen in a
      // run, and page loads, transcripts, and other providers spend real time between screens.
      // Anchored at construction, that time is already gone when the first walk starts, so the
      // walk returns nothing on every screen while coverage still reads clean.
      const deadline = wallClockMs === undefined ? null : now() + wallClockMs;

      const drafts: Draft[] = [];
      const seenPaths = new Set<string>();
      const walked: WalkedStop[] = [];
      let stopsWalked = 0;
      // Falling out of the loop means the cap ran out, so that is the honest default.
      let stopReason: StopReason = 'tab-cap';

      for (let i = 0; i < tabCap; i += 1) {
        if (deadline !== null && now() >= deadline) {
          stopReason = 'wall-clock';
          break;
        }

        const stops = await stepRunner.run(ctx.page, [{ do: 'tab' }]);
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
          stopReason = (await endConfirmed(ctx.page, walked)) ? 'complete' : 'end-unconfirmed';
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

      // A walk cut short returns the same empty or short list as a clean screen. Saying so as an
      // unverified deterministic finding puts the gate on not_covered instead of a false pass.
      if (stopReason !== 'complete') {
        drafts.push(truncatedWalkDraft(ctx.screen.id, stopReason, stopsWalked));
      }

      return drafts;
    },
  };
}
