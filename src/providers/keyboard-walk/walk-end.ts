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
 * transcript the CLI collects. checkPage has no such detector, so there a blank page is caught only
 * by a readiness signal. If the next Tab lands on a control instead, a script dropped focus before
 * the walk reached it.
 */
export async function walkEndConfirmed(page: Page, walked: readonly WalkStopIdentity[]): Promise<boolean> {
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

async function landedOnWalkedStop(page: Page, walked: readonly WalkStopIdentity[]): Promise<boolean> {
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
