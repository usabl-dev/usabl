/**
 * Positive reachability measurement for one screen.
 *
 * A surface can declare a reachedWhen CSS selector: an element that must be in the rendered DOM once
 * the screen has loaded. This is positive evidence the screen rendered, the opposite of inferring a
 * blank page from what two screens have in common. The measurement is a plain presence test, so a
 * verdict that leans on it cannot depend on how many nodes matched or on DOM iteration order.
 *
 * The result is a tri-state carried on ScreenScan:
 *   null  = no selector was declared, so no claim is made.
 *   true  = the selector matched at least one element.
 *   false = the selector matched nothing, so the screen did not render its proof-of-load element.
 *
 * A malformed selector cannot match anything, so it reads as false rather than crashing the scan.
 * The gap that follows names the selector, which is what the operator needs to fix it.
 */
import type { Page } from '../contracts/index.js';

export async function measureReachability(
  page: Page,
  reachedWhen: string | undefined,
): Promise<boolean | null> {
  if (reachedWhen === undefined) {
    return null;
  }
  try {
    const matches = await page.queryAll(reachedWhen);
    return matches.length > 0;
  } catch {
    return false;
  }
}
