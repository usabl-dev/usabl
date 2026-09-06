import AxeBuilder from '@axe-core/playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { Finding, Result } from '../../src/contracts/index.js';
import { overlayClientSource } from '../../src/surfaces/overlay-client.js';
import { projectOverlay } from '../../src/surfaces/vite-plugin.js';

let browser: Browser;

// The overlay gives its host and its highlight a random id per page load, so nothing on the page can
// suppress or impersonate them by guessing a fixed one. Everything outside the overlay, including
// these tests, addresses them by their stable attribute instead.
const OVERLAY = '[data-usabl-inspector]';
const HIGHLIGHT = '[data-usabl-highlight]';

const finding = (over: Partial<Finding> = {}): Finding => ({
  rule: 'pf-focus-into-dialog',
  layer: 'pf',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: '#cluster-details',
  elementName: 'View cluster details',
  role: 'button',
  whatUserExperiences: 'Focus stays behind the dialog when it opens.',
  why: 'The dialog focus lifecycle does not establish a keyboard position.',
  fix: 'Move focus into the dialog when it opens.',
  evidence: {},
  confidence: 'fail',
  elementKey: 'clusters|pf-focus-into-dialog|name:view-cluster-details',
  identityBasis: 'name',
  status: 'new',
  ...over,
});

const result = (over: Partial<Result> = {}): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'regression',
  summary: 'regression: 2 gating findings',
  screens: [],
  coverage: {
    changedFiles: ['src/components/DemoModal.tsx'],
    affected: [
      {
        screenId: 'clusters',
        url: 'http://127.0.0.1:5173/clusters',
        provenance: 'route-graph',
      },
    ],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
  findings: [
    finding(),
    finding({
      rule: 'pf-modal-focus-return',
      elementPath: '#close-dialog',
      elementName: 'Close dialog',
      whatUserExperiences: 'Focus does not return to the trigger after the dialog closes.',
      why: 'Keyboard users lose their place in the workflow.',
      fix: 'Return focus to the trigger after close.',
      elementKey: 'clusters|pf-modal-focus-return|name:view-cluster-details',
    }),
  ],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 1,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  ...over,
});

type Projection = ReturnType<typeof projectOverlay>;

interface MountOptions {
  viewport?: { width: number; height: number };
  responseDelayMs?: number;
  path?: string;
  /**
   * One projection per fetch of the result endpoint. The last entry is reused once the list runs
   * out, so a test that only cares about the first payload passes one entry. This is how the fix
   * loop is exercised: first payload has the barrier, second payload does not.
   */
  payloads?: Array<Projection | null>;
  /** Runs in the page before any script, so it can seed or break localStorage. */
  initScript?: string;
}

async function mount(
  payload: Projection | null,
  options: MountOptions = {},
): Promise<Page> {
  const viewport = options.viewport ?? { width: 1280, height: 900 };
  const responseDelayMs = options.responseDelayMs ?? 0;
  // The path the browser opens. The overlay partitions findings by the live pathname, so a screen's
  // findings only appear as "this screen" when the browser is on that screen's path.
  const path = options.path ?? '/';
  const payloads = options.payloads ?? [payload];
  let served = 0;
  const context = await browser.newContext({ viewport });
  if (options.initScript !== undefined) {
    await context.addInitScript(options.initScript);
  }
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  await page.route('http://usabl.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__usabl/result') {
      if (responseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      }
      const current = payloads[Math.min(served, payloads.length - 1)] ?? null;
      served += 1;
      if (current === null) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'unavailable' });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) });
      return;
    }
    await route.fulfill({
      // The real dev server serves the client as utf-8. Say so here too, or the browser decodes the
      // verdict symbols as latin-1 and every assertion about them compares mojibake.
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html lang="en">
          <head><title>Clean host</title></head>
          <body>
            <header><h1>Fleet operations</h1></header>
            <main>
              <button id="cluster-details" type="button">Host action</button>
              <button id="close-dialog" type="button">Close</button>
              <p id="plain-target">Plain paragraph</p>
            </main>
            <script type="module">${overlayClientSource}</script>
          </body>
        </html>`,
    });
  });
  await page.goto('http://usabl.test' + path);
  try {
    await page.locator(OVERLAY).waitFor({ timeout: 2000 });
  } catch {
    throw new Error(`inspector host was not created: ${pageErrors.join(' | ') || 'no page error reported'}`);
  }
  return page;
}

/** Opens the panel from the collapsed badge and returns the panel region locator. */
async function openPanel(page: Page) {
  const host = page.locator(OVERLAY);
  await host.getByRole('button', { name: /Open inspector/i }).click();
  return host.getByRole('region', { name: 'usabl accessibility inspector' });
}

/** The keys of every row whose disclosure is open, read straight off the DOM. */
async function expandedRowTitles(page: Page): Promise<string[]> {
  return page.locator(OVERLAY).evaluate((host) => {
    const root = (host as HTMLElement).shadowRoot;
    if (!root) return [];
    return Array.from(root.querySelectorAll('.finding-button[aria-expanded="true"]')).map(
      (button) => (button.querySelector('.finding-title') as HTMLElement | null)?.textContent ?? '',
    );
  });
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  if (browser) {
    await browser.close();
  }
});

describe('overlay badge and panel', { timeout: 30_000 }, () => {
  it('collapses to a badge that names the state and does not block the app underneath', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator(OVERLAY);

    const badge = host.getByRole('button', {
      name: 'usabl: regression, 2 issues on this screen. Open inspector.',
    });
    expect(await badge.count()).toBe(1);
    // The wordmark keeps the badge identifiable as usabl, and the glyph and count carry the state.
    // Nothing else shows, so it stays out of the way.
    expect((await badge.textContent())?.trim()).toBe('usabl✕2');

    const box = await host.boundingBox();
    expect(box?.width ?? 999).toBeLessThan(130);

    // The host is click-through; only the badge itself takes pointer events.
    const pointerEvents = await host.evaluate((element) => ({
      host: getComputedStyle(element).pointerEvents,
      badge: getComputedStyle(
        (element as HTMLElement).shadowRoot?.querySelector('.badge') as Element,
      ).pointerEvents,
    }));
    expect(pointerEvents.host).toBe('none');
    expect(pointerEvents.badge).toBe('auto');

    await page.context().close();
  });

  it('opens to a verdict banner, a screen line, and returns focus to the badge on Escape', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);

    expect(await panel.isVisible()).toBe(true);
    // The verdict WORD carries the meaning, and the exit code the gate would use is beside it.
    expect(await panel.getByText('Regression', { exact: false }).first().isVisible()).toBe(true);
    expect(await panel.getByText('exit code 1').isVisible()).toBe(true);
    expect(await panel.getByText('This screen', { exact: true }).isVisible()).toBe(true);
    expect(await panel.getByText('/clusters', { exact: true }).isVisible()).toBe(true);
    expect(await panel.getByText('2 here · 0 on other screens').isVisible()).toBe(true);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.keyboard.press('Escape');
    expect(await panel.isHidden()).toBe(true);
    const badge = host.getByRole('button', { name: /Open inspector/i });
    expect(
      await badge.evaluate((element) => {
        const root = element.getRootNode();
        return root instanceof ShadowRoot && root.activeElement === element;
      }),
    ).toBe(true);

    await page.context().close();
  });

  it('lists every finding on this screen as its own row, worst severity first', async () => {
    const mixed = result({
      findings: [
        finding({ severity: 'moderate', rule: 'r-moderate', whatUserExperiences: 'Moderate barrier.' }),
        finding({ severity: 'critical', rule: 'r-critical', whatUserExperiences: 'Critical barrier.' }),
        finding({ severity: 'minor', rule: 'r-minor', whatUserExperiences: 'Minor barrier.' }),
        finding({ severity: 'serious', rule: 'r-serious', whatUserExperiences: 'Serious barrier.' }),
        // Two findings of the same rule. The list never collapses them into one row.
        finding({ severity: 'serious', rule: 'r-serious', whatUserExperiences: 'Second serious barrier.' }),
      ],
    });
    const page = await mount(projectOverlay(mixed), { path: '/clusters' });
    const panel = await openPanel(page);

    const titles = await panel.locator('.finding-title').allTextContents();
    expect(titles).toEqual([
      'Critical barrier.',
      'Serious barrier.',
      'Second serious barrier.',
      'Moderate barrier.',
      'Minor barrier.',
    ]);
    // Severity is spelled out on every row, so it never depends on the colour of the dot.
    expect(await panel.locator('.severity-word').allTextContents()).toEqual([
      'Critical',
      'Serious',
      'Serious',
      'Moderate',
      'Minor',
    ]);
    expect(await panel.getByText('5 issues total').isVisible()).toBe(true);

    await page.context().close();
  });

  it('keeps exactly one row open, locates on activation, and never steals focus', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);

    const firstRow = panel.getByRole('button', { name: /Focus stays behind the dialog/i });
    const secondRow = panel.getByRole('button', { name: /Focus does not return to the trigger/i });

    await firstRow.click();
    expect(await firstRow.getAttribute('aria-expanded')).toBe('true');
    expect(await expandedRowTitles(page)).toEqual(['Focus stays behind the dialog when it opens.']);

    // The detail the row controls is the one that opened, and it carries why, fix, and selector.
    const detailId = await firstRow.getAttribute('aria-controls');
    expect(detailId).toBeTruthy();
    expect(await panel.locator(`#${detailId}`).isVisible()).toBe(true);
    expect(await panel.getByText('The dialog focus lifecycle does not establish a keyboard position.').isVisible()).toBe(true);
    expect(await panel.getByText('Move focus into the dialog when it opens.').isVisible()).toBe(true);
    expect(await panel.getByText('#cluster-details', { exact: true }).isVisible()).toBe(true);

    // Locating highlighted the element on the page.
    expect(await page.locator(HIGHLIGHT).isVisible()).toBe(true);
    expect(await host.getByText('Highlighted View cluster details on the page.').isVisible()).toBe(true);

    // Focus stayed on the row that was activated. The flagged element was not focused.
    const focus = await host.evaluate((element) => {
      const root = (element as HTMLElement).shadowRoot;
      const active = root?.activeElement as HTMLElement | null;
      return {
        inList: active?.classList.contains('finding-button') ?? false,
        pageFocus: document.activeElement?.id ?? '',
      };
    });
    expect(focus.inList).toBe(true);
    expect(focus.pageFocus).not.toBe('cluster-details');

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    // Opening another row closes the first one. The highlight moves with it.
    await secondRow.click();
    expect(await expandedRowTitles(page)).toEqual([
      'Focus does not return to the trigger after the dialog closes.',
    ]);
    expect(await page.locator(HIGHLIGHT).count()).toBe(1);
    expect(await host.getByText('Highlighted Close dialog on the page.').isVisible()).toBe(true);

    // Activating the open row again closes it and takes the highlight away with it.
    await secondRow.click();
    expect(await expandedRowTitles(page)).toEqual([]);
    expect(await page.locator(HIGHLIGHT).count()).toBe(0);

    await page.context().close();
  });

  it('opens a row from the keyboard with Enter and with Space', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const panel = await openPanel(page);
    const firstRow = panel.getByRole('button', { name: /Focus stays behind the dialog/i });

    await firstRow.focus();
    await page.keyboard.press('Enter');
    expect(await firstRow.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator(HIGHLIGHT).count()).toBe(1);

    await page.keyboard.press(' ');
    expect(await firstRow.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator(HIGHLIGHT).count()).toBe(0);

    await page.context().close();
  });

  it('re-highlights on request and moves real focus only when asked', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: /Focus stays behind the dialog/i }).click();

    await panel.getByRole('button', { name: 'Show on page again' }).click();
    expect(await page.locator(HIGHLIGHT).count()).toBe(1);

    await panel.getByRole('button', { name: 'Focus element' }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cluster-details');
    expect(
      await page.locator(OVERLAY).getByText('Keyboard focus moved to View cluster details.').isVisible(),
    ).toBe(true);

    await page.context().close();
  });

  it('focuses an element the page never made focusable, then leaves the tab order alone', async () => {
    const page = await mount(
      projectOverlay(
        result({
          findings: [finding({ elementPath: '#plain-target', elementName: 'Plain paragraph' })],
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);
    const row = panel.getByRole('button', { name: /Focus stays behind the dialog/i });
    await row.click();
    await panel.getByRole('button', { name: 'Focus element' }).click();

    expect(await page.evaluate(() => document.activeElement?.id)).toBe('plain-target');
    expect(await page.locator('#plain-target').getAttribute('tabindex')).toBe('-1');

    // Closing the row removes the tabindex again, so the page's own tab order is unchanged.
    await row.click();
    expect(await page.locator('#plain-target').getAttribute('tabindex')).toBeNull();

    await page.context().close();
  });

  it('reports a stale selector honestly, expands the row, and changes nothing on the page', async () => {
    const page = await mount(
      projectOverlay(result({ findings: [finding({ elementPath: '#gone-since-scan' })] })),
      { path: '/clusters' },
    );
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);
    const row = panel.getByRole('button', { name: /Focus stays behind the dialog/i });

    await row.click();

    // The row still opens, so the developer can read the fix even when the element is gone.
    expect(await row.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator(HIGHLIGHT).count()).toBe(0);

    // Two live regions exist: one for the verdict and one for locate results. This is the latter.
    const status = host.locator('.locate-status');
    expect(await status.getAttribute('role')).toBe('status');
    expect(await status.getAttribute('aria-live')).toBe('polite');
    expect(await status.textContent()).toContain(
      'This was flagged here at the last scan; it is not on the page right now.',
    );
    expect(await status.textContent()).toContain('#gone-since-scan');

    // Both explicit buttons report the same honest status rather than claiming success.
    await panel.getByRole('button', { name: 'Show on page again' }).click();
    expect(await page.locator(HIGHLIGHT).count()).toBe(0);
    expect(await status.textContent()).toContain('it is not on the page right now');

    await panel.getByRole('button', { name: 'Focus element' }).click();
    expect(await page.evaluate(() => document.activeElement?.id ?? '')).not.toBe('gone-since-scan');
    expect(await status.textContent()).toContain('it is not on the page right now');

    await page.context().close();
  });
});

