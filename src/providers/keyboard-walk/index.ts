/**
 * Keyboard walk provider that checks Tab stops for unnamed interactive controls and unknown focus.
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

// Why the walk stopped. Only 'complete' means the focus order itself ended, by cycling back to a
// path already seen or by handing focus to the body. The others mean evidence is missing: the
// budget ran out, or focus moved somewhere the walk cannot tell one control from another.
type StopReason = 'complete' | 'wall-clock' | 'tab-cap' | FocusUnreadable;

const TRUNCATION_WHY: Record<Exclude<StopReason, 'complete'>, (stops: number) => string> = {
  'wall-clock': (stops) =>
    `The keyboard walk ran out of its time budget after ${stops} tab stop(s), before focus reached the end of the page.`,
  'tab-cap': (stops) =>
    `The keyboard walk reached its limit on tab stops after ${stops} tab stop(s), before focus reached the end of the page.`,
  'closed-shadow-root': (stops) =>
    `After ${stops} tab stop(s), focus moved into a closed shadow root, where the keyboard walk cannot tell one control from another.`,
  'frame-unreadable': (stops) =>
    `After ${stops} tab stop(s), focus moved into a frame from another origin, which the keyboard walk cannot read.`,
  'focus-too-deep': (stops) =>
    `After ${stops} tab stop(s), focus moved under more shadow roots and frames than the keyboard walk follows.`,
};

const BUDGET_FIX = 'Raise the keyboard walk budget for this screen, or split the screen so its focus order fits one walk.';
const UNREADABLE_FIX =
  'Check the controls past this point by hand. To let usabl walk them, use an open shadow root, or serve the frame from the same origin as the screen.';

const TRUNCATION_FIX: Record<Exclude<StopReason, 'complete'>, string> = {
  'wall-clock': BUDGET_FIX,
  'tab-cap': BUDGET_FIX,
  'closed-shadow-root': UNREADABLE_FIX,
  'frame-unreadable': UNREADABLE_FIX,
  'focus-too-deep': UNREADABLE_FIX,
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

export function makeKeyboardWalkProvider(options: KeyboardWalkProviderOptions = {}): Provider {
  const tabCap = options.tabCap ?? 200;
  const now = options.now ?? (() => Date.now());
  const wallClockMs = options.wallClockMs;
  const stepRunner = makeStepRunner();

  return {
    id: 'keyboard-walk',
    layer: 'walk',
    capabilities: ['live'],
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
        if (seenPaths.has(path)) {
          stopReason = 'complete';
          break;
        }
        seenPaths.add(path);

        // Browsers move focus to the document body after the last Tab stop and
        // before cycling to the first control. That ends the walk. It is not an
        // unnamed focusable element.
        if (await ctx.page.activeElementIs('body')) {
          stopReason = 'complete';
          break;
        }

        stopsWalked += 1;

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
