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
  ProviderNote,
  ProviderOutput,
  TranscriptStop,
  UnreadableRegionListing,
  UnreadRegionName,
} from '../../contracts/index.js';
import { STALE_REGION_LISTING_NOTE_REF, UNREAD_REGION_NOTE_REF } from '../../output/notes.js';
import { scrubString } from '../../surfaces/scrub.js';
import { ROW_READ_KEY, readFocusedRow } from '../row-scope.js';
import { makeStepRunner } from './steps.js';
import { readWalkEnd, REGION_TAB_BOUND, type WalkEnd, type WalkStopIdentity } from './walk-end.js';
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
  // Set by checkPage for a page it was given with no screenId. It reads no config for that page,
  // so the gap text names only the checkPage options, never a setting under the id `page`.
  unlabeledPage?: boolean;
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
// whether it did, so the walk cannot tell where the focus order ends. 'region-unbounded' means focus
// went into a region the walk cannot read and did not come back out within REGION_TAB_BOUND presses
// of Tab. 'region-reentered' means focus went back into a region it had walked past, which the walk
// cannot tell apart from a trap or from content slotted into the region. The others mean the budget
// ran out.
type StopReason =
  | 'complete'
  | 'wall-clock'
  | 'tab-cap'
  | 'focus-trap'
  | 'modal-dialog'
  | 'end-unconfirmed'
  | 'body-focused'
  | 'region-unbounded'
  | 'region-reentered';

// A region the walk cannot read into: a closed shadow root, a frame it cannot read, or focus under
// more shadow roots and frames than it follows. Every control inside has the path of the host or
// the frame, so the walk counts the region as one stop and walks on once focus comes back out.
interface UnreadRegion {
  path: string;
  kind: FocusUnreadable;
  // The tab stop, counted from 1, at which focus first went into the region.
  stop: number;
  // What the page says the region is, or null when it could not say. Page-derived.
  name: UnreadRegionName | null;
}

// The longest page-derived name a message repeats, so a long one cannot bury the sentence.
const NAME_LIMIT = 100;

function pageText(text: string): string {
  const scrubbed = scrubString(text);
  const characters = [...scrubbed];
  return characters.length <= NAME_LIMIT ? scrubbed : `${characters.slice(0, NAME_LIMIT).join('')} (cut)`;
}

// A region as a reader can find it on the page, from what the page says it is. Page-derived, so
// scrubbed and bounded.
function regionWords(region: UnreadRegion): string {
  const name = region.name;
  if (name?.kind === 'frame') {
    return name.origin === null ? 'a frame with no address usabl can name' : `a frame from ${pageText(name.origin)}`;
  }
  if (name?.kind === 'shadow-host') {
    return `a closed shadow root in a ${pageText(name.tag)} element`;
  }
  return REGION_KIND[region.kind];
}

// The listing line that would accept this region, or null when the region has no name a listing
// can use. The line is written in the form the config parser takes.
function listingLine(name: UnreadRegionName | null): string | null {
  if (name?.kind === 'frame' && name.origin !== null) return `{"frameOrigin": "${pageText(name.origin)}"}`;
  if (name?.kind === 'shadow-host') return `{"shadowHost": "${pageText(name.tag)}"}`;
  return null;
}

function listingText(listing: UnreadableRegionListing): string {
  return 'frameOrigin' in listing ? `{"frameOrigin": "${listing.frameOrigin}"}` : `{"shadowHost": "${listing.shadowHost}"}`;
}

// Whether a listing names the region the walk met. Exact comparison of the one name each form
// carries, so a listing never matches a region it does not name.
function listingMatches(listing: UnreadableRegionListing, name: UnreadRegionName | null): boolean {
  if ('frameOrigin' in listing) return name?.kind === 'frame' && name.origin === listing.frameOrigin;
  return name?.kind === 'shadow-host' && name.tag === listing.shadowHost;
}

const REGION_KIND: Record<FocusUnreadable, string> = {
  'closed-shadow-root': 'a closed shadow root, where the keyboard walk cannot tell one control from another',
  'frame-unreadable':
    'a frame the keyboard walk cannot read, such as a frame from another origin or the frame of an object, embed, or fencedframe element',
  'focus-too-deep': 'focus under more shadow roots and frames than the keyboard walk follows',
};

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
  'region-unbounded': (stops) =>
    `After ${stops} tab stop(s), the keyboard walk pressed Tab ${REGION_TAB_BOUND} times inside a region it cannot read, and focus did not come back out. A keyboard user may be trapped there, and the controls after it were never walked.`,
  'region-reentered': (stops) =>
    `After ${stops} tab stop(s), focus went back into a region the keyboard walk cannot read, after it had left that region. Content slotted into a closed shadow root between its own controls does this, and so can a keyboard trap. The walk cannot tell which, so the controls after that point may never have been walked.`,
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
// id comes from the operator's config or routes, never from the page. A page checkPage was given
// with no screenId reads no config, so only the checkPage option is named for it.
function budgetFix(screenId: string, setting: 'tabCap' | 'wallClockMs', unlabeledPage: boolean): string {
  const how = unlabeledPage
    ? `To raise it, pass the ${setting} option of checkPage.`
    : `To raise it, set keyboardWalk.perSurface.${screenId}.${setting} in usabl.config.json, or in a Playwright test pass ` +
      `the ${setting} option of checkPage.`;
  return `${how} Or split the screen so its focus order fits one walk.`;
}
const UNREADABLE_FIX =
  'Check the controls inside this region by hand. To let usabl walk them, use an open shadow root, or show the frame in an iframe served from the same origin as the screen.';