const CLEAN_AFTER_FIX = result({
  verdict: 'verified',
  summary: 'verified: 0 gating findings',
  findings: [],
  exitCode: 0,
});

/** Reads the badge accessible name even while the badge is hidden behind the open panel. */
async function badgeLabel(page: Page): Promise<string> {
  return page.locator(OVERLAY).evaluate(
    (host) =>
      (host as HTMLElement).shadowRoot?.querySelector('.badge')?.getAttribute('aria-label') ?? '',
  );
}

async function bannerWord(page: Page): Promise<string> {
  return page.locator(OVERLAY).evaluate(
    (host) =>
      (host as HTMLElement).shadowRoot?.querySelector('.banner-verdict')?.textContent?.trim() ?? '',
  );
}

describe('the fix loop', { timeout: 30_000 }, () => {
  it('drops a fixed row, clears its highlight, and turns the screen green', async () => {
    const page = await mount(null, {
      path: '/clusters',
      payloads: [projectOverlay(result()), projectOverlay(CLEAN_AFTER_FIX)],
    });
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: /Focus stays behind the dialog/i }).click();
    expect(await page.locator(HIGHLIGHT).count()).toBe(1);

    // The developer saved a fix, so the dev server publishes a new result.
    await panel.getByRole('button', { name: 'Check again' }).click();

    await expect.poll(async () => panel.locator('.finding-button').count()).toBe(0);
    // The row that no longer exists is neither expanded nor highlighted.
    expect(await expandedRowTitles(page)).toEqual([]);
    expect(await page.locator(HIGHLIGHT).count()).toBe(0);

    await expect.poll(async () => bannerWord(page)).toBe('✓Verified');
    expect(await panel.getByText('exit code 0').isVisible()).toBe(true);
    expect(await panel.getByText('0 here · 0 on other screens').isVisible()).toBe(true);
    // The badge names the global verdict as well as the local count, so a green tick is only ever
    // shown for a run that actually reached a clean verdict.
    expect(await badgeLabel(page)).toBe('usabl: verified, no issues on this screen. Open inspector.');
    expect(await panel.getByText('No accessibility findings on this screen.').isVisible()).toBe(true);

    await page.context().close();
  });

  it('keeps a surviving row expanded and re-anchors its highlight after a re-scan', async () => {
    const stillBroken = result({
      summary: 'regression: 1 gating finding',
      findings: [finding()],
    });
    const page = await mount(null, {
      path: '/clusters',
      payloads: [projectOverlay(result()), projectOverlay(stillBroken)],
    });
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: /Focus stays behind the dialog/i }).click();

    await panel.getByRole('button', { name: 'Check again' }).click();

    await expect.poll(async () => panel.locator('.finding-button').count()).toBe(1);
    expect(await expandedRowTitles(page)).toEqual(['Focus stays behind the dialog when it opens.']);
    expect(await page.locator(HIGHLIGHT).count()).toBe(1);

    await page.context().close();
  });

  it('shows the scanning state during a re-scan without wiping the last result', async () => {
    const page = await mount(null, {
      path: '/clusters',
      responseDelayMs: 700,
      payloads: [projectOverlay(result()), projectOverlay(CLEAN_AFTER_FIX)],
    });
    const panel = await openPanel(page);
    await expect.poll(async () => panel.locator('.finding-button').count()).toBe(2);

    await panel.getByRole('button', { name: 'Check again' }).click();

    await expect.poll(async () => bannerWord(page)).toBe('…Scanning');
    // The previous result stays on screen while the new scan runs, so the panel does not flicker.
    expect(await panel.locator('.finding-button').count()).toBe(2);

    await expect.poll(async () => bannerWord(page), { timeout: 10_000 }).toBe('✓Verified');

    await page.context().close();
  });

  it('shows no result yet on load and asks for a fresh run only from Check again', async () => {
    // The dev server caches the last completed result. On page load the client cannot tell whether
    // the server will answer from that cache or scan, so it must not claim "Scanning". Check again
    // is the one user-driven re-run, and it says so to the server with fresh=1.
    const page = await mount(null, {
      path: '/clusters',
      responseDelayMs: 600,
      payloads: [projectOverlay(result())],
    });
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/__usabl/result')) {
        requests.push(request.url());
      }
    });

    // Still waiting on the first response: pending, not scanning.
    expect(await badgeLabel(page)).toBe('usabl: no result yet. Open inspector.');
    const panel = await openPanel(page);
    expect(await bannerWord(page)).toBe('○No result yet');
    await expect.poll(async () => bannerWord(page), { timeout: 10_000 }).toBe('✕Regression');

    await panel.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(async () => bannerWord(page)).toBe('…Scanning');
    await expect.poll(async () => requests.length).toBe(1);
    expect(requests[0]).toContain('/__usabl/result?fresh=1');
    await expect.poll(async () => bannerWord(page), { timeout: 10_000 }).toBe('✕Regression');

    await page.context().close();
  });
});

describe('overlay preferences', { timeout: 30_000 }, () => {
  it('reopens in the state it was left in', async () => {
    const page = await mount(projectOverlay(result()), {
      path: '/clusters',
      initScript: "window.localStorage.setItem('usabl.overlay.open', '1');",
    });
    const host = page.locator(OVERLAY);

    const panel = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await panel.isVisible()).toBe(true);
    expect(await host.locator('.badge').isHidden()).toBe(true);

    await page.context().close();
  });

  it('remembers the wide setting across a reload and reports it with aria-pressed', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);

    const toggle = panel.getByRole('button', { name: 'Wide panel' });
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    const compactWidth = (await host.boundingBox())?.width ?? 0;

    await toggle.click();
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    expect((await host.boundingBox())?.width ?? 0).toBeGreaterThan(compactWidth);

    await page.reload();
    await host.waitFor();
    const reopened = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await reopened.isVisible()).toBe(true);
    expect(
      await reopened.getByRole('button', { name: 'Wide panel' }).getAttribute('aria-pressed'),
    ).toBe('true');

    await page.context().close();
  });

  it('still works when localStorage throws on every access', async () => {
    const page = await mount(projectOverlay(result()), {
      path: '/clusters',
      initScript: `Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new Error('storage blocked'); },
      });`,
    });
    const host = page.locator(OVERLAY);

    // Fails safe to collapsed, and opening still works.
    expect(await host.locator('.badge').isVisible()).toBe(true);
    const panel = await openPanel(page);
    expect(await panel.isVisible()).toBe(true);
    expect(await panel.locator('.finding-button').count()).toBe(2);

    await page.context().close();
  });
});

