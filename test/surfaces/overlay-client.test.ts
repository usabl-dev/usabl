import AxeBuilder from '@axe-core/playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { Finding, Result } from '../../src/contracts/index.js';
import { overlayClientSource } from '../../src/surfaces/overlay-client.js';
import { projectOverlay } from '../../src/surfaces/vite-plugin.js';

let browser: Browser;

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
    await page.locator('#__usabl-overlay').waitFor({ timeout: 2000 });
  } catch {
    throw new Error(`inspector host was not created: ${pageErrors.join(' | ') || 'no page error reported'}`);
  }
  return page;
}

/** Opens the panel from the collapsed badge and returns the panel region locator. */
async function openPanel(page: Page) {
  const host = page.locator('#__usabl-overlay');
  await host.getByRole('button', { name: /Open inspector/i }).click();
  return host.getByRole('region', { name: 'usabl accessibility inspector' });
}

/** The keys of every row whose disclosure is open, read straight off the DOM. */
async function expandedRowTitles(page: Page): Promise<string[]> {
  return page.locator('#__usabl-overlay').evaluate((host) => {
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
    const host = page.locator('#__usabl-overlay');

    const badge = host.getByRole('button', {
      name: 'usabl: regression, 2 issues on this screen. Open inspector.',
    });
    expect(await badge.count()).toBe(1);
    // The verdict symbol and the count are the only visible text, so the badge stays out of the way.
    expect((await badge.textContent())?.trim()).toBe('✕2');

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
    const host = page.locator('#__usabl-overlay');
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
    const host = page.locator('#__usabl-overlay');
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
    expect(await page.locator('#__usabl-highlight').isVisible()).toBe(true);
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
    expect(await page.locator('#__usabl-highlight').count()).toBe(1);
    expect(await host.getByText('Highlighted Close dialog on the page.').isVisible()).toBe(true);

    // Activating the open row again closes it and takes the highlight away with it.
    await secondRow.click();
    expect(await expandedRowTitles(page)).toEqual([]);
    expect(await page.locator('#__usabl-highlight').count()).toBe(0);

    await page.context().close();
  });

  it('opens a row from the keyboard with Enter and with Space', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const panel = await openPanel(page);
    const firstRow = panel.getByRole('button', { name: /Focus stays behind the dialog/i });

    await firstRow.focus();
    await page.keyboard.press('Enter');
    expect(await firstRow.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#__usabl-highlight').count()).toBe(1);

    await page.keyboard.press(' ');
    expect(await firstRow.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#__usabl-highlight').count()).toBe(0);

    await page.context().close();
  });

  it('re-highlights on request and moves real focus only when asked', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: /Focus stays behind the dialog/i }).click();

    await panel.getByRole('button', { name: 'Show on page again' }).click();
    expect(await page.locator('#__usabl-highlight').count()).toBe(1);

    await panel.getByRole('button', { name: 'Focus element' }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('cluster-details');
    expect(
      await page.locator('#__usabl-overlay').getByText('Keyboard focus moved to View cluster details.').isVisible(),
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
    const host = page.locator('#__usabl-overlay');
    const panel = await openPanel(page);
    const row = panel.getByRole('button', { name: /Focus stays behind the dialog/i });

    await row.click();

    // The row still opens, so the developer can read the fix even when the element is gone.
    expect(await row.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#__usabl-highlight').count()).toBe(0);

    const status = host.getByRole('status');
    expect(await status.getAttribute('aria-live')).toBe('polite');
    expect(await status.textContent()).toContain(
      'This was flagged here at the last scan; it is not on the page right now.',
    );
    expect(await status.textContent()).toContain('#gone-since-scan');

    // Both explicit buttons report the same honest status rather than claiming success.
    await panel.getByRole('button', { name: 'Show on page again' }).click();
    expect(await page.locator('#__usabl-highlight').count()).toBe(0);
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
  return page.locator('#__usabl-overlay').evaluate(
    (host) =>
      (host as HTMLElement).shadowRoot?.querySelector('.badge')?.getAttribute('aria-label') ?? '',
  );
}

async function bannerWord(page: Page): Promise<string> {
  return page.locator('#__usabl-overlay').evaluate(
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
    expect(await page.locator('#__usabl-highlight').count()).toBe(1);

    // The developer saved a fix, so the dev server publishes a new result.
    await page.evaluate(() => window.dispatchEvent(new Event('usabl:refresh')));

    await expect.poll(async () => panel.locator('.finding-button').count()).toBe(0);
    // The row that no longer exists is neither expanded nor highlighted.
    expect(await expandedRowTitles(page)).toEqual([]);
    expect(await page.locator('#__usabl-highlight').count()).toBe(0);

    await expect.poll(async () => bannerWord(page)).toBe('✓Verified');
    expect(await panel.getByText('exit code 0').isVisible()).toBe(true);
    expect(await panel.getByText('0 here · 0 on other screens').isVisible()).toBe(true);
    expect(await badgeLabel(page)).toBe('usabl: no issues on this screen. Open inspector.');
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

    await page.evaluate(() => window.dispatchEvent(new Event('usabl:refresh')));

    await expect.poll(async () => panel.locator('.finding-button').count()).toBe(1);
    expect(await expandedRowTitles(page)).toEqual(['Focus stays behind the dialog when it opens.']);
    expect(await page.locator('#__usabl-highlight').count()).toBe(1);

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

    await page.evaluate(() => window.dispatchEvent(new Event('usabl:refresh')));

    await expect.poll(async () => bannerWord(page)).toBe('…Scanning');
    // The previous result stays on screen while the new scan runs, so the panel does not flicker.
    expect(await panel.locator('.finding-button').count()).toBe(2);

    await expect.poll(async () => bannerWord(page), { timeout: 10_000 }).toBe('✓Verified');

    await page.context().close();
  });
});

describe('overlay preferences', { timeout: 30_000 }, () => {
  it('reopens in the state it was left in', async () => {
    const page = await mount(projectOverlay(result()), {
      path: '/clusters',
      initScript: "window.localStorage.setItem('usabl.overlay.open', '1');",
    });
    const host = page.locator('#__usabl-overlay');

    const panel = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await panel.isVisible()).toBe(true);
    expect(await host.locator('.badge').isHidden()).toBe(true);

    await page.context().close();
  });

  it('remembers the wide setting across a reload and reports it with aria-pressed', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator('#__usabl-overlay');
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
    const host = page.locator('#__usabl-overlay');

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
    const host = page.locator('#__usabl-overlay');
    expect(await badgeLabel(page)).toBe('usabl: this screen was not scanned. Open inspector.');

    const panel = await openPanel(page);
    expect(
      await panel
        .getByText('This screen was not part of the last scan, so usabl has nothing to report on it.')
        .isVisible(),
    ).toBe(true);
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
    expect(await page.locator('#__usabl-highlight').count()).toBe(1);

    await page.evaluate(() => history.pushState({}, '', '/deployments'));
    await expect.poll(async () => panel.getByText('Deployments barrier.').count()).toBe(1);
    expect(await panel.getByText('Clusters barrier.').count()).toBe(0);
    expect(await page.locator('#__usabl-highlight').count()).toBe(0);
    expect(await expandedRowTitles(page)).toEqual([]);

    await page.evaluate(() => history.pushState({}, '', '/clusters'));
    await page.goBack();
    await expect.poll(async () => panel.getByText('Deployments barrier.').count()).toBe(1);

    await page.context().close();
  });
});