const TRUNCATION_FIX: Record<Exclude<StopReason, 'complete'>, (screenId: string, unlabeledPage: boolean) => string> = {
  'wall-clock': (screenId, unlabeledPage) => budgetFix(screenId, 'wallClockMs', unlabeledPage),
  'tab-cap': (screenId, unlabeledPage) => budgetFix(screenId, 'tabCap', unlabeledPage),
  'region-unbounded': () =>
    'Check by hand whether Tab can leave this region. To let usabl walk it, use an open shadow root, or show the frame in an iframe served from the same origin as the screen.',
  'region-reentered': () =>
    'Check by hand where Tab goes inside this region and after it. To let usabl walk it, use an open shadow root, or show the frame in an iframe served from the same origin as the screen.',
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
  unlabeledPage: boolean,
): CoverageGap {
  return {
    ref: screen.url,
    state: 'not-covered',
    reason:
      `${cutShortLead(screen)} ${TRUNCATION_WHY[reason](stopsWalked, budget)} Accessibility barriers past that point are unknown. ` +
      TRUNCATION_FIX[reason](screen.id, unlabeledPage),
  };
}

function cutShortLead(screen: { id: string }): string {
  return `on screen ${screen.id}, the keyboard walk was cut short, so this screen is not covered.`;
}

/**
 * The coverage gap for one region the walk walked past and could not read into. The walk went on
 * to the controls after it, but the controls inside it were not checked, so the screen is not
 * covered. The reason holds the kind of region and the stop it was met at, never page text.
 */
function unreadRegionGap(screen: { id: string; url: string }, region: UnreadRegion, unlabeledPage: boolean): CoverageGap {
  const line = listingLine(region.name);
  // A region with a name a listing can use can be accepted, by a person, in the guarded config. A
  // page checkPage was given with no screenId reads no config, so a listing cannot reach it.
  const accept =
    line === null
      ? ' usabl cannot name this region, so it cannot be listed as a known limit.'
      : unlabeledPage
        ? ' This page was checked with no screen id, so no listing applies to it. To list this region as a known ' +
          "limit, pass the page's screen id as the screenId option of checkPage."
        : ` If the team accepts that this region is not checked, list ${line} under ` +
          `keyboardWalk.perSurface.${screen.id}.unreadableRegions in usabl.config.json. That file is guarded, so a ` +
          'reviewer approves the line, and the region is then shown as a known limit on every result.';
  return {
    ref: screen.url,
    state: 'not-covered',
    reason:
      `${unreadRegionLead(screen)} ${region.stop}: ` +
      `${regionWords(region)}. The walk went on past it, but the controls inside it were not checked, so this ` +
      `screen is not covered. ${UNREADABLE_FIX}${accept}`,
  };
}

function unreadRegionLead(screen: { id: string }): string {
  return `on screen ${screen.id}, the keyboard walk could not read inside a region at tab stop`;
}

// The note for a region the team listed: a disclosed limit. Not a gap, so it does not hold the
// screen at not covered, and it says plainly that the region was not checked.
function listedRegionNote(screen: { id: string }, region: UnreadRegion): ProviderNote {
  return {
    ref: UNREAD_REGION_NOTE_REF,
    reason:
      `on screen ${screen.id}, the keyboard walk could not read inside ${regionWords(region)} at tab stop ${region.stop}, ` +
      `so this region was not checked. usabl.config.json lists it as a known limit for this screen under ` +
      `keyboardWalk.perSurface.${screen.id}.unreadableRegions, so it does not block. Check the controls inside it by hand.`,
  };
}

// The note for a listing that matched no region on a walk that reached the end of the page, so a
// stale line is seen and can be removed.
function staleListingNote(screen: { id: string }, listing: UnreadableRegionListing): ProviderNote {
  return {
    ref: STALE_REGION_LISTING_NOTE_REF,
    reason:
      `on screen ${screen.id}, the listing ${listingText(listing)} under keyboardWalk.perSurface.${screen.id}.unreadableRegions ` +
      'in usabl.config.json matched no region the keyboard walk met. The region may be gone, or named another way now. ' +
      'Remove the line or correct it.',
  };
}

/**
 * Whether a gap is the one this walk gives a screen when it was cut short. For measurement only,
 * such as the sensitivity runner, which reads a defect the walk caught as caught even though the
 * same defect cut the walk short. Nothing that decides a verdict reads it.
 */
export function isCutShortWalkGap(gap: CoverageGap, screen: { id: string; url: string }): boolean {
  return gap.state === 'not-covered' && gap.ref === screen.url && gap.reason.startsWith(cutShortLead(screen));
}