describe('overlay screen awareness', { timeout: 30_000 }, () => {
  it('says plainly when the live path matches no scanned screen', async () => {
    const page = await mount(projectOverlay(result()), { path: '/' });
    const host = page.locator(OVERLAY);
    // The blocked global verdict is named first. An unscanned screen inside a blocked run must not
    // read as though there were nothing to worry about.
    expect(await badgeLabel(page)).toBe(
      'usabl: regression. This screen was not scanned. Open inspector.',
    );

    const panel = await openPanel(page);
    // The reason the screen has no result is the change, not a failure, and the developer is told
    // where the issues are instead.
    expect(
      await panel
        .getByText(
          'Your change did not touch this screen, so usabl did not check it. 2 issues are on 1 other screen.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    expect(await panel.getByText('not part of the last scan', { exact: false }).count()).toBe(0);
    expect(await panel.getByText('nothing to report', { exact: false }).count()).toBe(0);
    expect(await panel.locator('.finding-button').count()).toBe(0);
    expect(await host.locator('.finding-button').count()).toBe(0);

    await page.context().close();
  });

  it('normalizes trailing slash and ignores host and port when matching the current screen', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters/' });
    const panel = await openPanel(page);

    expect(await panel.getByText('This screen was not part of the last scan', { exact: false }).count()).toBe(0);
    expect(await panel.locator('.finding-button').count()).toBe(2);

    await page.context().close();
  });

  it('guides to other screens worst first, with counts and navigating links only', async () => {
    const withOtherScreens = result({
      summary: 'regression: 4 gating findings',
      coverage: {
        changedFiles: ['src/app.tsx'],
        affected: [
          { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
          { screenId: 'jobs', url: 'http://127.0.0.1:5173/jobs', provenance: 'route-graph' },
          { screenId: 'deployments', url: 'http://127.0.0.1:5173/deployments', provenance: 'route-graph' },
        ],
        unresolvedFiles: [],
        gaps: [],
        nothingToCheck: false,
      },
      findings: [
        finding({ screenId: 'clusters', whatUserExperiences: 'Clusters barrier.' }),
        finding({ screenId: 'jobs', severity: 'minor', rule: 'r-jobs', whatUserExperiences: 'Jobs barrier.' }),
        finding({
          screenId: 'deployments',
          severity: 'critical',
          rule: 'r-deploy-1',
          whatUserExperiences: 'Deployments barrier one.',
        }),
        finding({
          screenId: 'deployments',
          severity: 'serious',
          rule: 'r-deploy-2',
          whatUserExperiences: 'Deployments barrier two.',
        }),
      ],
    });
    const page = await mount(projectOverlay(withOtherScreens), { path: '/clusters' });
    const panel = await openPanel(page);

    expect(await panel.getByText('Clusters barrier.').isVisible()).toBe(true);
    // No other screen's individual findings appear anywhere in the panel.
    expect(await panel.getByText('Deployments barrier one.').count()).toBe(0);
    expect(await panel.getByText('Jobs barrier.').count()).toBe(0);

    const elsewhere = panel.locator('.elsewhere');
    expect(await elsewhere.getByRole('heading', { name: 'On other screens' }).isVisible()).toBe(true);
    // This screen has a finding, so the guide says to fix it before moving on.
    expect(
      await elsewhere
        .getByText('Fix this screen first, then move on. These screens also have findings.')
        .isVisible(),
    ).toBe(true);
    // Worst severity first: deployments carries a critical, jobs only a minor.
    expect(await elsewhere.locator('.elsewhere-name').allTextContents()).toEqual([
      'deployments',
      'jobs',
    ]);
    expect(await elsewhere.locator('.elsewhere-count').allTextContents()).toEqual([
      '2 findings',
      '1 finding',
    ]);
    expect(await elsewhere.locator('.elsewhere-worst').first().textContent()).toBe('worst: critical');

    const hrefs = await elsewhere
      .getByRole('link', { name: 'Go to this screen' })
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute('href')));
    expect(hrefs).toEqual(['/deployments', '/jobs']);
    expect(await panel.getByText('1 here · 3 on other screens').isVisible()).toBe(true);

    await page.context().close();
  });

  it('re-partitions on client-side navigation and drops the highlight from the screen it left', async () => {
    const twoScreens = result({
      coverage: {
        changedFiles: ['src/app.tsx'],
        affected: [
          { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
          { screenId: 'deployments', url: 'http://127.0.0.1:5173/deployments', provenance: 'route-graph' },
        ],
        unresolvedFiles: [],
        gaps: [],
        nothingToCheck: false,
      },
      findings: [
        finding({ screenId: 'clusters', whatUserExperiences: 'Clusters barrier.' }),
        finding({
          screenId: 'deployments',
          rule: 'pf-deploy',
          whatUserExperiences: 'Deployments barrier.',
        }),
      ],
    });
    const page = await mount(projectOverlay(twoScreens), { path: '/clusters' });
    const panel = await openPanel(page);

    await panel.getByRole('button', { name: /Clusters barrier/i }).click();
    expect(await page.locator(HIGHLIGHT).count()).toBe(1);

    await page.evaluate(() => history.pushState({}, '', '/deployments'));
    await expect.poll(async () => panel.getByText('Deployments barrier.').count()).toBe(1);
    expect(await panel.getByText('Clusters barrier.').count()).toBe(0);
    expect(await page.locator(HIGHLIGHT).count()).toBe(0);
    expect(await expandedRowTitles(page)).toEqual([]);

    await page.evaluate(() => history.pushState({}, '', '/clusters'));
    await page.goBack();
    await expect.poll(async () => panel.getByText('Deployments barrier.').count()).toBe(1);

    await page.context().close();
  });
});

describe('overlay states', { timeout: 30_000 }, () => {
  it('says no result yet, not scanning, before the first result arrives', async () => {
    // On page load the dev server may answer from its cached result at once or run a scan that
    // takes many seconds, and the client cannot tell which. "No result yet" is true in both cases.
    // "Scanning" is reserved for reads that really run the engine: a server-pushed refresh after a
    // file change, and the user's Check again.
    const page = await mount(projectOverlay(result()), { responseDelayMs: 1000 });
    expect(await badgeLabel(page)).toBe('usabl: no result yet. Open inspector.');
    await page.context().close();
  });

  it('says nothing was checked when the run had nothing to check', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: null,
          summary: 'nothing to check',
          findings: [],
          exitCode: 0,
          coverage: {
            changedFiles: [],
            affected: [],
            unresolvedFiles: [],
            gaps: [],
            nothingToCheck: true,
          },
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);

    expect(await bannerWord(page)).toBe('○Nothing to check');
    expect(
      await panel
        .getByText('Your change touched no screen usabl checks, so this run had nothing to check.')
        .isVisible(),
    ).toBe(true);
    await page.context().close();
  });

  it('says plainly that nothing is proven when coverage failed', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'not_covered',
          summary: 'not covered: browser unavailable',
          coverage: {
            changedFiles: ['src/app.tsx'],
            affected: [],
            unresolvedFiles: ['src/app.tsx'],
            gaps: [{ ref: 'clusters', state: 'not-covered', reason: 'browser unavailable' }],
            nothingToCheck: false,
          },
          findings: [],
          exitCode: 3,
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);

    expect(await bannerWord(page)).toBe('?Not covered');
    expect(
      await panel.getByText('usabl could not check the affected screens, so nothing here is proven.').isVisible(),
    ).toBe(true);
    // The reason a screen was not covered survives to the reader.
    expect(await panel.getByText('clusters: browser unavailable').isVisible()).toBe(true);
    await page.context().close();
  });

  it('says who has to act when a guarded file changed', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'approval_required',
          summary: 'approval required: guarded policy changed',
          findings: [],
          dirtyGuardedPaths: ['usabl.config.json'],
          exitCode: 2,
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);

    expect(await bannerWord(page)).toBe('!Approval required');
    // The file is named in the sentence, not only in the chips below it.
    expect(await panel.getByText('Guarded file changed: usabl.config.json.', { exact: true }).isVisible()).toBe(true);
    expect(
      await panel
        .getByText(
          'A code owner other than the author approves it on the pull request. Nothing in this panel or on your machine can approve it.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    expect(await panel.getByRole('heading', { name: 'Guarded paths awaiting review' }).isVisible()).toBe(true);
    // The old sentence named nobody and no file.
    expect(await panel.getByText('A person has to approve', { exact: false }).count()).toBe(0);
    await page.context().close();
  });

  it('admits it has no result when the endpoint fails', async () => {
    const page = await mount(null, { path: '/clusters' });
    expect(await badgeLabel(page)).toBe('usabl: could not load a result. Open inspector.');

    const panel = await openPanel(page);
    expect(await bannerWord(page)).toBe('!Not verified');
    expect(
      await panel
        .getByText('usabl could not load a result, so it can say nothing about this screen.', { exact: false })
        .isVisible(),
    ).toBe(true);
    expect(
      await panel.getByText('The inspector could not load the current result.', { exact: false }).isVisible(),
    ).toBe(true);
    await page.context().close();
  });

  it('renders the verified receipt binding without inventing new proof fields', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'verified',
          summary: 'verified: 0 gating findings',
          findings: [],
          receipt: {
            schemaVersion: 1,
            sourceTree: 'abcdef1234567890',
            baseRevision: 'origin/main',
            policyHash: 'policy1234567890',
            runnerVersion: '0.1.0',
            scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: '140' },
            surfaces: ['vite'],
            coverage: { checked: ['clusters'], notCovered: [] },
            applicability: [],
            verdict: 'verified',
            findingsSummary: { new: 0, carried: 0, fixed: 1, unverified: 0 },
            activeWaivers: 0,
            mintedAt: '2026-08-27T00:00:00.000Z',
          },
          exitCode: 0,
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);

    expect(
      await panel
        .getByText('No findings on any screen usabl checked. The receipt below records what that covered.')
        .isVisible(),
    ).toBe(true);
    expect(await panel.getByText('abcdef12', { exact: true }).isVisible()).toBe(true);
    expect(await panel.getByText('policy12', { exact: true }).isVisible()).toBe(true);
    expect(await panel.getByText('0.1.0', { exact: true }).isVisible()).toBe(true);
    await page.context().close();
  });

  it('reports the floor pay-down count only when there is one', async () => {
    const withDebt = await mount(
      projectOverlay(result({ verdict: 'verified', findings: [], paidDownCount: 4, exitCode: 0 })),
      { path: '/clusters' },
    );
    const withDebtPanel = await openPanel(withDebt);
    expect(
      await withDebtPanel.getByText(/4 previously accepted findings.*cleanly scanned/i).isVisible(),
    ).toBe(true);
    expect(await withDebtPanel.getByText(/usabl floor prune.*re-arm/i).isVisible()).toBe(true);
    await withDebt.context().close();

    const clean = await mount(
      projectOverlay(result({ verdict: 'verified', findings: [], paidDownCount: 0, exitCode: 0 })),
      { path: '/clusters' },
    );
    const cleanPanel = await openPanel(clean);
    expect(await cleanPanel.getByText(/floor debt/i).count()).toBe(0);
    await clean.context().close();
  });
});

/**
 * Every sentence the panel shows is for a developer deciding what to do next. These rows pin the
 * sentences for the states where the old wording sent them the wrong way: told to fix a screen that
 * had nothing to fix, told a screen was "not part of the scan" with no reason, shown an empty issues
 * list and a table of "None" instead of the engine's reason for having no verdict, and told "a
 * person" had to approve a file without saying which file, which person, or what they could do.
 */
