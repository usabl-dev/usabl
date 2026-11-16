/**
 * The end rule every Tab walk uses: the keyboard walk, and the focus order check on design
 * requirements. A walk that ends early reads like a short page, so a walk is complete only when this
 * rule confirms its end.
 */
import type { Page } from '../../contracts/index.js';

// What the end rule needs to know about one stop a walk reached: its path, and the page's key for
// its element, or null when the browser could not give one.
export interface WalkStopIdentity {
  path: string;
  key: string | null;
  // Set when the stop was a region the walk cannot read into, such as a closed shadow root or a
  // frame from another origin. Its path is the path of the host or the frame.
  unreadable?: true;
}

// The most presses of Tab a walk spends inside one region it cannot read before it stops. A region
// whose own controls trap focus would otherwise hold the walk until the stop cap, and the walk
// cannot see a cycle in there, because every control has the path of the host or the frame. The
// end rule uses the same bound when it presses Tab out of a first region.
export const REGION_TAB_BOUND = 100;

// How a walk that reached the body ended. 'confirmed': the focus order ended there. 'unconfirmed':
// one more Tab did not go back to a stop the walk reached, so a script dropped focus mid-page.
// 'body-focused': a script put focus on the body itself, or the page could not say whether it did,
// so the end cannot be told. 'out-of-time': the walk's time budget ran out while the end rule pressed
// Tab out of a first region, so the end was not read. Only 'confirmed' makes a walk complete.
export type WalkEnd = 'confirmed' | 'unconfirmed' | 'body-focused' | 'out-of-time';

// Whether the walk's time budget has run out, read through the walk's own injected clock. A walk
// with no time budget passes nothing, and the end rule then never runs out.
export type OutOfTime = () => boolean;

/**
 * Whether focus on the body is the end of the focus order. In Chromium, Tab after the last control
 * leaves no element with focus, so document.activeElement reads as the body, and the next Tab goes
 * back to the first control. So the body must not hold focus itself, and one more Tab must land
 * on a stop the walk already reached. Any walked stop counts, not only the first, and a stop counts
 * when the element is the same. A first control that went away during the walk, such as a timed
 * banner, moves every control after it, so the control the Tab lands on has a new path and is still
 * the same element. A list that re-rendered puts a new element at the path of the first stop, so a
 * path match counts too: at any stop when the browser gives no node id, and only at the first stop
 * when it gives one for both elements.
 * A walk that reached no stop has nothing to wrap to, and on a page with nothing to focus the next
 * Tab leaves focus on the body. That walk is left to the body-only detector, which reads the
 * transcript the CLI collects, and in checkPage the stops the keyboard walk returns. If the next Tab
 * lands on a control instead, a script dropped focus before the walk reached it.
 */
export async function readWalkEnd(
  page: Page,
  walked: readonly WalkStopIdentity[],
  outOfTime: OutOfTime = () => false,
): Promise<WalkEnd> {
  // At the end of the focus order no element has focus, and document.activeElement only falls back
  // to the body. A script that calls focus() on a body with a tabindex puts focus on the body
  // itself, in the middle of the page, and the next Tab from there starts again at the first
  // control, so one more Tab would confirm an end that is not there. That case is told apart first,
  // and a read that fails is read the same way, because the end cannot then be told.
  let bodyFocused: boolean;
  try {
    bodyFocused = await page.bodyHoldsFocus();
  } catch {
    bodyFocused = true;
  }
  let end: WalkEnd = 'body-focused';
  if (!bodyFocused) {
    await page.tab();
    end = await landedOnWalkedStop(page, walked, outOfTime);
  }
  // Flows and voice contracts run after the walk on the same page and start from wherever focus
  // is. Before the end was confirmed, the walk left focus on the body, so the next Tab went to the
  // first control. The extra Tab moved focus off the body and may have made a focus handler write
  // into a live region. Both are undone here: what that Tab announced is discarded, and focus goes
  // back to the body, so the next check starts where it always did and hears nothing the walk did.
  await page.drainAnnouncements();
  await page.focusBody();
  return end;
}

async function landedOnWalkedStop(page: Page, walked: readonly WalkStopIdentity[], outOfTime: OutOfTime): Promise<WalkEnd> {
  const confirmedIf = (landed: boolean): WalkEnd => (landed ? 'confirmed' : 'unconfirmed');
  if (walked.length === 0) {
    return confirmedIf(await page.activeElementIs('body'));
  }
  // A region the walk cannot read gives every control inside it the path of its host or frame, so
  // landing in a walked region proves nothing by itself: a control inside it that blurs itself
  // drops focus to the body mid-page, and the next Tab goes to the next control of the same region.
  if ((await page.activeFocusUnreadable()) !== null) {
    return backAtFirstRegion(page, walked, outOfTime);
  }
  if (await page.activeElementIs('body')) {
    return 'unconfirmed';
  }
  const path = await page.activePath();
  const key = await page.activeElementKey();
  const landed = walked.some((stop, index) => {
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
  return confirmedIf(landed);
}

/**
 * Focus is in a region the walk cannot read, on the Tab after the body. That is the start of the
 * focus order again only when the first stop walked is this region, and Tab out of it, pressed at
 * most REGION_TAB_BOUND times, lands on the second stop walked, or on the body when the region was
 * the only stop. Anything else leaves the end unconfirmed. Those presses spend the walk's time
 * budget like any other, so the budget is read before each one, and a walk that runs out there
 * ends out of time.
 */
async function backAtFirstRegion(page: Page, walked: readonly WalkStopIdentity[], outOfTime: OutOfTime): Promise<WalkEnd> {
  const regionPath = await page.activePath();
  const [first, second] = walked;
  if (first?.unreadable !== true || first.path !== regionPath) {
    return 'unconfirmed';
  }
  for (let presses = 0; presses < REGION_TAB_BOUND; presses += 1) {
    if (outOfTime()) {
      return 'out-of-time';
    }
    await page.tab();
    const unreadable = (await page.activeFocusUnreadable()) !== null;
    const path = await page.activePath();
    if (unreadable && path === regionPath) {
      continue;
    }
    return (await onSecondStop(page, second, unreadable, path)) ? 'confirmed' : 'unconfirmed';
  }
  return 'unconfirmed';
}

// Whether focus, just out of a first region, is where the walk went after that region: the second
// stop walked, or the body when the region was the only stop.
async function onSecondStop(page: Page, second: WalkStopIdentity | undefined, unreadable: boolean, path: string): Promise<boolean> {
  if (second === undefined) {
    return !unreadable && (await page.activeElementIs('body'));
  }
  if (unreadable || second.unreadable === true) {
    // A second region is matched by its path, the only thing the walk can read of it.
    return unreadable && second.unreadable === true && second.path === path;
  }
  if (await page.activeElementIs('body')) {
    return false;
  }
  const key = await page.activeElementKey();
  return key !== null && second.key !== null ? second.key === key : second.path === path;
}
