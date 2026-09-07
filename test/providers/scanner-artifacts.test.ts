/**
 * Content the scanner itself caused is not the page.
 *
 * The defect this locks, seen on a healthy signed-in run of a real application. The keyboard walk
 * focused a control whose PatternFly tooltip opened. `focusBody()` blurred it, which starts the
 * fade out, and the providers ran while the element was still in the DOM. axe reported a `region`
 * violation on `#pf-tooltip-:r7:` as a NEW barrier on a page nobody had changed, about one run in
 * five: often enough to block a merge, rare enough to read as a real intermittent bug.
 *
 * The wait is bounded and gives up quietly, because a page can legitimately carry a tooltip or a
 * popper-positioned element at rest and waiting for such a page would never finish.
 */
import { describe, expect, it } from 'vitest';
import type { Page } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { waitForScannerArtifactsToClear } from '../../src/providers/scanner-artifacts.js';

/** A clock and a sleep that move time on demand, so no test waits in real seconds. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
  let current = 1_000;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    elapsed: () => current - 1_000,
  };
}

function pageCounting(counts: number[]): { page: Page; calls: () => number; selectors: string[] } {
  const selectors: string[] = [];
  let index = 0;
  const page = makeFakePage({
    countEverywhere: async (selector: string) => {
      selectors.push(selector);
      const value = counts[index] ?? counts.at(-1) ?? 0;
      index += 1;
      return value;
    },
  });
  return { page, calls: () => index, selectors };
}

describe('waiting for scanner-opened overlays to clear', () => {
  it('returns at once when nothing is open', async () => {
    const clock = fakeClock();
    const { page, calls } = pageCounting([0]);

    await waitForScannerArtifactsToClear(page, clock);

    expect(calls()).toBe(1);
    expect(clock.elapsed()).toBe(0);
  });

  it('waits for a fade out and returns as soon as it is gone', async () => {
    // The real shape: the element is still there for a few hundred milliseconds after the blur.
    const clock = fakeClock();
    const { page, calls } = pageCounting([1, 1, 1, 0]);

    await waitForScannerArtifactsToClear(page, clock);

    expect(calls()).toBe(4);
    expect(clock.elapsed()).toBe(300);
  });

  it('gives up on its budget and proceeds when the element never goes', async () => {
    // A page can legitimately carry a tooltip at rest, or a popper-positioned element that is not
    // a tooltip. Waiting forever would hang the scan and failing would discard a real page, so it
    // pays the budget once and proceeds.
    const clock = fakeClock();
    const { page } = pageCounting([1]);

    await waitForScannerArtifactsToClear(page, clock);

    expect(clock.elapsed()).toBe(1_500);
  });

  it('asks for the ARIA role and the popper attribute, and names no framework', async () => {
    const { page, selectors } = pageCounting([0]);

    await waitForScannerArtifactsToClear(page, fakeClock());

    expect(selectors[0]).toContain('[role="tooltip"]');
    expect(selectors[0]).toContain('[data-popper-placement]');
    expect(selectors[0]?.toLowerCase()).not.toContain('pf-');
  });

  it('treats a probe that throws as clear, so it never holds up a scan', async () => {
    const broken = makeFakePage({
      countEverywhere: async () => {
        throw new Error('page is gone');
      },
    });
    const clock = fakeClock();

    await waitForScannerArtifactsToClear(broken, clock);

    expect(clock.elapsed()).toBe(0);
  });
});