describe('the panel tells a developer what to do next', { timeout: 40_000 }, () => {
  const twoScreens = (over: Partial<Result> = {}): Result =>
    result({
      summary: 'regression: 1 gating finding',
      coverage: {
        changedFiles: ['src/app.tsx'],
        affected: [
          { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
          { screenId: 'jobs', url: 'http://127.0.0.1:5173/jobs', provenance: 'route-graph' },
        ],
        unresolvedFiles: [],
        gaps: [],
        nothingToCheck: false,
      },
      findings: [finding({ screenId: 'jobs', whatUserExperiences: 'Jobs barrier.' })],
      ...over,
    });

  it('points at the worst screen when this screen has nothing to fix', async () => {
    const page = await mount(projectOverlay(twoScreens()), { path: '/clusters' });
    const panel = await openPanel(page);
    const elsewhere = panel.locator('.elsewhere');

    expect(
      await elsewhere
        .getByText('Nothing was found on this screen. Start with the screen that has the worst findings.')
        .isVisible(),
    ).toBe(true);
    // There is nothing to fix here, so the guide must not say to fix it first.
    expect(await panel.getByText('Fix this screen first', { exact: false }).count()).toBe(0);
    expect(await elsewhere.getByRole('link', { name: 'Go to this screen' }).getAttribute('href')).toBe('/jobs');

    await page.context().close();
  });

  it('says a screen the change did not touch was skipped by design, and where the issues are', async () => {
    const page = await mount(projectOverlay(twoScreens()), { path: '/settings' });
    const panel = await openPanel(page);

    expect(
      await panel
        .getByText(
          'Your change did not touch this screen, so usabl did not check it. 1 issue is on 1 other screen.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    // The issues list says the same thing in its own words, not "not part of the last scan".
    expect(
      await panel
        .getByText(
          'usabl did not check this screen, because your change did not touch it. There is nothing to list.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    expect(await panel.getByText('not part of the last scan', { exact: false }).count()).toBe(0);
    // The guide to other screens does not tell them to fix this one first.
    expect(
      await panel
        .getByText('usabl did not check this screen. Start with the screen that has the worst findings.')
        .isVisible(),
    ).toBe(true);

    await page.context().close();
  });

  it('says the run found nothing when the change did not touch this screen and no screen had issues', async () => {
    const page = await mount(
      projectOverlay(twoScreens({ summary: 'regression', findings: [] })),
      { path: '/settings' },
    );
    const panel = await openPanel(page);

    expect(
      await panel
        .getByText(
          'Your change did not touch this screen, so usabl did not check it. The run found no issues on the screens it checked.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);

    await page.context().close();
  });

  it('says usabl could not check a screen that was in scope but has a coverage gap', async () => {
    // clusters is affected, so it is in scope, but the engine could not scan it and said why. The
    // panel must not list "no findings" for it as if it had been checked.
    const withGap = twoScreens({
      coverage: {
        changedFiles: ['src/app.tsx'],
        affected: [
          { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
          { screenId: 'jobs', url: 'http://127.0.0.1:5173/jobs', provenance: 'route-graph' },
        ],
        unresolvedFiles: [],
        gaps: [{ ref: 'clusters', state: 'not-covered', reason: 'route did not load within 30s' }],
        nothingToCheck: false,
      },
    });
    const page = await mount(projectOverlay(withGap), { path: '/clusters' });
    expect(await badgeLabel(page)).toBe(
      'usabl: regression. usabl could not check this screen. Open inspector.',
    );

    const panel = await openPanel(page);
    expect(
      await panel
        .getByText(
          'usabl could not check this screen: route did not load within 30s. Nothing here is proven. See the coverage gaps below.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    expect(
      await panel
        .getByText(
          'usabl could not check this screen: route did not load within 30s. There is nothing to list. See the coverage gaps below.',
          { exact: true },
        )
        .isVisible(),
    ).toBe(true);
    expect(await panel.getByText('No accessibility findings on this screen.').count()).toBe(0);
    expect(await panel.getByText('did not touch this screen', { exact: false }).count()).toBe(0);
    // The gap it points to is really there.
    expect(await panel.getByText('clusters: route did not load within 30s').isVisible()).toBe(true);

    await page.context().close();
  });

  it('shows the engine reason as the one section when there is no verdict', async () => {
    const refused = result({
      verdict: null,
      summary: 'refused: duplicate surface id "vite" in usabl.config.json. Give each surface its own id.',
      findings: [],
      exitCode: 4,
    });
    const page = await mount(projectOverlay(refused), { path: '/clusters' });
    const panel = await openPanel(page);

    expect(await bannerWord(page)).toBe('!No verdict');
    expect(await panel.locator('.banner-exit').textContent()).toBe('exit code 4');
    expect(await panel.getByRole('heading', { name: 'Why there is no verdict' }).isVisible()).toBe(true);
    expect(
      await panel
        .getByText('refused: duplicate surface id "vite" in usabl.config.json. Give each surface its own id.')
        .isVisible(),
    ).toBe(true);
    expect(await panel.getByText('Nothing on this screen is proven.', { exact: true }).isVisible()).toBe(true);

    // The empty sections that used to bury the reason are gone.
    expect(await panel.getByRole('heading', { name: 'Issues on this screen' }).count()).toBe(0);
    expect(await panel.getByRole('heading', { name: 'Coverage' }).count()).toBe(0);
    expect(await panel.locator('.screen-line').count()).toBe(0);
    expect(await panel.locator('.panel-body > .section').count()).toBe(1);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.context().close();
  });

  it('says usabl gave no reason when a no-verdict result carries no summary', async () => {
    const silent = projectOverlay(result({ verdict: null, summary: '', findings: [], exitCode: 4 }));
    delete (silent as { summary?: unknown }).summary;
    const page = await mount(silent, { path: '/clusters' });
    const panel = await openPanel(page);

    expect(await panel.getByText('usabl gave no reason.', { exact: true }).isVisible()).toBe(true);
    expect(await panel.getByText('Nothing on this screen is proven.', { exact: true }).isVisible()).toBe(true);

    await page.context().close();
  });

  it('states the approval as facts: which file, who approves, and the accessibility result apart', async () => {
    // A guarded file changed AND this screen has real barriers. The barriers are what the developer
    // can fix now, so they are stated apart from the approval nobody in this panel can give.
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'approval_required',
          summary: 'approval required: guarded policy changed',
          dirtyGuardedPaths: ['usabl.config.json', '.usabl/waivers.json'],
          exitCode: 2,
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);
    const lines = await panel.locator('.banner-note').allTextContents();

    expect(lines).toEqual([
      'Guarded files changed: usabl.config.json, .usabl/waivers.json.',
      'A code owner other than the author approves it on the pull request. Nothing in this panel or on your machine can approve it.',
      'Accessibility is judged separately from the approval. This run found 2 issues on this screen and 0 issues on other screens. Run usabl check for the accessibility verdict.',
      'If the change was unintended, revert the files and this state clears.',
    ]);
    expect(await panel.getByText('A person has to approve', { exact: false }).count()).toBe(0);
    // The barriers are still listed for fixing.
    expect(await panel.locator('.finding-button').count()).toBe(2);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.context().close();
  });

  it('states the approval facts for a clean screen with one guarded file', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'approval_required',
          summary: 'approval required',
          findings: [],
          dirtyGuardedPaths: ['usabl.config.json'],
          exitCode: 2,
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);
    const lines = await panel.locator('.banner-note').allTextContents();

    expect(lines).toEqual([
      'Guarded file changed: usabl.config.json.',
      'A code owner other than the author approves it on the pull request. Nothing in this panel or on your machine can approve it.',
      'Accessibility is judged separately from the approval. This run found 0 issues on this screen and 0 issues on other screens. Run usabl check for the accessibility verdict.',
      'If the change was unintended, revert the file and this state clears.',
    ]);

    await page.context().close();
  });
});

describe('the overlay is itself accessible and read only', { timeout: 30_000 }, () => {
  it('never treats page text as HTML and never shows the untrusted frame markers', async () => {
    const hostile = finding({
      whatUserExperiences: '<img src=x onerror="window.__usablXss=1">markup impact',
      elementName: '<b>evil</b>',
      elementPath: '#cluster-details',
    });
    const page = await mount(projectOverlay(result({ findings: [hostile] })), { path: '/clusters' });
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);
    await panel.locator('.finding-button').click();

    const xssRan = await page.evaluate(() => (window as unknown as { __usablXss?: number }).__usablXss);
    expect(xssRan).toBeUndefined();

    const shadowText = await host.evaluate((el) => el.shadowRoot?.textContent ?? '');
    expect(shadowText).toContain('markup impact');
    expect(shadowText).toContain('<b>evil</b>');
    expect(shadowText).not.toContain('BEGIN UNTRUSTED PAGE TEXT');
    expect(shadowText).not.toContain('END UNTRUSTED PAGE TEXT');
    // No element was created from that text; it is all text nodes.
    expect(await page.locator(OVERLAY + ' img').count()).toBe(0);

    await page.context().close();
  });

  it('gives every control at least a 44 pixel target', async () => {
    const page = await mount(
      projectOverlay(
        result({
          coverage: {
            changedFiles: ['src/app.tsx'],
            affected: [
              { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
              { screenId: 'jobs', url: 'http://127.0.0.1:5173/jobs', provenance: 'route-graph' },
            ],
            unresolvedFiles: [],
            gaps: [],
            nothingToCheck: false,
          },
          findings: [finding(), finding({ screenId: 'jobs', rule: 'r-jobs' })],
        }),
      ),
      { path: '/clusters' },
    );
    const host = page.locator(OVERLAY);

    // Collapsed first, so the badge itself is measured.
    const badgeBox = await host.locator('.badge').boundingBox();
    expect(badgeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(badgeBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    const panel = await openPanel(page);
    await panel.locator('.finding-button').first().click();

    const short = await host.evaluate((element) => {
      const root = (element as HTMLElement).shadowRoot;
      if (!root) return ['no shadow root'];
      return Array.from(root.querySelectorAll('button, a'))
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((entry) => entry.rect.height > 0 && entry.rect.height < 44)
        .map((entry) => (entry.node.className || entry.node.tagName) + ':' + Math.round(entry.rect.height));
    });
    expect(short).toEqual([]);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.context().close();
  });

  it('stays inside a narrow viewport with many long findings and scrolls the list internally', async () => {
    const findings = Array.from({ length: 24 }, (_, index) =>
      finding({
        rule: `rule-${index + 1}`,
        whatUserExperiences: `Finding ${index + 1}: ${'Long accessibility impact text '.repeat(8)}`,
      }),
    );
    const page = await mount(projectOverlay(result({ findings })), {
      viewport: { width: 360, height: 640 },
      path: '/clusters',
    });
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);

    // No hard cap on the list. Every finding has a row; the container bounds the height instead.
    expect(await panel.locator('.finding-button').count()).toBe(24);
    const scroll = await panel.locator('.finding-scroll').evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);

    const bounds = await host.boundingBox();
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(bounds).not.toBeNull();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(640);
    expect(horizontalOverflow).toBe(false);

    await page.context().close();
  });

  it('truncates a collapsed title and shows the whole one when the row opens', async () => {
    const long = 'A very long accessibility impact sentence that will not fit on one line at all. '.repeat(3);
    const page = await mount(
      projectOverlay(result({ findings: [finding({ whatUserExperiences: long })] })),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);
    const title = panel.locator('.finding-title');

    // The full string is always in the DOM, so the accessible name is never the truncated version.
    expect((await title.textContent())?.trim()).toBe(long.trim());
    // Collapsed: the rendered box is shorter than the text it holds, so the title is visibly cut.
    const collapsed = await title.evaluate((node) => ({
      clipped: node.scrollHeight > node.clientHeight,
      height: node.clientHeight,
    }));
    expect(collapsed.clipped).toBe(true);

    await panel.locator('.finding-button').click();
    const expanded = await title.evaluate((node) => ({
      clipped: node.scrollHeight > node.clientHeight,
      height: node.clientHeight,
    }));
    expect(expanded.clipped).toBe(false);
    expect(expanded.height).toBeGreaterThan(collapsed.height);

    await page.context().close();
  });
});

describe('overlay accessibility guarantees', { timeout: 30_000 }, () => {
  it('collapses from the caret control as well as from Escape', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);

    await panel.getByRole('button', { name: 'Collapse the usabl inspector' }).click();

    expect(await panel.isHidden()).toBe(true);
    const badge = host.getByRole('button', { name: /Open inspector/i });
    expect(await badge.isVisible()).toBe(true);
    // Focus lands on the badge, so a keyboard user is not dropped on the document.
    expect(
      await badge.evaluate((element) => {
        const root = element.getRootNode();
        return root instanceof ShadowRoot && root.activeElement === element;
      }),
    ).toBe(true);

    await page.context().close();
  });

  it('scrolls without animation when the reader asked for reduced motion', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    // Record the scroll behaviour the overlay asks for, before any overlay code runs.
    await context.addInitScript(`
      window.__usablScrollBehaviours = [];
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options) {
        window.__usablScrollBehaviours.push(options && options.behavior);
        return original.apply(this, arguments);
      };
    `);
    const page = await context.newPage();
    await page.route('http://usabl.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__usabl/result') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(projectOverlay(result())),
        });
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html lang="en">
            <head><title>Clean host</title></head>
            <body>
              <header><h1>Fleet operations</h1></header>
              <main><button id="cluster-details" type="button">Host action</button></main>
              <script type="module">${overlayClientSource}</script>
            </body>
          </html>`,
      });
    });
    await page.goto('http://usabl.test/clusters');
    await page.locator(OVERLAY).waitFor();

    const panel = await openPanel(page);
    await panel.locator('.finding-button').first().click();

    const behaviours = await page.evaluate(
      () => (window as unknown as { __usablScrollBehaviours: string[] }).__usablScrollBehaviours,
    );
    expect(behaviours).toContain('auto');
    expect(behaviours).not.toContain('smooth');

    await context.close();
  });

  it('draws a visible focus indicator on every control reached by keyboard', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator(OVERLAY);
    await openPanel(page);

    const outlines: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      const outline = await host.evaluate((element) => {
        const active = (element as HTMLElement).shadowRoot?.activeElement;
        if (!active) return 'no shadow focus';
        const style = getComputedStyle(active);
        return `${style.outlineStyle}:${style.outlineWidth}`;
      });
      outlines.push(outline);
    }

    // Every stop reports a real outline, so focus is never invisible inside the panel.
    for (const outline of outlines) {
      expect(outline).toMatch(/^solid:[1-9]/);
    }

    await page.context().close();
  });
});

/**
 * The false-green table.
 *
 * Every row here is a Result that is NOT clean, paired with what the collapsed badge and the panel
 * must say about it. The defect these guard: a null verdict was read as "nothing to check" whatever
 * the exit code said, and a clean current screen earned a green tick even while the run as a whole
 * was blocked. A crash that renders as a calm grey pass, or a regression behind a green badge, is
 * the exact failure this product exists to prevent, so each row is asserted on both surfaces.
 */
describe('the overlay never shows green for a run that is not green', { timeout: 40_000 }, () => {
  const crashed = (over: Partial<Result> = {}): Result =>
    result({
      verdict: null,
      summary: 'usabl exited without a verdict',
      findings: [],
      exitCode: 4,
      ...over,
    });

  it('names a crash with no screens seen as an absence of proof, not as idle', async () => {
    const page = await mount(
      projectOverlay(
        crashed({
          coverage: {
            changedFiles: ['src/app.tsx'],
            affected: [],
            unresolvedFiles: [],
            gaps: [],
            nothingToCheck: false,
          },
        }),
      ),
      { path: '/clusters' },
    );

    expect(await badgeLabel(page)).toBe(
      'usabl: no verdict. This screen was not scanned. Open inspector.',
    );
    const panel = await openPanel(page);
    expect(await bannerWord(page)).toBe('!No verdict');
    expect(await panel.locator('.banner-exit').textContent()).toBe('exit code 4');
    expect(
      await panel
        .getByText('usabl finished without a verdict, so nothing on this screen is proven.', { exact: true })
        .isVisible(),
    ).toBe(true);
    await page.context().close();
  });

  it('names a crash on a screen that WAS scanned as an absence of proof', async () => {
    // The screen matched and carries no findings, which is exactly the shape that used to read as a
    // green tick. Exit code 4 means usabl never reached a verdict, so nothing here is proven.
    const page = await mount(projectOverlay(crashed()), { path: '/clusters' });

    expect(await badgeLabel(page)).toBe(
      'usabl: no verdict elsewhere, no issues on this screen. Open inspector.',
    );
    const panel = await openPanel(page);
    expect(await bannerWord(page)).toBe('!No verdict');
    expect(await panel.locator('.banner-exit').textContent()).toBe('exit code 4');
    await page.context().close();
  });

  it('keeps a blocked approval off the green badge even with a clean screen', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'approval_required',
          summary: 'approval required',
          findings: [],
          dirtyGuardedPaths: ['usabl.config.json'],
          exitCode: 2,
        }),
      ),
      { path: '/clusters' },
    );

    expect(await badgeLabel(page)).toBe(
      'usabl: approval required elsewhere, no issues on this screen. Open inspector.',
    );
    const panel = await openPanel(page);
    expect(await bannerWord(page)).toBe('!Approval required');
    await page.context().close();
  });

  it('keeps a regression on another screen off the green badge', async () => {
    const elsewhereOnly = result({
      summary: 'regression: 1 gating finding',
      coverage: {
        changedFiles: ['src/app.tsx'],
        affected: [
          { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
          { screenId: 'jobs', url: 'http://127.0.0.1:5173/jobs', provenance: 'route-graph' },
        ],
        unresolvedFiles: [],
        gaps: [],
        nothingToCheck: false,
      },
      findings: [finding({ screenId: 'jobs', whatUserExperiences: 'Jobs barrier.' })],
    });
    const page = await mount(projectOverlay(elsewhereOnly), { path: '/clusters' });

    expect(await badgeLabel(page)).toBe(
      'usabl: regression elsewhere, no issues on this screen. Open inspector.',
    );
    const panel = await openPanel(page);
    expect(await bannerWord(page)).toBe('✕Regression');
    expect(
      await panel
        .getByText('No findings on this screen, but other screens have findings and the gate is blocked.')
        .isVisible(),
    ).toBe(true);
    await page.context().close();
  });

  it('keeps a not-covered run off the green badge', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'not_covered',
          summary: 'not covered',
          findings: [],
          exitCode: 3,
        }),
      ),
      { path: '/clusters' },
    );

    expect(await badgeLabel(page)).toBe(
      'usabl: not covered elsewhere, no issues on this screen. Open inspector.',
    );
    await page.context().close();
  });

  it('calls a verified run carrying accepted debt non-gating, not clean', async () => {
    const withDebt = result({
      verdict: 'verified',
      summary: 'verified: 0 gating findings',
      findings: [finding({ status: 'carried', whatUserExperiences: 'Accepted barrier.' })],
      exitCode: 0,
    });
    const page = await mount(projectOverlay(withDebt), { path: '/clusters' });

    // The count is still shown, because the finding is listed. Calling it an issue would contradict
    // the verified verdict printed beside it.
    expect(await badgeLabel(page)).toBe(
      'usabl: verified, 1 non-gating finding on this screen. Open inspector.',
    );
    const panel = await openPanel(page);
    expect(await bannerWord(page)).toBe('✓Verified');
    expect(
      await panel
        .getByText('No new gating findings. The findings listed are accepted, waived, or already fixed.')
        .isVisible(),
    ).toBe(true);
    await page.context().close();
  });

  it('says a verified verdict does not cover a screen it never scanned', async () => {
    const page = await mount(
      projectOverlay(result({ verdict: 'verified', findings: [], exitCode: 0 })),
      { path: '/never-scanned' },
    );

    expect(await badgeLabel(page)).toBe(
      'usabl: verified, but this screen was not scanned. Open inspector.',
    );
    const panel = await openPanel(page);
    expect(
      await panel
        .getByText('Verified, but this screen was not part of the last scan, so that verdict does not cover it.')
        .isVisible(),
    ).toBe(true);
    await page.context().close();
  });

  it('reserves the idle state for a run that finished clean and said it had nothing to check', async () => {
    // Exit code 0 alone is not enough, and neither is the nothing-to-check flag alone.
    const nothing = (exitCode: number, nothingToCheck: boolean) =>
      projectOverlay(
        result({
          verdict: null,
          summary: 'no verdict',
          findings: [],
          exitCode: exitCode as Result['exitCode'],
          coverage: {
            changedFiles: [],
            affected: [],
            unresolvedFiles: [],
            gaps: [],
            nothingToCheck,
          },
        }),
      );

    const idle = await mount(nothing(0, true), { path: '/clusters' });
    expect(await bannerWord(idle)).toBe('○Nothing to check');
    await idle.context().close();

    const zeroButNotDeclared = await mount(nothing(0, false), { path: '/clusters' });
    expect(await bannerWord(zeroButNotDeclared)).toBe('!No verdict');
    await zeroButNotDeclared.context().close();

    const declaredButFailed = await mount(nothing(4, true), { path: '/clusters' });
    expect(await bannerWord(declaredButFailed)).toBe('!No verdict');
    await declaredButFailed.context().close();
  });

  // The idle branch used to fire on exit code 0 and the nothing-to-check flag alone. A projection
  // that carries those two fields but a verdict the panel does not know, or no verdict field at all,
  // must not slip through to the calm idle badge or the clear tick. These build a normal idle-shaped
  // projection and then overwrite the verdict to prove the null-verdict guard, not the coverage
  // fields, is what earns idle.
  const idleShaped = () =>
    projectOverlay(
      result({
        verdict: null,
        summary: 'no verdict',
        findings: [],
        exitCode: 0 as Result['exitCode'],
        coverage: {
          changedFiles: [],
          affected: [],
          unresolvedFiles: [],
          gaps: [],
          nothingToCheck: true,
        },
      }),
    );

  it('does not read an unknown verdict string as idle even with idle coverage fields', async () => {
    const unknown = idleShaped();
    (unknown as { verdict: unknown }).verdict = 'sometime-future-verdict';
    const page = await mount(unknown, { path: '/clusters' });
    expect(await bannerWord(page)).toBe('!No verdict');
    // The badge must not be in its clear or idle appearance either.
    const badgeState = await page
      .locator(OVERLAY)
      .evaluate((host) =>
        (host as HTMLElement).shadowRoot?.querySelector('.badge')?.getAttribute('data-state') ?? '',
      );
    expect(badgeState).toBe('no-verdict');
    await page.context().close();
  });

  it('does not read a missing verdict field as idle even with idle coverage fields', async () => {
    const missing = idleShaped();
    delete (missing as { verdict?: unknown }).verdict;
    const page = await mount(missing, { path: '/clusters' });
    expect(await bannerWord(page)).toBe('!No verdict');
    await page.context().close();
  });

  it('does not read a verified verdict with a nonzero exit code as clear', async () => {
    // An inconsistent projection: the verdict word says verified but the exit code the gate would use
    // is nonzero. The panel projects the verdict it was handed, so this still reads verified, but it
    // must never fall through to the idle branch and it must show the nonzero exit code plainly.
    const inconsistent = projectOverlay(
      result({ verdict: 'verified', summary: 'verified', findings: [], exitCode: 0 }),
    );
    (inconsistent as { exitCode: number }).exitCode = 4;
    const page = await mount(inconsistent, { path: '/clusters' });
    // Verified is the verdict it was handed, so it is projected, but the exit code is shown as is.
    expect(await bannerWord(page)).toBe('✓Verified');
    const panel = await openPanel(page);
    expect(await panel.locator('.banner-exit').textContent()).toBe('exit code 4');
    await page.context().close();
  });
});

describe('the overlay never shows a stale result', { timeout: 40_000 }, () => {
  it('ignores an older response that lands after a newer one', async () => {
    // Two refreshes overlap. The newer request asks second but answers first, and the older request
    // answers last carrying a verified result. Without a generation check the older, greener answer
    // wins and the panel says verified while the engine says regression. This is not theoretical:
    // the dev server replaces its single-flight wrapper on save while an older run is still going.
    const regression = projectOverlay(result());
    const staleVerified = projectOverlay(
      result({ verdict: 'verified', summary: 'verified: stale', findings: [], exitCode: 0 }),
    );

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    let served = 0;
    await page.route('http://usabl.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__usabl/result') {
        served += 1;
        if (served === 1) {
          // First load. Answer immediately so the panel settles before the race starts.
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(regression) });
          return;
        }
        if (served === 2) {
          // The older of the two racing requests. Verified, and deliberately slow.
          await new Promise((resolve) => setTimeout(resolve, 900));
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(staleVerified) });
          return;
        }
        // The newer request. Regression, and fast, so it lands first.
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(regression) });
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html lang="en">
            <head><title>Clean host</title></head>
            <body>
              <header><h1>Fleet operations</h1></header>
              <main><button id="cluster-details" type="button">Host action</button></main>
              <script type="module">${overlayClientSource}</script>
            </body>
          </html>`,
      });
    });
    await page.goto('http://usabl.test/clusters');
    await page.locator(OVERLAY).waitFor();
    const panel = await openPanel(page);
    await expect.poll(async () => bannerWord(page)).toBe('✕Regression');

    const recheck = panel.getByRole('button', { name: 'Check again' });
    await recheck.click();
    // The slow verified request is now in flight. Start the newer one on top of it.
    await recheck.click();

    await expect.poll(async () => bannerWord(page), { timeout: 10_000 }).toBe('✕Regression');
    // Wait past the slow response so a late overwrite would have had time to land.
    await expect
      .poll(async () => bannerWord(page), { timeout: 4000, interval: 250 })
      .toBe('✕Regression');
    expect(await panel.locator('.banner-exit').textContent()).toBe('exit code 1');

    await context.close();
  });

  it('drops an in-flight response the instant a newer refresh is requested', async () => {
    // This reproduces the out-of-order arrival without waiting for the recheck control to re-enable.
    // The first refresh is slow and verified. While it is still in flight, a second refresh is fired
    // by dispatching a click straight at the control, which does not depend on the control being
    // enabled. The second response is fast and regression. The fix advances the generation the moment
    // the second refresh is requested, so the slow verified response is already superseded when it
    // lands and can never render over the newer regression.
    const staleVerified = projectOverlay(
      result({ verdict: 'verified', summary: 'verified: stale', findings: [], exitCode: 0 }),
    );
    const regression = projectOverlay(result());

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    let served = 0;
    await page.route('http://usabl.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__usabl/result') {
        served += 1;
        if (served === 1) {
          // First load. Answer at once so the panel settles before the race.
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(regression) });
          return;
        }
        if (served === 2) {
          // The first refresh: slow and verified, the response we must NOT let win.
          await new Promise((resolve) => setTimeout(resolve, 900));
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(staleVerified) });
          return;
        }
        // The second refresh: fast and regression, requested while the first is still in flight.
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(regression) });
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html lang="en">
            <head><title>Clean host</title></head>
            <body>
              <header><h1>Fleet operations</h1></header>
              <main><button id="cluster-details" type="button">Host action</button></main>
              <script type="module">${overlayClientSource}</script>
            </body>
          </html>`,
      });
    });
    await page.goto('http://usabl.test/clusters');
    await page.locator(OVERLAY).waitFor();
    const panel = await openPanel(page);
    await expect.poll(async () => bannerWord(page)).toBe('✕Regression');

    const recheck = panel.getByRole('button', { name: 'Check again' });
    // Fire both refreshes back to back. dispatchEvent does not wait for the control to be enabled, so
    // the second click lands while the first slow request is still in flight.
    await recheck.dispatchEvent('click');
    await recheck.dispatchEvent('click');

    // The fast regression lands first and shows. Then wait well past the slow verified response so a
    // late overwrite would have had every chance to land. It must stay regression.
    await expect.poll(async () => bannerWord(page), { timeout: 10_000 }).toBe('✕Regression');
    await expect
      .poll(async () => bannerWord(page), { timeout: 4000, interval: 250 })
      .toBe('✕Regression');
    expect(await panel.locator('.banner-exit').textContent()).toBe('exit code 1');

    await context.close();
  });

  it('collapses a burst of refresh requests into one active and one queued', async () => {
    // The response is held long enough that all twelve presses below land while the first read is
    // still in flight. Each press is a driver round trip, so a short delay lets the tail of the burst
    // slip into the second read and queue a third, which would test timing rather than coalescing.
    const page = await mount(null, {
      path: '/clusters',
      responseDelayMs: 900,
      payloads: [projectOverlay(result())],
    });
    const panel = await openPanel(page);
    await expect.poll(async () => panel.locator('.finding-button').count()).toBe(2);

    const before = await page.evaluate(
      () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/__usabl/result')).length,
    );
    const recheck = panel.getByRole('button', { name: 'Check again' });
    for (let press = 0; press < 12; press += 1) {
      await recheck.dispatchEvent('click');
    }
    await expect.poll(async () => bannerWord(page), { timeout: 10_000 }).toBe('✕Regression');

    const after = await page.evaluate(
      () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/__usabl/result')).length,
    );
    // Twelve presses, at most one in flight plus one queued, so far fewer than twelve reads.
    expect(after - before).toBeLessThanOrEqual(2);
    expect(after - before).toBeGreaterThanOrEqual(1);

    await page.context().close();
  });
});

describe('the overlay does not hand the page easy levers', { timeout: 40_000 }, () => {
  it('captures fetch at load so a later swap cannot feed it a forged result', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    // Replace fetch AFTER the overlay has loaded, then make it re-read.
    await page.evaluate(() => {
      (window as unknown as { __usablForged: number }).__usablForged = 0;
      window.fetch = async () => {
        (window as unknown as { __usablForged: number }).__usablForged += 1;
        return new Response('{"verdict":"verified","exitCode":0}', { status: 200 });
      };
    });
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: 'Check again' }).click();
    await page.waitForTimeout(400);

    // The overlay used its own reference, so the forged fetch never ran and the verdict is unchanged.
    expect(await bannerWord(page)).toBe('✕Regression');
    expect(await page.evaluate(() => (window as unknown as { __usablForged: number }).__usablForged))
      .toBe(0);
    expect(await panel.getByText('This view may not be the real result').count()).toBe(0);

    await page.context().close();
  });

  it('says outright that it cannot vouch for a result when the page swapped fetch first', async () => {
    // A script that runs BEFORE the overlay wins the race, and no amount of capturing changes that
    // inside the page's own realm. What the overlay owes the developer in that case is to say it
    // cannot tell, rather than to present a result it has no way to stand behind.
    const page = await mount(projectOverlay(result()), {
      path: '/clusters',
      initScript: `
        window.fetch = async () => new Response(JSON.stringify({
          verdict: 'verified', exitCode: 0, findings: [], summary: 'forged',
          coverage: { affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true },
          receipt: null, dirtyGuardedPaths: [], paidDownCount: 0,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      `,
    });
    const panel = await openPanel(page);

    expect(
      await panel.getByRole('heading', { name: 'This view may not be the real result' }).isVisible(),
    ).toBe(true);
    expect(
      await panel
        .getByText('usabl cannot tell whether what you see below came from the engine.', { exact: false })
        .isVisible(),
    ).toBe(true);
    // The warning is the first thing in the panel body, above the verdict it qualifies.
    expect(
      await panel.locator('.panel-body > *').first().getAttribute('class'),
    ).toContain('tamper-notice');

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.context().close();
  });

  it('has no window event that lets the page force a re-read', async () => {
    const page = await mount(null, {
      path: '/clusters',
      payloads: [
        projectOverlay(result()),
        projectOverlay(result({ verdict: 'verified', findings: [], exitCode: 0 })),
      ],
    });
    const panel = await openPanel(page);
    await expect.poll(async () => bannerWord(page)).toBe('✕Regression');

    // The old testability hook. Dispatching it must do nothing at all.
    await page.evaluate(() => {
      for (const name of ['usabl:refresh', 'usabl:reload', 'usabl:check']) {
        window.dispatchEvent(new Event(name));
      }
    });
    await page.waitForTimeout(300);
    expect(await bannerWord(page)).toBe('✕Regression');

    // The control in the panel is the path that does work, and it is user driven.
    await panel.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(async () => bannerWord(page)).toBe('✓Verified');

    await page.context().close();
  });

  it('cannot be suppressed by a page that pre-creates the overlay host id', async () => {
    const page = await mount(projectOverlay(result()), {
      path: '/clusters',
      // The old fixed id. A page that squats on it used to make the overlay render into a node with
      // no shadow root, which threw and left the developer with no inspector and no warning.
      initScript: `
        document.addEventListener('DOMContentLoaded', () => {
          const squatter = document.createElement('div');
          squatter.id = '__usabl-overlay';
          document.body.appendChild(squatter);
        });
      `,
    });

    // The real inspector is present and correct beside the squatter.
    expect(await page.locator(OVERLAY).count()).toBe(1);
    expect(await badgeLabel(page)).toBe(
      'usabl: regression, 2 issues on this screen. Open inspector.',
    );
    const panel = await openPanel(page);
    expect(await panel.locator('.finding-button').count()).toBe(2);

    await page.context().close();
  });
});

describe('the overlay only touches what it owns', { timeout: 40_000 }, () => {
  it('refuses to locate an element that contains the inspector', async () => {
    // "body:has(...)" matches body itself. Locating used to scroll the whole document and put a
    // borrowed tabindex on body, which is a page-owned element the overlay has no business changing.
    const page = await mount(
      projectOverlay(
        result({ findings: [finding({ elementPath: 'body', elementName: 'the whole document' })] }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);
    await panel.locator('.finding-button').click();

    expect(await page.locator(HIGHLIGHT).count()).toBe(0);
    expect(
      await page.locator(OVERLAY).locator('.locate-status').textContent(),
    ).toContain('it is not on the page right now');

    await panel.getByRole('button', { name: 'Focus element' }).click();
    expect(await page.locator('body').getAttribute('tabindex')).toBeNull();

    await page.context().close();
  });

  it('leaves a page-owned tabindex exactly as it found it', async () => {
    const page = await mount(
      projectOverlay(
        result({ findings: [finding({ elementPath: '#plain-target', elementName: 'Plain paragraph' })] }),
      ),
      { path: '/clusters' },
    );
    // A second element the page owns, carrying the marker the old cleanup swept the document for.
    await page.evaluate(() => {
      const decoy = document.createElement('div');
      decoy.id = 'page-owned';
      decoy.setAttribute('tabindex', '-1');
      decoy.setAttribute('data-usabl-temp-tabindex', 'true');
      document.body.appendChild(decoy);
    });

    const panel = await openPanel(page);
    const row = panel.locator('.finding-button');
    await row.click();
    await panel.getByRole('button', { name: 'Focus element' }).click();
    await row.click();

    // The element we borrowed is restored, and the page's own element is untouched.
    expect(await page.locator('#plain-target').getAttribute('tabindex')).toBeNull();
    expect(await page.locator('#page-owned').getAttribute('tabindex')).toBe('-1');

    await page.context().close();
  });
});

describe('the elsewhere guide never links off site', { timeout: 40_000 }, () => {
  for (const hostile of ['//evil.example/x', '/\\evil.example/x', '//evil.example', '///evil.example/x']) {
    it(`refuses to build a link for ${hostile}`, async () => {
      // A pathname can begin with two slashes, which is a network-path reference: assigning it to an
      // href sends the developer off site. The path is still shown as text so they can judge it.
      const offsite = result({
        coverage: {
          changedFiles: ['src/app.tsx'],
          affected: [
            { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
            { screenId: 'jobs', url: `http://127.0.0.1:5173${hostile}`, provenance: 'route-graph' },
          ],
          unresolvedFiles: [],
          gaps: [],
          nothingToCheck: false,
        },
        findings: [
          finding({ screenId: 'clusters', whatUserExperiences: 'Clusters barrier.' }),
          finding({ screenId: 'jobs', rule: 'r-jobs', whatUserExperiences: 'Jobs barrier.' }),
        ],
      });
      const page = await mount(projectOverlay(offsite), { path: '/clusters' });
      const panel = await openPanel(page);
      const elsewhere = panel.locator('.elsewhere');

      const hrefs = await elsewhere
        .getByRole('link', { name: 'Go to this screen' })
        .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
      for (const href of hrefs) {
        expect(new URL(href).origin).toBe('http://usabl.test');
      }
      expect(hrefs).toHaveLength(0);
      expect(
        await elsewhere.getByText('No link: that path does not resolve to this site.').isVisible(),
      ).toBe(true);

      await page.context().close();
    });
  }

  it('still links a plain same-origin path', async () => {
    const page = await mount(
      projectOverlay(
        result({
          coverage: {
            changedFiles: ['src/app.tsx'],
            affected: [
              { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
              { screenId: 'jobs', url: 'http://127.0.0.1:5173/jobs', provenance: 'route-graph' },
            ],
            unresolvedFiles: [],
            gaps: [],
            nothingToCheck: false,
          },
          findings: [
            finding({ screenId: 'clusters', whatUserExperiences: 'Clusters barrier.' }),
            finding({ screenId: 'jobs', rule: 'r-jobs', whatUserExperiences: 'Jobs barrier.' }),
          ],
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);
    const href = await panel
      .getByRole('link', { name: 'Go to this screen' })
      .evaluate((link) => (link as HTMLAnchorElement).href);
    expect(href).toBe('http://usabl.test/jobs');

    await page.context().close();
  });
});

describe('the overlay announces state changes and stays visible on any host', { timeout: 40_000 }, () => {
  it('announces scan and verdict changes without repeating itself', async () => {
    const page = await mount(null, {
      path: '/clusters',
      responseDelayMs: 500,
      payloads: [
        projectOverlay(result()),
        projectOverlay(result({ verdict: 'verified', findings: [], exitCode: 0 })),
      ],
    });
    const host = page.locator(OVERLAY);
    const verdictStatus = host.locator('.visually-hidden[role="status"]');

    expect(await verdictStatus.getAttribute('aria-live')).toBe('polite');
    await expect.poll(async () => verdictStatus.textContent(), { timeout: 10_000 }).toBe(
      'usabl: Regression. 2 findings on this screen.',
    );

    const panel = await openPanel(page);
    // Opening and closing the panel is not a state change, so nothing is re-announced.
    await panel.getByRole('button', { name: 'Collapse the usabl inspector' }).click();
    await host.getByRole('button', { name: /Open inspector/i }).click();
    expect(await verdictStatus.textContent()).toBe('usabl: Regression. 2 findings on this screen.');

    await panel.getByRole('button', { name: 'Check again' }).click();
    await expect.poll(async () => verdictStatus.textContent()).toBe('usabl: Scanning.');
    await expect
      .poll(async () => verdictStatus.textContent(), { timeout: 10_000 })
      .toBe('usabl: Verified. No findings on this screen.');

    // It is a live region, not a visible duplicate of the banner.
    const box = await verdictStatus.boundingBox();
    expect(box?.width ?? 99).toBeLessThanOrEqual(2);

    await page.context().close();
  });

  it('keeps focus in the panel after Check again replaces the focused control', async () => {
    // Check again rerenders the header and replaces the recheck button, and the rebuilt button is
    // disabled while the scan runs. Without a deliberate move, focus drops to the document and a
    // keyboard user loses their place. Focus must land on the panel, a stable region always present.
    const page = await mount(null, {
      path: '/clusters',
      responseDelayMs: 400,
      payloads: [
        projectOverlay(result()),
        projectOverlay(result({ verdict: 'verified', findings: [], exitCode: 0 })),
      ],
    });
    const host = page.locator(OVERLAY);
    const panel = await openPanel(page);
    await expect.poll(async () => panel.locator('.finding-button').count()).toBe(2);

    const recheck = panel.getByRole('button', { name: 'Check again' });
    await recheck.focus();
    await recheck.click();

    // The rebuilt recheck button is disabled while scanning, so focus cannot rest there. It moved to
    // the panel, not to the document body.
    const focusedClass = await host.evaluate(
      (element) => (element as HTMLElement).shadowRoot?.activeElement?.className ?? '',
    );
    expect(focusedClass).toContain('panel');
    expect(focusedClass).not.toContain('finding-button');

    await page.context().close();
  });

  it('keeps the verdict live region in the accessibility tree while collapsed', async () => {
    // The overlay is collapsed by default, which is the normal state during a fix loop. The verdict
    // live region must not sit inside the hidden panel, because a live region in a hidden subtree is
    // not in the accessibility tree and its updates are never announced. It must be outside the
    // panel and reachable while collapsed.
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator(OVERLAY);

    // The panel is hidden while collapsed.
    const panelHidden = await host.evaluate(
      (element) =>
        (element as HTMLElement).shadowRoot?.querySelector('.panel')?.hasAttribute('hidden') ?? false,
    );
    expect(panelHidden).toBe(true);

    const placement = await host.evaluate((element) => {
      const root = (element as HTMLElement).shadowRoot;
      const region = root?.querySelector('.visually-hidden[role="status"]');
      if (!region) {
        return { present: false, insidePanel: true, insideHiddenSubtree: true };
      }
      const insidePanel = region.closest('.panel') !== null;
      // Walk up to the shadow root, checking whether any ancestor is hidden. If none is, the region
      // is in the accessibility tree.
      let node: Element | null = region;
      let insideHiddenSubtree = false;
      while (node && node !== (root as unknown as Element)) {
        if (node.hasAttribute('hidden')) {
          insideHiddenSubtree = true;
          break;
        }
        node = node.parentElement;
      }
      return { present: true, insidePanel, insideHiddenSubtree };
    });
    expect(placement.present).toBe(true);
    expect(placement.insidePanel).toBe(false);
    expect(placement.insideHiddenSubtree).toBe(false);

    // And it actually carries the announcement while collapsed.
    const verdictStatus = host.locator('.visually-hidden[role="status"]');
    await expect.poll(async () => verdictStatus.textContent(), { timeout: 10_000 }).toBe(
      'usabl: Regression. 2 findings on this screen.',
    );

    await page.context().close();
  });

  it('keeps the badge focus ring visible against a dark host page', async () => {
    // The ring used to be a single dark colour, so on a host page painted the same dark colour it
    // sat at 1:1 contrast and vanished. The earlier focus test only ever used a white page.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.route('http://usabl.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__usabl/result') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(projectOverlay(result())),
        });
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html lang="en">
            <head><title>Dark host</title>
              <style>body { background: #101827; color: #ffffff; margin: 0; min-height: 100vh; }</style>
            </head>
            <body>
              <header><h1>Fleet operations</h1></header>
              <main><button id="cluster-details" type="button">Host action</button></main>
              <script type="module">${overlayClientSource}</script>
            </body>
          </html>`,
      });
    });
    await page.goto('http://usabl.test/clusters');
    await page.locator(OVERLAY).waitFor();

    // Tab through the host page's own controls until focus reaches the badge.
    const readFocus = async () =>
      page.locator(OVERLAY).evaluate(
        (element) => (element as HTMLElement).shadowRoot?.activeElement?.className ?? '',
      );
    for (let step = 0; step < 6 && !(await readFocus()).includes('badge'); step += 1) {
      await page.keyboard.press('Tab');
    }

    const ring = await page.locator(OVERLAY).evaluate((element) => {
      const active = (element as HTMLElement).shadowRoot?.activeElement;
      if (!active) return null;
      const style = getComputedStyle(active);
      return {
        focused: active.className,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });

    expect(ring?.focused).toContain('badge');
    // A white inner ring against the dark host, plus a dark outer ring so the edge is visible on
    // light content too. One of the two always contrasts.
    expect(ring?.outlineColor).toBe('rgb(255, 255, 255)');
    expect(parseFloat(ring?.outlineWidth ?? '0')).toBeGreaterThanOrEqual(2);
    expect(ring?.boxShadow).toContain('rgb(16, 24, 39)');
    expect(ring?.boxShadow).toContain('rgb(255, 255, 255)');

    await context.close();
  });
});

describe('the overlay bounds its own work', { timeout: 60_000 }, () => {
  const manyFindings = (count: number, titleLength = 40) =>
    Array.from({ length: count }, (_, index) =>
      finding({
        rule: `rule-${index}`,
        elementPath: `#target-${index}`,
        whatUserExperiences: `Finding ${index}: ${'x'.repeat(titleLength)}`,
      }),
    );

  it('builds a bounded page of rows while still reporting the true total', async () => {
    const page = await mount(projectOverlay(result({ findings: manyFindings(500) })), {
      path: '/clusters',
    });
    const panel = await openPanel(page);

    // Bounded in the DOM.
    expect(await panel.locator('.finding-button').count()).toBe(40);
    // Truthful in what it reports. Bounding what is BUILT never changes what is COUNTED.
    expect(await panel.getByText('500 issues total').isVisible()).toBe(true);
    expect(await panel.getByText('Showing 40 of 500 findings on this screen.').isVisible()).toBe(true);
    expect(await panel.locator('.screen-counts').textContent()).toBe('500 here · 0 on other screens');

    // Each row says where it sits in the whole list, not in the part that happens to be built.
    const positions = await panel
      .locator('.finding-item')
      .evaluateAll((items) =>
        items.slice(0, 2).map((item) => ({
          size: item.getAttribute('aria-setsize'),
          position: item.getAttribute('aria-posinset'),
        })),
      );
    expect(positions).toEqual([
      { size: '500', position: '1' },
      { size: '500', position: '2' },
    ]);

    await panel.getByRole('button', { name: 'Show 40 more' }).click();
    expect(await panel.locator('.finding-button').count()).toBe(80);
    expect(await panel.getByText('Showing 80 of 500 findings on this screen.').isVisible()).toBe(true);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.context().close();
  });

  it('moves focus to the FIRST row of the final page, not the last', async () => {
    // 60 findings: the first page builds 40 and the final "Show 20 more" appends the rest and hides
    // the control. Focus must land on the first row of that final page (row 41 of the whole list) so
    // a forward Tab walks the new rows in order. Landing on the last row would let Tab skip every row
    // between the old end and it, exactly the rows the user just asked to see.
    const page = await mount(projectOverlay(result({ findings: manyFindings(60) })), {
      path: '/clusters',
    });
    const panel = await openPanel(page);
    expect(await panel.locator('.finding-button').count()).toBe(40);

    await panel.getByRole('button', { name: 'Show 20 more' }).click();
    expect(await panel.locator('.finding-button').count()).toBe(60);

    // The control is gone, so focus was moved. Read which row holds it and its position in the list.
    const focused = await page.locator(OVERLAY).evaluate((host) => {
      const root = (host as HTMLElement).shadowRoot;
      const active = root?.activeElement as HTMLElement | null;
      if (!active || !active.classList.contains('finding-button')) {
        return { onRow: false, posinset: null as string | null };
      }
      const item = active.closest('.finding-item');
      return { onRow: true, posinset: item?.getAttribute('aria-posinset') ?? null };
    });
    expect(focused.onRow).toBe(true);
    // First row of the final page. The first page was 40 rows, so the final page starts at position 41.
    expect(focused.posinset).toBe('41');

    await page.context().close();
  });

  it('keeps a large result under control in nodes and in time', async () => {
    const started = Date.now();
    const page = await mount(projectOverlay(result({ findings: manyFindings(3000, 1000) })), {
      path: '/clusters',
    });
    const panel = await openPanel(page);
    const elapsed = Date.now() - started;

    const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
    const shadowNodes = await page
      .locator(OVERLAY)
      .evaluate((host) => (host as HTMLElement).shadowRoot?.querySelectorAll('*').length ?? 0);

    expect(await panel.getByText('3000 issues total').isVisible()).toBe(true);
    // Forty rows with no detail bodies built, so a few hundred nodes, not sixty thousand.
    expect(shadowNodes).toBeLessThan(1500);
    expect(nodes).toBeLessThan(2000);
    expect(elapsed).toBeLessThan(10_000);

    await page.context().close();
  });

  it('builds a detail body only for the row that is open', async () => {
    const page = await mount(projectOverlay(result({ findings: manyFindings(40) })), {
      path: '/clusters',
    });
    const panel = await openPanel(page);

    // Forty rows exist, and not one detail body has been built.
    expect(await panel.locator('.finding-button').count()).toBe(40);
    expect(await panel.locator('.detail-action').count()).toBe(0);

    await panel.locator('.finding-button').first().click();
    expect(await panel.locator('.finding-detail:not([hidden]) .detail-action').count()).toBe(2);
    // Only the open row has one.
    expect(await panel.locator('.detail-action').count()).toBe(2);

    await panel.locator('.finding-button').nth(1).click();
    // The first row's body stays built but hidden, and the second one is built on demand.
    expect(await panel.locator('.finding-detail:not([hidden])').count()).toBe(1);

    await page.context().close();
  });

  it('shortens an enormous field and says that it did', async () => {
    const huge = 'y'.repeat(200_000);
    const page = await mount(
      projectOverlay(
        result({
          findings: [finding({ whatUserExperiences: huge, why: huge, elementPath: `#a${huge}` })],
        }),
      ),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);

    const title = await panel.locator('.finding-title').textContent();
    expect(title?.length ?? 0).toBeLessThan(2100);
    expect(title).toContain('[shortened for display]');

    await panel.locator('.finding-button').click();
    const why = await panel.locator('.detail-block p').first().textContent();
    expect(why?.length ?? 0).toBeLessThan(2100);
    expect(why).toContain('[shortened for display]');

    await page.context().close();
  });
});

