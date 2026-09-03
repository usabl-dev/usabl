/**
 * Readiness must wait for the page to stop changing, not only for the network to go quiet.
 * A client-rendered app mounts after the last response settles because render is CPU work, so a
 * network-only wait hands the scan an empty page and every tab stop collapses onto the body.
 * The budget is one number shared by both phases, and the operator owns it, because how long an
 * application takes to render is a property of the application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readyTimeoutMsFor, waitForRendered } from '../../src/deps/real.js';

// A budget these tests pass explicitly, so no test depends on what the default happens to be.
const TEST_BUDGET_MS = 15_000;

// An authenticated Ansible Automation Platform screen measured 12.4 s to network idle plus 13.3 s
// to a DOM that stopped changing. The shipped default has to clear that whole 25.7 s.
const SLOWEST_MEASURED_MS = 25_700;

interface MountStep {
  atMs: number;
  elements: number;
}

interface FakePageSpec {
  mounts?: MountStep[];
  // A single in-flight request that clears at this time. Before it, the network is not quiet; after
  // it plus one quiet window, the network reads idle. This replaces the old networkIdleAfterMs, now
  // that readiness reads a live in-flight signal rather than a one-shot networkidle event.
  requestClearsAtMs?: number;
  networkNeverIdle?: boolean;
  neverStops?: boolean;
  // A page-side failure thrown from evaluate, such as a closed context. Readiness must let it
  // through unchanged rather than swallow it or relabel it as a timeout.
  evaluateError?: Error;
}

interface FakePage {
  networkQuietFor(windowMs: number): boolean;
  evaluate(fn: () => number): Promise<number>;
  elements(): number;
  events: string[];
}

// A page whose element count and network signal both follow the clock, not the number of times they
// are read, so the test describes a page that mounts and fetches on its own timeline.
function makeFakePage(spec: FakePageSpec): FakePage {
  const start = Date.now();
  const mounts = spec.mounts ?? [{ atMs: 0, elements: 0 }];
  const events: string[] = [];
  const elements = (): number => {
    const elapsed = Date.now() - start;
    if (spec.neverStops === true) {
      return elapsed;
    }
    let current = 0;
    for (const step of mounts) {
      if (step.atMs <= elapsed) {
        current = step.elements;
      }
    }
    return current;
  };

  // When the in-flight count was last zero. A network that never idles is never zero, so its quiet
  // window can never be satisfied.
  const idleSince = (elapsed: number): number | null => {
    if (spec.networkNeverIdle === true) {
      return null;
    }
    const clearsAt = spec.requestClearsAtMs ?? 0;
    return elapsed >= clearsAt ? clearsAt : null;
  };

  return {
    events,
    elements,
    networkQuietFor(windowMs: number): boolean {
      events.push('network');
      const elapsed = Date.now() - start;
      const since = idleSince(elapsed);
      return since !== null && elapsed - since >= windowMs;
    },
    async evaluate(): Promise<number> {
      events.push('sample');
      if (spec.evaluateError !== undefined) {
        throw spec.evaluateError;
      }
      return elements();
    },
  };
}

describe('waitForRendered', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not return while a request is still in flight, even on a settled DOM', async () => {
    // The DOM is settled from the start, but a request is in flight until 1500ms. Readiness must
    // hold until the network is also quiet. The old ordering waited on the network before reading
    // the DOM at all; the new loop reads both every pass and gates the return on both.
    const page = makeFakePage({ mounts: [{ atMs: 0, elements: 80 }], requestClearsAtMs: 1_500 });
    const start = Date.now();
    const outcome = { readyAtMs: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(1_400);
    expect(outcome.readyAtMs).toBe(-1);

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;
    // Ready only after the request cleared at 1500ms plus one quiet window.
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(2_000);
  });

  it('stays waiting while the page is still mounting and returns once it holds still', async () => {
    const page = makeFakePage({
      mounts: [
        { atMs: 0, elements: 0 },
        { atMs: 200, elements: 3 },
        { atMs: 1_200, elements: 104 },
      ],
    });
    const start = Date.now();
    const outcome = { readyAtMs: -1, elementsWhenReady: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
      outcome.elementsWhenReady = page.elements();
    });

    // The page has read 3 elements for a full second here and the rest of it has not arrived.
    // Calling that ready is the false green: the scan would report a page of three tab stops.
    await vi.advanceTimersByTimeAsync(1_150);
    expect(outcome.readyAtMs).toBe(-1);

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;
    expect(outcome.elementsWhenReady).toBe(104);
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(1_200);
  });

  it('names the DOM phase when the page never stops changing', async () => {
    const page = makeFakePage({ neverStops: true });
    const start = Date.now();
    const outcome = { failedAtMs: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS);
    const rejects = expect(done).rejects.toThrow(/DOM did not stop changing within 15000ms/);
    done.catch(() => {
      outcome.failedAtMs = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS - 1_000);
    expect(outcome.failedAtMs).toBe(-1);

    await vi.advanceTimersByTimeAsync(2_000);
    await rejects;
    expect(outcome.failedAtMs).toBeGreaterThan(0);
    expect(outcome.failedAtMs).toBeLessThanOrEqual(TEST_BUDGET_MS + 500);
  });

  it('names the network phase when the DOM settled but the network never goes quiet', async () => {
    // The DOM is stable from the start, so the only thing outstanding is the network. The phase
    // named on timeout has to be the network, because a stuck request is fixed by a larger request
    // budget, not by a slower render.
    const page = makeFakePage({ mounts: [{ atMs: 0, elements: 60 }], networkNeverIdle: true });
    const done = waitForRendered(page, TEST_BUDGET_MS);
    const rejects = expect(done).rejects.toThrow(/network activity did not go quiet within 15000ms/);

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS + 500);
    await rejects;
    // The two phases have different fixes, so the message says which one ran out and how to give
    // the run more room.
    await expect(done).rejects.toThrow(/readyTimeoutMs/);
  });

  it('honours the budget it is given rather than an engine constant', async () => {
    const page = makeFakePage({ neverStops: true });
    const start = Date.now();
    const outcome = { failedAtMs: -1 };
    const done = waitForRendered(page, 3_000);
    const rejects = expect(done).rejects.toThrow(/within 3000ms/);
    done.catch(() => {
      outcome.failedAtMs = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(outcome.failedAtMs).toBe(-1);

    await vi.advanceTimersByTimeAsync(1_500);
    await rejects;
    expect(outcome.failedAtMs).toBeLessThanOrEqual(3_500);
  });

  it('returns promptly when the page is already stable', async () => {
    const page = makeFakePage({ mounts: [{ atMs: 0, elements: 104 }] });
    const start = Date.now();
    const outcome = { readyAtMs: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;
    // A settled page pays one quiet window of confirmation, not the readiness budget.
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(0);
    expect(outcome.readyAtMs).toBeLessThanOrEqual(2_000);
  });

  it('treats a page that settles with no content as ready', async () => {
    const page = makeFakePage({ mounts: [{ atMs: 0, elements: 0 }] });
    const start = Date.now();
    const outcome = { readyAtMs: -1 };
    const done = waitForRendered(page, TEST_BUDGET_MS).then(() => {
      outcome.readyAtMs = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(TEST_BUDGET_MS);
    await done;
    // An empty state is a real page. Stability is the test, not how much the page rendered.
    expect(outcome.readyAtMs).toBeGreaterThanOrEqual(0);
    expect(outcome.readyAtMs).toBeLessThanOrEqual(2_000);
  });

  it('passes a page failure out of evaluate through unchanged', async () => {
    // A closed context or a detached frame throws from evaluate, not as a TimeoutError. Readiness
    // must surface that as-is, so the caller can tell a broken page from a slow one. Nothing here
    // catches it, so this pins that it stays uncaught and is not relabelled as a readiness timeout.
    const failure = new Error('Target page, context or browser has been closed');
    const page = makeFakePage({ evaluateError: failure });

    await expect(waitForRendered(page, TEST_BUDGET_MS)).rejects.toBe(failure);
  });
});

describe('readyTimeoutMsFor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the operator budget when the config names one', () => {
    expect(readyTimeoutMsFor({ readyTimeoutMs: 90_000 })).toBe(90_000);
  });

  it('defaults clear of the slowest application we have measured', () => {
    expect(readyTimeoutMsFor({})).toBeGreaterThan(SLOWEST_MEASURED_MS);
  });

  it('keeps the default bounded so a hung screen still fails and discloses', async () => {
    const page = makeFakePage({ neverStops: true });
    const done = waitForRendered(page, readyTimeoutMsFor({}));
    const rejects = expect(done).rejects.toThrow(/did not stop changing/);
    const outcome = { failed: false };
    done.catch(() => {
      outcome.failed = true;
    });

    // Still waiting past the slowest real screen, so a slow application is scanned, not abandoned.
    await vi.advanceTimersByTimeAsync(SLOWEST_MEASURED_MS);
    expect(outcome.failed).toBe(false);

    // Still bounded, so a page that never settles ends as a disclosed gap rather than a hung run.
    await vi.advanceTimersByTimeAsync(120_000);
    await rejects;
    expect(outcome.failed).toBe(true);
  });
});