describe('overlay states', { timeout: 30_000 }, () => {
  it('names the scanning state on the badge before the first result arrives', async () => {
    const page = await mount(projectOverlay(result()), { responseDelayMs: 1000 });
    expect(await badgeLabel(page)).toBe('usabl: scanning. Open inspector.');
    await page.context().close();
  });

  it('says nothing was checked when the run had nothing to check', async () => {
    const page = await mount(
      projectOverlay(result({ verdict: null, summary: 'nothing to check', findings: [], exitCode: 0 })),
      { path: '/clusters' },
    );
    const panel = await openPanel(page);

    expect(await bannerWord(page)).toBe('○Nothing to check');
    expect(await panel.getByText('No findings on this screen.', { exact: true }).isVisible()).toBe(true);
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
    expect(
      await panel
        .getByText('A guarded file changed. A person has to approve that change before the gate can pass.')
        .isVisible(),
    ).toBe(true);
    expect(await panel.getByRole('heading', { name: 'Guarded paths awaiting review' }).isVisible()).toBe(true);
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

describe('the overlay is itself accessible and read only', { timeout: 30_000 }, () => {
  it('never treats page text as HTML and never shows the untrusted frame markers', async () => {
    const hostile = finding({
      whatUserExperiences: '<img src=x onerror="window.__usablXss=1">markup impact',
      elementName: '<b>evil</b>',
      elementPath: '#cluster-details',
    });
    const page = await mount(projectOverlay(result({ findings: [hostile] })), { path: '/clusters' });
    const host = page.locator('#__usabl-overlay');
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
    expect(await page.locator('#__usabl-overlay img').count()).toBe(0);

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
    const host = page.locator('#__usabl-overlay');

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
    const host = page.locator('#__usabl-overlay');
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