describe('the overlay moves out of the way of the element it points at', { timeout: 40_000 }, () => {
  // A host page with the flagged element pinned to a corner, so a test can place the target under the
  // panel and prove the panel dodges. The finding's selector points at that element.
  async function mountWithTarget(options: {
    targetCss: string;
    reducedMotion?: boolean;
    dockSeed?: string;
  }): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(options.reducedMotion ? { reducedMotion: 'reduce' } : {}),
    });
    const page = await context.newPage();
    if (options.dockSeed !== undefined) {
      await context.addInitScript(
        `try { localStorage.setItem('usabl.overlay.dock', ${JSON.stringify(options.dockSeed)}); } catch (e) {}
         try { localStorage.setItem('usabl.overlay.open', '1'); } catch (e) {}`,
      );
    } else {
      await context.addInitScript(
        `try { localStorage.setItem('usabl.overlay.open', '1'); } catch (e) {}`,
      );
    }
    const projection = projectOverlay(
      result({
        findings: [
          finding({
            elementPath: '#corner-target',
            elementName: 'Corner control',
            whatUserExperiences: 'A control in the corner.',
          }),
        ],
      }),
    );
    await page.route('http://usabl.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__usabl/result') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(projection) });
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html lang="en">
            <head><title>Corner host</title>
              <style>#corner-target { position: fixed; width: 160px; height: 60px; ${options.targetCss} }</style>
            </head>
            <body>
              <header><h1>Fleet operations</h1></header>
              <main>
                <button id="corner-target" type="button">Corner control</button>
              </main>
              <script type="module">${overlayClientSource}</script>
            </body>
          </html>`,
      });
    });
    await page.goto('http://usabl.test/clusters');
    await page.locator(OVERLAY).waitFor();
    return page;
  }

  // Read which corner the host is docked to from its inline insets.
  async function dockCorner(page: Page): Promise<string> {
    return page.locator(OVERLAY).evaluate((host) => {
      const style = (host as HTMLElement).style;
      const top = style.top !== 'auto' && style.top !== '';
      const left = style.left !== 'auto' && style.left !== '';
      return (top ? 'top' : 'bottom') + '-' + (left ? 'left' : 'right');
    });
  }

  it('auto-dodges to another corner when the panel covers the target', async () => {
    // The panel docks bottom-right by default. Put the target in the bottom-right corner so the panel
    // covers it, then ask to show it. The panel must move to a corner that does not overlap it.
    const page = await mountWithTarget({
      targetCss: 'right: 20px; bottom: 20px;',
      reducedMotion: true,
    });
    const host = page.locator(OVERLAY);
    const panel = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await panel.isVisible()).toBe(true);
    expect(await dockCorner(page)).toBe('bottom-right');

    // Confirm the panel and the target actually overlap at the start.
    const overlapsBefore = await host.evaluate((h) => {
      const panelEl = (h as HTMLElement).shadowRoot?.querySelector('.panel');
      const target = document.querySelector('#corner-target');
      if (!panelEl || !target) return false;
      const a = panelEl.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
    expect(overlapsBefore).toBe(true);

    await panel.locator('.finding-button').click();
    await panel.getByRole('button', { name: 'Show on page again' }).click();

    // The panel moved off the bottom-right corner.
    await expect.poll(async () => dockCorner(page)).not.toBe('bottom-right');

    // And it no longer overlaps the target.
    const overlapsAfter = await host.evaluate((h) => {
      const panelEl = (h as HTMLElement).shadowRoot?.querySelector('.panel');
      const target = document.querySelector('#corner-target');
      if (!panelEl || !target) return true;
      const a = panelEl.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
    expect(overlapsAfter).toBe(false);

    await context0(page);
  });

  it('leaves the panel where it is when the target does not overlap it', async () => {
    // A target in the top-left corner is nowhere near the bottom-right panel, so nothing moves.
    const page = await mountWithTarget({
      targetCss: 'left: 20px; top: 80px;',
      reducedMotion: true,
    });
    const panel = page
      .locator(OVERLAY)
      .getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await dockCorner(page)).toBe('bottom-right');

    await panel.locator('.finding-button').click();
    await panel.getByRole('button', { name: 'Show on page again' }).click();
    await page.waitForTimeout(200);

    expect(await dockCorner(page)).toBe('bottom-right');

    await context0(page);
  });

  it('moves and persists the dock with the manual control', async () => {
    const page = await mountWithTarget({ targetCss: 'left: 20px; top: 80px;', reducedMotion: true });
    const host = page.locator(OVERLAY);
    const panel = host.getByRole('region', { name: 'usabl accessibility inspector' });

    expect(await dockCorner(page)).toBe('bottom-right');
    const dock = panel.getByRole('button', { name: /^Move panel\./ });
    // The accessible name states where the panel is now, so the control is not meaning by icon alone.
    expect(await dock.getAttribute('aria-label')).toBe('Move panel. Now at bottom right.');

    await dock.click();
    const afterOne = await dockCorner(page);
    expect(afterOne).not.toBe('bottom-right');
    // The stored value matches the new corner.
    const stored = await page.evaluate(() => localStorage.getItem('usabl.overlay.dock'));
    expect(stored).toBe(afterOne);

    // The choice survives a reload.
    await page.reload();
    await host.waitFor();
    expect(await dockCorner(page)).toBe(afterOne);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await context0(page);
  });

  // Shared by the two geometry tests: does the open panel overlap the corner target right now.
  async function panelOverlapsTarget(page: Page): Promise<boolean> {
    return page.locator(OVERLAY).evaluate((h) => {
      const panelEl = (h as HTMLElement).shadowRoot?.querySelector('.panel');
      const target = document.querySelector('#corner-target');
      if (!panelEl || !target) return true;
      const a = panelEl.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
  }

  it('judges corners with the real 12px inset, not flush to the edge', async () => {
    // The panel is 420px wide and sits 12px in, so docked left it spans 12..432. A target that starts
    // at 421 overlaps that band. A candidate drawn flush to the edge, 0..420, reads clear and the
    // panel lands on top of the target anyway. The right corners, 848..1268, are truly clear.
    const page = await mountWithTarget({
      targetCss: 'left: 421px; top: 0; width: 279px; height: 100vh;',
      reducedMotion: true,
      dockSeed: 'top-left',
    });
    const panel = page.locator(OVERLAY).getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await dockCorner(page)).toBe('top-left');
    expect(await panelOverlapsTarget(page)).toBe(true);

    await panel.locator('.finding-button').click();
    await panel.getByRole('button', { name: 'Show on page again' }).click();

    await expect.poll(async () => dockCorner(page)).toMatch(/-right$/);
    expect(await panelOverlapsTarget(page)).toBe(false);
    expect(await page.locator(OVERLAY).locator('.locate-status').textContent()).toBe(
      'Highlighted Corner control on the page.',
    );

    await context0(page);
  });

  it('stays put and says so when every corner would still cover the target', async () => {
    // 421..901 across the full height: the left corners end at 432 and the right corners start at
    // 848, so no corner is clear. Moving would be no better, so the panel stays and the status says
    // why the element is still partly covered.
    const page = await mountWithTarget({
      targetCss: 'left: 421px; top: 0; width: 480px; height: 100vh;',
      reducedMotion: true,
      dockSeed: 'top-left',
    });
    const host = page.locator(OVERLAY);
    const panel = host.getByRole('region', { name: 'usabl accessibility inspector' });

    await panel.locator('.finding-button').click();
    await panel.getByRole('button', { name: 'Show on page again' }).click();
    await page.waitForTimeout(150);

    expect(await dockCorner(page)).toBe('top-left');
    const status = await host.locator('.locate-status').textContent();
    expect(status).toContain('Highlighted Corner control on the page.');
    expect(status).toContain('no corner is clear');

    // Focus element says the same, because it dodges the same way.
    await panel.getByRole('button', { name: 'Focus element' }).click();
    const focusStatus = await host.locator('.locate-status').textContent();
    expect(focusStatus).toContain('Keyboard focus moved to Corner control.');
    expect(focusStatus).toContain('no corner is clear');

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await context0(page);
  });

  it('waits for a smooth scroll to finish before judging the corners', async () => {
    // Standard motion. The target sits far below the fold and is large, so after the smooth scroll
    // centres it, it covers the band every corner would occupy. Judging the corners two frames into
    // the scroll read the target's starting position, found the panel clear, and never warned. The
    // dodge must run once the scroll has settled, and the blocked sentence must be announced exactly
    // once, for the row activation and again exactly once for Focus element.
    const page = await mountWithTarget({
      targetCss: 'position: absolute; left: 421px; top: 2400px; width: 480px; height: 700px;',
      dockSeed: 'top-left',
    });
    const host = page.locator(OVERLAY);
    const panel = host.getByRole('region', { name: 'usabl accessibility inspector' });
    const status = host.locator('.locate-status');
    const blockedCount = (text: string | null): number => (text ?? '').split('no corner is clear').length - 1;

    await panel.locator('.finding-button').click();
    await expect.poll(async () => blockedCount(await status.textContent()), { timeout: 5000 }).toBe(1);
    // It settled: the sentence is not repeated on later frames, and the panel is still docked.
    await page.waitForTimeout(400);
    const highlightStatus = await status.textContent();
    expect(blockedCount(highlightStatus)).toBe(1);
    expect(highlightStatus).toContain('Highlighted Corner control on the page.');
    // The panel could not move, so the final geometry is either clear or blocked and announced.
    const overlap = await panelOverlapsTarget(page);
    expect(overlap === false || blockedCount(highlightStatus) === 1).toBe(true);

    await panel.getByRole('button', { name: 'Focus element' }).click();
    await expect
      .poll(async () => {
        const text = await status.textContent();
        return (text ?? '').includes('Keyboard focus moved to Corner control.') && blockedCount(text) === 1;
      }, { timeout: 5000 })
      .toBe(true);
    await page.waitForTimeout(400);
    expect(blockedCount(await status.textContent())).toBe(1);

    await context0(page);
  });

  it('keeps the host click-through with only the panel taking pointer events after a dock move', async () => {
    const page = await mountWithTarget({ targetCss: 'left: 20px; top: 80px;', reducedMotion: true });
    const host = page.locator(OVERLAY);
    const panel = host.getByRole('region', { name: 'usabl accessibility inspector' });
    await panel.getByRole('button', { name: /^Move panel\./ }).click();

    const pointerEvents = await host.evaluate((element) => ({
      host: getComputedStyle(element).pointerEvents,
      panel: getComputedStyle(
        (element as HTMLElement).shadowRoot?.querySelector('.panel') as Element,
      ).pointerEvents,
    }));
    expect(pointerEvents.host).toBe('none');
    expect(pointerEvents.panel).toBe('auto');

    await context0(page);
  });
});

async function context0(page: Page): Promise<void> {
  await page.context().close();
}
