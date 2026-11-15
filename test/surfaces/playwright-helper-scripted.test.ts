/**
 * checkPage on a scripted page. The page adoption is replaced with a fake page, and the provider
 * list is cut to the keyboard walk, so only the walk and checkPage's own reads decide the result. The real-browser cases are in playwright-page-check.integration.test.ts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page as PwPage } from 'playwright';
import type { Page, ScreenScan } from '../../src/contracts/index.js';
import { markUnseenScreens } from '../../src/coverage/unseen.js';
import { makeFakePage } from '../../src/deps/fakes.js';

const adopted = vi.hoisted((): { page: Page | null } => ({ page: null }));

vi.mock('../../src/deps/real.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/deps/real.js')>();
  return {
    ...actual,
    adoptPage: async () => {
      if (adopted.page === null) {
        throw new Error('the test did not script a page');
      }
      return adopted.page;
    },
  };
});

vi.mock('../../src/providers/core-stack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/core-stack.js')>();
  return {
    ...actual,
    makeScanProviders: (...args: Parameters<typeof actual.makeScanProviders>) =>
      actual.makeScanProviders(...args).filter((provider) => provider.id === 'keyboard-walk'),
  };
});

const { checkPage } = await import('../../src/surfaces/playwright-helper.js');

const PAGE_URL = 'http://127.0.0.1:5173/clusters';
const BODY_PATH = '#app';

// A page whose focus order is the given paths, then the body, then the first path again, as
// Chromium moves focus. focusBody puts focus back before the first path. An empty list is a page
// with nothing to Tab to: every Tab leaves focus on the body.
function scriptedPage(paths: string[], overrides: Partial<Page> = {}): Page {
  let cursor = -1;
  const at = (): string | null => {
    if (cursor < 0 || paths.length === 0) {
      return null;
    }
    const index = cursor % (paths.length + 1);
    return index === paths.length ? null : (paths[index] ?? null);
  };
  return makeFakePage({
    currentUrl: async () => PAGE_URL,
    focusBody: async () => {
      cursor = -1;
    },
    tab: async () => {
      cursor += 1;
    },
    activePath: async () => at() ?? BODY_PATH,
    activeElementIs: async (selector) => selector === 'body' && at() === null,
    activeNode: async () => (at() === null ? null : { name: 'Save', role: 'button', states: {} }),
    ...overrides,
  });
}

function pwPage(): PwPage {
  return { url: () => PAGE_URL } as unknown as PwPage;
}

const dirs: string[] = [];

async function project(reachedWhen?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usabl-checkpage-unseen-'));
  dirs.push(dir);
  const config = {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [{ id: 'clusters', url: PAGE_URL, files: ['src/clusters.tsx'], ...(reachedWhen === undefined ? {} : { reachedWhen }) }],
    guardedPaths: [],
  };
  await writeFile(join(dir, 'usabl.config.json'), JSON.stringify(config, null, 2));
  return dir;
}

afterEach(async () => {
  adopted.page = null;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// The CLI's gap for a scan whose every stop had focus on the body, from the CLI's own function.
function cliBlankPageReason(): string {
  const scan: ScreenScan = {
    screenId: 'page',
    url: 'readiness:page',
    stops: [{ index: 0, elementPath: BODY_PATH, announcement: [], onBody: true }],
    drafts: [],
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
  };
  return markUnseenScreens([scan]).screens[0]?.gaps[0]?.reason ?? '';
}

describe('checkPage on a page with nothing rendered', () => {
  it('is not covered, with the gap the CLI gives a blank page, when no readiness signal is declared', async () => {
    adopted.page = scriptedPage([]);

    const result = await checkPage(pwPage(), { projectRoot: await project(), tabCap: 10 });

    expect(result.verdict).toBe('not_covered');
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toEqual([{ ref: 'readiness:page', state: 'not-covered', reason: cliBlankPageReason() }]);
    expect(result.gaps[0]?.reason).toContain('Every keyboard stop stayed on the document body');
  });

  it('checks a page with one control as before', async () => {
    adopted.page = scriptedPage(['#save']);

    const result = await checkPage(pwPage(), { projectRoot: await project(), tabCap: 10 });

    expect(result.gaps).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('makes no blank-page claim from a walk that was cut short, and the cut-short walk keeps the page not covered', async () => {
    // The first Tab leaves focus on the body, and the next one lands on a control the walk never
    // reached, so the walk cannot say where the focus order ends.
    let cursor = -1;
    adopted.page = scriptedPage([], {
      focusBody: async () => {
        cursor = -1;
      },
      tab: async () => {
        cursor += 1;
      },
      activePath: async () => (cursor === 0 ? BODY_PATH : '#late'),
      activeElementIs: async (selector) => selector === 'body' && cursor === 0,
    });

    const result = await checkPage(pwPage(), { projectRoot: await project(), tabCap: 10 });

    expect(result.verdict).toBe('not_covered');
    // The one gap is the walk's own, never the blank-page gap, and the walk makes no draft.
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.reason).toContain('the keyboard walk was cut short');
    expect(result.gaps[0]?.ref).not.toMatch(/^readiness:/);
    expect(result.needsReview).toEqual([]);
  });

  it('makes no blank-page claim when the keyboard walk is turned off, so the page reads as its other checks found it', async () => {
    adopted.page = scriptedPage([]);

    const result = await checkPage(pwPage(), { projectRoot: await project(), keyboardWalk: false });

    expect(result.gaps).toEqual([]);
    expect(result.drafts).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('checks a page with nothing to Tab to that shows content, with no readiness signal, as on main', async () => {
    adopted.page = scriptedPage([], { pageShowsContent: async () => true });

    const result = await checkPage(pwPage(), { projectRoot: await project(), tabCap: 10 });

    expect(result.gaps).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('checks a labeled page with nothing to Tab to that shows content when its readiness selector holds', async () => {
    adopted.page = scriptedPage([], {
      queryAll: async (selector) => (selector === 'main article' ? [{ selector: 'main article' }] : []),
      pageShowsContent: async () => true,
    });

    const result = await checkPage(pwPage(), { screenId: 'clusters', projectRoot: await project('main article'), tabCap: 10 });

    expect(result.gaps).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('still gaps a page that shows content when its declared readiness selector does not hold, as on main', async () => {
    adopted.page = scriptedPage([], { pageShowsContent: async () => true });

    const result = await checkPage(pwPage(), { screenId: 'clusters', projectRoot: await project('#orders'), tabCap: 10 });

    expect(result.verdict).toBe('not_covered');
    expect(result.gaps.map((gap) => gap.ref)).toEqual(['readiness:clusters']);
    expect(result.gaps[0]?.reason).toContain('#orders');
  });

  it('is not covered, with the CLI gap for a blank page, when the selector names its empty mount point and held', async () => {
    adopted.page = scriptedPage([], {
      queryAll: async (selector) => (selector === '#app' ? [{ selector: '#app' }] : []),
      pageShowsContent: async () => false,
    });

    const result = await checkPage(pwPage(), { screenId: 'clusters', projectRoot: await project('#app'), tabCap: 10 });

    expect(result.verdict).toBe('not_covered');
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toEqual([{ ref: 'readiness:clusters', state: 'not-covered', reason: cliBlankPageReason() }]);
  });

  it('reads a content read that fails as no content, so a blank page stays not covered', async () => {
    adopted.page = scriptedPage([], {
      pageShowsContent: async () => {
        throw new Error('the browser could not read what the page shows');
      },
    });

    const result = await checkPage(pwPage(), { projectRoot: await project(), tabCap: 10 });

    expect(result.verdict).toBe('not_covered');
    expect(result.gaps.map((gap) => gap.ref)).toEqual(['readiness:page']);
  });

  it('does not read what the page shows when the walk reached a control', async () => {
    const read = vi.fn(async () => false);
    adopted.page = scriptedPage(['#save'], { pageShowsContent: read });

    const result = await checkPage(pwPage(), { projectRoot: await project(), tabCap: 10 });

    expect(read).not.toHaveBeenCalled();
    expect(result.verdict).toBe('verified');
  });

  it('keeps only the first line of the error, neutralized, when the page does not settle before the address read', async () => {
    // A browser error's later lines can be a call log that quotes the page's markup.
    adopted.page = scriptedPage(['#save'], {
      gotoReady: async () => {
        throw new Error('page did not settle‮ in 10000 ms\nCall log:\n  - waiting for <tr data-row="customer-4411">Ada</tr>');
      },
    });

    const result = await checkPage(pwPage(), { screenId: 'clusters', projectRoot: await project(), tabCap: 10 });

    expect(result.verdict).toBe('not_covered');
    expect(result.gaps).toEqual([
      {
        ref: 'landing:clusters',
        state: 'not-covered',
        reason:
          "checkPage waited for the page to settle before it read the page's address, and the page did not settle, so it was not checked: page did not settle in 10000 ms",
      },
    ]);
  });

  it('keeps only the first line of the error, neutralized, when the page does not settle while readiness waits for its signal', async () => {
    adopted.page = scriptedPage(['#save'], {
      gotoReady: async () => {
        throw new Error('page did not settle‮ in 10000 ms\nCall log:\n  - waiting for <tr data-row="customer-4411">Ada</tr>');
      },
    });

    const result = await checkPage(pwPage(), { screenId: 'clusters', projectRoot: await project('#orders'), tabCap: 10 });

    expect(result.verdict).toBe('not_covered');
    expect(result.gaps).toEqual([
      {
        ref: 'readiness:clusters',
        state: 'not-covered',
        reason:
          "checkPage waited for this screen's declared readiness signal and the page did not settle, so it was not checked: page did not settle in 10000 ms",
      },
    ]);
  });

  it('checks a labeled page with one control whose readiness signal holds', async () => {
    adopted.page = scriptedPage(['#save'], {
      queryAll: async (selector) => (selector === '#orders' ? [{ selector: '#orders' }] : []),
    });

    const result = await checkPage(pwPage(), { screenId: 'clusters', projectRoot: await project('#orders'), tabCap: 10 });

    expect(result.gaps).toEqual([]);
    expect(result.verdict).toBe('verified');
  });
});
