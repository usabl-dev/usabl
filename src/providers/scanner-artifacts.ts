/**
 * Waits for content the scanner itself caused to leave the page, before the providers look at it.
 *
 * The defect this closes, seen on a healthy signed-in run of a real application. The keyboard walk
 * focused a control whose PatternFly tooltip opened. `focusBody()` then blurred that control, which
 * starts the tooltip's fade out, and the providers ran while the element was still in the DOM. axe
 * reported a `region` violation on `#pf-tooltip-:r7:`, a node with a generated id, as a NEW barrier
 * on a page nobody had changed. It appeared about one run in five, which is the worst shape a false
 * positive can take: often enough to block a merge, rare enough to look like a real intermittent
 * bug in the application.
 *
 * Content the scanner created is not the page. The walk is usabl's own interaction, so a popup it
 * opened is an artifact of measurement, and reporting it as a barrier is reporting on usabl rather
 * than on the application.
 *
 * What is waited for: an element with `role="tooltip"`, which is the ARIA contract every tooltip
 * implementation is supposed to carry, or a `data-popper-placement` attribute, which Popper sets on
 * whatever it positions and which PatternFly, Material UI, Bootstrap, and Reactstrap all use. That
 * pair covers the common implementations without naming any framework's class names.
 *
 * Why the wait is bounded and why it gives up quietly. A page can legitimately carry a tooltip
 * element at rest: one rendered on load, one pinned open by the application, or a popper-positioned
 * element that is not a tooltip at all. Waiting for such a page to become clear would never finish,
 * and failing the screen over it would discard a real scan for a legitimate DOM. So this waits for
 * the fade out that is actually in progress, which is a few hundred milliseconds, and then proceeds
 * regardless. A page that genuinely carries one pays the budget once and is scanned exactly as it
 * would have been before.
 *
 * This unit reports nothing and decides nothing. It only delays.
 */
import type { Page } from '../contracts/index.js';

/**
 * How long to wait for a fade out to finish. Long enough for the transitions in practice, which
 * run a few hundred milliseconds, and short enough that a page which always carries one of these
 * elements pays a bounded price per screen.
 */
const SETTLE_BUDGET_MS = 1_500;
const SETTLE_POLL_INTERVAL_MS = 100;

/**
 * Elements a scanner interaction can leave behind. Both are contracts rather than implementation
 * details: the role is what ARIA says a tooltip must expose, and the attribute is what Popper
 * writes on anything it positions.
 */
const SCANNER_ARTIFACT_SELECTOR = '[role="tooltip"], [data-popper-placement]';

export interface SettlePorts {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait until no scanner-opened overlay is in the page, or the budget runs out, whichever is first.
 *
 * Returns nothing on purpose. There is no outcome a caller should branch on: a page that cleared
 * and a page that still carries one are both scanned, and the only difference is that the second
 * waited. A count that throws is treated as clear, because a probe that cannot answer must never
 * hold up a scan.
 */
export async function waitForScannerArtifactsToClear(page: Page, ports: SettlePorts = {}): Promise<void> {
  const now = ports.now ?? Date.now;
  const sleep =
    ports.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + SETTLE_BUDGET_MS;

  for (;;) {
    let present: number;
    try {
      present = await page.countEverywhere(SCANNER_ARTIFACT_SELECTOR);
    } catch {
      return;
    }
    if (present === 0) {
      return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return;
    }
    await sleep(Math.min(SETTLE_POLL_INTERVAL_MS, remaining));
  }
}
