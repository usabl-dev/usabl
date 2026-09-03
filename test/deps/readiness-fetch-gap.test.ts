/**
 * Readiness must return only when the DOM is stable and the network has been quiet at the same
 * moment, both read live.
 *
 * The defect this pins: the DOM can hold still for the whole quiet window while a request is still
 * in flight, or while a request that has not fired yet is about to be. A screen that pauses longer
 * than the quiet window between mounts looked settled, so the scan reported a clean screen it only
 * half saw.
 *
 * The network signal is a live in-flight request count, driven off Playwright request events, not
 * waitForLoadState('networkidle'). That lifecycle event resolves once per navigation and then
 * returns at once on every later call, so it cannot see a request that starts after it first
 * settles. This was checked against real Chromium: a fetch fired 800ms after load, mounting the
 * rest of the page, was missed by networkidle and caught only by a live counter interleaved with
 * the DOM settle. The fake below models that live counter, and test/deps/readiness.real.test.ts
 * asserts the fake and the browser agree.
 *
 * The fake models an in-flight timeline: windows during which a request is outstanding. A request
 * that starts late resets the quiet clock, exactly as a real request does, because the counter only
 * ever reflects requests that have actually begun.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForRendered } from '../../src/deps/real.js';

const TEST_BUDGET_MS = 15_000;
const QUIET_WINDOW_MS = 500;

interface Interval {
  fromMs: number;
  toMs: number;
}

interface MountStep {
  atMs: number;
  elements: number;
}

interface FakePageSpec {
  mounts: MountStep[];
  // Windows during which a request is in flight. Outside every window the network is idle.
  inFlightWindows?: Interval[];
  neverStops?: boolean;
}

interface FakePage {
  networkQuietFor(windowMs: number): boolean;
  // The old seam, modelled the way real Chromium behaves: one-shot per navigation. The first call
  // waits for the network to be idle once, every later call returns at once. Kept on the fake so
  // the pre-fix code runs its real path and returns early, which is the behavioural red, rather
  // than throwing "not a function". The fix drops this from the interface.
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  evaluate(fn: () => number): Promise<number>;
  elements(): number;
  events: string[];
}

// The last time the in-flight count was zero, given the windows and a clock. This is what a live
// counter maintained off request and requestfinished events reports: it moves forward only while
// no request is out, and a late request pushes it forward again.
function lastIdleSince(windows: Interval[], elapsed: number): number {
  let since = 0;
  for (const window of windows) {
    if (window.fromMs > elapsed) {
      break;
    }
    // A request still out means the network is not idle now.
    if (window.toMs > elapsed) {
      return elapsed;
    }
    // A request that finished pushes the idle-since mark to when it finished.
    since = Math.max(since, window.toMs);
  }
  return since;
}

function makeFakePage(spec: FakePageSpec): FakePage {
  const start = Date.now();
  const events: string[] = [];
  const windows = (spec.inFlightWindows ?? []).slice().sort((a, b) => a.fromMs - b.fromMs);

  const elements = (): number => {
    const elapsed = Date.now() - start;
    if (spec.neverStops === true) {
      return elapsed;
    }
    let current = 0;
    for (const step of spec.mounts) {
      if (step.atMs <= elapsed) {
        current = step.elements;
      }
    }
    return current;
  };

  // One-shot per navigation, as Chromium does it. The first call blocks until the network is idle
  // once; later calls return immediately even if a request is out.
  let loadStateSettled = false;

  return {
    events,
    elements,
    networkQuietFor(windowMs: number): boolean {
      events.push('network');
      const elapsed = Date.now() - start;
      return elapsed - lastIdleSince(windows, elapsed) >= windowMs;
    },
    async waitForLoadState(_state: 'networkidle', options: { timeout: number }): Promise<void> {
      events.push('loadstate');
      if (loadStateSettled) {
        return;
      }
      loadStateSettled = true;
      const now = Date.now() - start;
      const idleSince = lastIdleSince(windows, now);
      const waitMs = now - idleSince >= QUIET_WINDOW_MS ? 0 : idleSince + QUIET_WINDOW_MS - now;
      if (waitMs > options.timeout) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.timeout));
        const err = new Error(`page.waitForLoadState: Timeout ${options.timeout}ms exceeded.`);
        err.name = 'TimeoutError';
        throw err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    },
    async evaluate(): Promise<number> {
      events.push('sample');
      return elements();
    },
  };
}

describe('waitForRendered waits for a live-quiet network, not a one-shot event', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not return while the DOM is quiet but a request is still in flight', async () => {
    // The element count is flat at 40 from 0ms, two full quiet windows, so the DOM half settles
    // around 1500ms. A request is in flight until 3000ms and mounts the rest then. Returning before
    // the network goes quiet is the false green.
    const page = makeFakePage({
      mounts: [
        { atMs: 0, elements: 40 },
        { atMs: 3_000, elements: 300 },
      ],
      inFlightWindows: [{ fromMs: 0, toMs: 3_000 }],
    });

    const start = Date.now();
    const outcome = { readyAtMs: -1, elementsWhenReady: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
      outcome.elementsWhenReady = page.elements();
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome.readyAtMs).toBe(-1);

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;

    expect(outcome.elementsWhenReady).toBe(300);
    // Ready only after the request finished at 3000ms plus one quiet window.
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(3_000 + QUIET_WINDOW_MS);
  });

  it('catches a request that starts after the first quiet window, the one networkidle misses', async () => {
    // The exact shape proven against Chromium. The initial load is idle by 500ms, so a one-shot
    // networkidle resolves and never looks again. Then a request fires at 800ms and mounts the rest
    // when it returns at 2800ms. Only a live signal, re-read every interval, sees it.
    const page = makeFakePage({
      mounts: [
        { atMs: 0, elements: 30 },
        { atMs: 2_800, elements: 250 },
      ],
      inFlightWindows: [{ fromMs: 800, toMs: 2_800 }],
    });

    const start = Date.now();
    const outcome = { readyAtMs: -1, elementsWhenReady: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
      outcome.elementsWhenReady = page.elements();
    });

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;

    expect(outcome.elementsWhenReady).toBe(250);
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(2_800 + QUIET_WINDOW_MS);
  });

  it('loops through more than one request when each mount triggers the next', async () => {
    // A request returns, mounts content, and that content fires another request. Readiness has to
    // keep going: settle, see the network busy again, settle again. This proves the loop repeats,
    // rather than checking the network a fixed number of times.
    const page = makeFakePage({
      mounts: [
        { atMs: 0, elements: 60 },
        { atMs: 2_000, elements: 200 },
        { atMs: 4_000, elements: 500 },
      ],
      inFlightWindows: [
        { fromMs: 0, toMs: 2_000 },
        { fromMs: 2_400, toMs: 4_000 },
      ],
    });

    const start = Date.now();
    const outcome = { readyAtMs: -1, elementsWhenReady: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
      outcome.elementsWhenReady = page.elements();
    });

    await vi.advanceTimersByTimeAsync(2_300);
    expect(outcome.readyAtMs).toBe(-1);

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;

    expect(outcome.elementsWhenReady).toBe(500);
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(4_000 + QUIET_WINDOW_MS);
  });

  it('throws the network phase timeout when a request never returns', async () => {
    // A request stays out forever. The run has to end, and it has to name the network, because a
    // stuck request is fixed by raising the budget for the request, not by a slower render.
    const page = makeFakePage({
      mounts: [{ atMs: 0, elements: 80 }],
      inFlightWindows: [{ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }],
    });

    const done = waitForRendered(page, TEST_BUDGET_MS);
    const rejects = expect(done).rejects.toThrow(/network activity did not go quiet within 15000ms/);
    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS + 1_000);
    await rejects;
    await expect(done).rejects.toThrow(/readyTimeoutMs/);
  });

  it('still throws the DOM phase timeout when the page never settles', async () => {
    // The network is idle throughout, so the phase that runs out is the DOM, not the network.
    const page = makeFakePage({ mounts: [], neverStops: true });
    const start = Date.now();
    const outcome = { failedAtMs: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS);
    const rejects = expect(done).rejects.toThrow(/DOM did not stop changing within 15000ms/);
    done.catch(() => {
      outcome.failedAtMs = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS + 2_000);
    await rejects;
    expect(outcome.failedAtMs).toBeGreaterThan(0);
    expect(outcome.failedAtMs).toBeLessThanOrEqual(TEST_BUDGET_MS + 1_000);
  });

  it('pays almost nothing on a page that is quiet and idle from the start', async () => {
    // A page with no in-flight requests settles in one quiet window and pays no extra network wait.
    const page = makeFakePage({ mounts: [{ atMs: 0, elements: 104 }] });
    const start = Date.now();
    const outcome = { readyAtMs: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(0);
    expect(outcome.readyAtMs).toBeLessThanOrEqual(2_000);
  });
});