/**
 * Whether a gap is one this walk gives a screen about how far it walked: the cut short gap or an
 * unread region gap. checkPage reads it to drop those gaps, with the drafts, when the page left
 * its screen while the checks ran, because they then describe another page. The page stays not
 * covered by its landing gap, so dropping them never makes it read as checked.
 */
export function isWalkReachGap(gap: CoverageGap, screen: { id: string; url: string }): boolean {
  return (
    gap.state === 'not-covered' &&
    gap.ref === screen.url &&
    (gap.reason.startsWith(cutShortLead(screen)) || gap.reason.startsWith(unreadRegionLead(screen)))
  );
}

export function makeKeyboardWalkProvider(options: KeyboardWalkProviderOptions = {}): Provider {
  const now = options.now ?? (() => Date.now());
  const unlabeledPage = options.unlabeledPage === true;
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
      // Every region the walk could not read into, in the order it met them.
      const regions: UnreadRegion[] = [];
      // The region focus is in now, and how many presses of Tab have kept it there.
      let inRegion: { path: string; tabs: number } | null = null;

      for (let i = 0; i < tabCap; i += 1) {
        if (deadline !== null && now() >= deadline) {
          stopReason = 'wall-clock';
          break;
        }

        const stops = await stepRunner.run(ctx.page, [{ do: 'tab' }]);
        for (const stop of stops) {
          transcript.push({ ...stop, index: i });
        }
        const path = tabStopPath(stops[0]?.elementPath ?? '', i);
        // Inside a closed shadow root or a frame the walk cannot read, every control has the path
        // of the host or the frame, so a repeated path there proves nothing. While focus stays in
        // the same region, the walk presses Tab again until focus is back in content it can read,
        // up to a bound, and then walks the controls after it.
        const unreadable = await ctx.page.activeFocusUnreadable();
        if (unreadable !== null && inRegion !== null && inRegion.path === path) {
          inRegion.tabs += 1;
          if (inRegion.tabs >= REGION_TAB_BOUND) {
            stopReason = 'region-unbounded';
            break;
          }
          continue;
        }
        inRegion = unreadable === null ? null : { path, tabs: 1 };
        // A stop seen before is a cycle. The body check runs after this one in the same iteration,
        // and an iteration that finds focus on the body ends the walk, so the body is never in
        // seenPaths and a cycle here never passed through it: Tab can no longer reach the rest of
        // the page. Inside one open modal dialog that is read as expected. Anywhere else it is a
        // keyboard trap. Either way the rest of the page was never walked, so the walk ends with a
        // gap, never as complete.
        if (seenPaths.has(path)) {
          // Every control inside a region the walk cannot read has the region's path, so meeting
          // that path again is not evidence of a trap. Content slotted into a closed shadow root
          // between its own controls reads this way with no trap at all. The walk cannot tell, so
          // it is cut short and claims nothing.
          if (walked.some((stop) => stop.unreadable === true && stop.path === path)) {
            stopReason = 'region-reentered';
            break;
          }
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

        // A region is one stop the walk could not read: no name, role, or draft can be read there,
        // and a check must not read their absence as an accessibility barrier.
        if (unreadable !== null) {
          stopsWalked += 1;
          regions.push({ path, kind: unreadable, stop: stopsWalked, name: await ctx.page.activeUnreadRegion() });
          walked.push({ path, key: null, unreadable: true, modals: await ctx.page.activeModalDialogs() });
          continue;
        }

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
      // Each region the walk walked past is a gap of its own, because the controls inside it were
      // not checked, even when the walk reached the end of the page. A region the team lists for
      // this screen in the config is a disclosed limit instead: a note, which is never a gap and
      // never reads as checked. Under a trusted ref the listing comes from the trusted config.
      const listings = own?.unreadableRegions ?? [];
      const matched = new Set<number>();
      const gaps: CoverageGap[] = [];
      const notes: ProviderNote[] = [];
      for (const region of regions) {
        const index = listings.findIndex((listing) => listingMatches(listing, region.name));
        if (index === -1) {
          gaps.push(unreadRegionGap(ctx.screen, region, unlabeledPage));
        } else {
          matched.add(index);
          notes.push(listedRegionNote(ctx.screen, region));
        }
      }
      if (stopReason !== 'complete') {
        gaps.push(truncatedWalkGap(ctx.screen, stopReason, stopsWalked, budget, unlabeledPage));
      } else {
        // Only a walk that reached the end of the page saw every region, so only then is a listing
        // that matched nothing known to be stale.
        listings.forEach((listing, index) => {
          if (!matched.has(index)) notes.push(staleListingNote(ctx.screen, listing));
        });
      }

      // The record is measurement for checkPage's blank-page check. It is not a draft and decides
      // nothing here. A walk that was cut short says so, and that check then does not read it.
      return {
        drafts,
        gaps,
        ...(notes.length === 0 ? {} : { notes }),
        walk: { stops: transcript, complete: stopReason === 'complete' },
      };
    },
  };
}
