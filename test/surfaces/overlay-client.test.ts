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

async function mount(
  payload: ReturnType<typeof projectOverlay> | null,
  options: {
    viewport?: { width: number; height: number };
    responseDelayMs?: number;
    path?: string;
  } = {},
): Promise<Page> {
  const viewport = options.viewport ?? { width: 1280, height: 900 };
  const responseDelayMs = options.responseDelayMs ?? 0;
  // The path the browser opens. The overlay partitions findings by the live pathname, so a screen's
  // findings only appear as "this screen" when the browser is on that screen's path.
  const path = options.path ?? '/';
  const context = await browser.newContext({ viewport });
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
      if (payload === null) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'unavailable' });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
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
  await page.goto('http://usabl.test' + path);
  try {
    await page.locator('#__usabl-overlay').waitFor({ timeout: 2000 });
  } catch {
    throw new Error(`inspector host was not created: ${pageErrors.join(' | ') || 'no page error reported'}`);
  }
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  if (browser) {
    await browser.close();
  }
});

describe('overlay browser client', { timeout: 20_000 }, () => {
  it('shows only the current screen findings, individually, and returns focus on Escape', async () => {
    // Browser is on /clusters, which matches the scanned "clusters" screen by pathname.
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator('#__usabl-overlay');
    const toggle = host.getByRole('button', { name: /Open usabl inspector.*regression.*2 findings/i });

    expect(await toggle.count()).toBe(1);
    await toggle.click();

    const inspector = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await inspector.isVisible()).toBe(true);
    expect(await inspector.getByRole('heading', { name: 'This screen' }).isVisible()).toBe(true);

    // Both current-screen findings are listed individually as their own buttons.
    const firstRow = inspector.getByRole('button', {
      name: /Focus stays behind the dialog when it opens\..*find this on the page/i,
    });
    const secondRow = inspector.getByRole('button', {
      name: /Focus does not return to the trigger.*find this on the page/i,
    });
    expect(await firstRow.count()).toBe(1);
    expect(await secondRow.count()).toBe(1);

    // The fix hint is shown inline on the row without opening any detail pane.
    expect(await inspector.getByText('Move focus into the dialog when it opens.').isVisible()).toBe(true);
    expect(await inspector.getByText('pf-focus-into-dialog', { exact: false }).first().isVisible()).toBe(true);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.keyboard.press('Escape');
    expect(await inspector.isHidden()).toBe(true);
    expect(
      await toggle.evaluate((element) => {
        const root = element.getRootNode();
        return root instanceof ShadowRoot && root.activeElement === element;
      }),
    ).toBe(true);

    await page.context().close();
  });

  it('shows a calm message when the live path matches no scanned screen', async () => {
    // Browser is on /, which matches no scanned screen (the only scanned screen is /clusters).
    const page = await mount(projectOverlay(result()), { path: '/' });
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    const inspector = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await inspector.getByText('This screen was not part of the last scan.').isVisible()).toBe(true);
    // No current-screen finding buttons are rendered.
    expect(await inspector.getByRole('button', { name: /find this on the page/i }).count()).toBe(0);

    await page.context().close();
  });

  it('normalizes trailing slash and ignores host and port when matching the current screen', async () => {
    // Scan-time url is http://127.0.0.1:5173/clusters. The browser is on a different host and port
    // and a trailing slash, and it must still match by pathname alone.
    const page = await mount(projectOverlay(result()), { path: '/clusters/' });
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    const inspector = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await inspector.getByText('This screen was not part of the last scan.').count()).toBe(0);
    expect(
      await inspector.getByRole('button', { name: /find this on the page/i }).count(),
    ).toBe(2);

    await page.context().close();
  });

  it('locates a finding by clicking its row, moving focus to the element', async () => {
    const page = await mount(projectOverlay(result()), { path: '/clusters' });
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    const row = host.getByRole('button', {
      name: /Focus stays behind the dialog when it opens\..*find this on the page/i,
    });
    await row.click();

    const marker = page.locator('#__usabl-highlight');
    expect(await marker.isVisible()).toBe(true);
    expect(await marker.getAttribute('aria-hidden')).toBe('true');
    expect(await marker.textContent()).toContain('Accessibility problem');
    expect(await host.getByText('Highlighted View cluster details on the page.').isVisible()).toBe(true);

    // Keyboard focus moved to the flagged element on the page, not just a visual highlight.
    const focusedId = await page.evaluate(() => document.activeElement && document.activeElement.id);
    expect(focusedId).toBe('cluster-details');

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    // A route change clears the highlight, because the located element belonged to the screen we
    // just left. Focus is now on the page element, so this exercises the navigation cleanup path.
    await page.evaluate(() => history.pushState({}, '', '/somewhere-else'));
    await expect.poll(async () => marker.count()).toBe(0);

    await page.context().close();
  });

  it('reports a stale finding without changing the page and shows the selector', async () => {
    const page = await mount(
      projectOverlay(result({ findings: [finding({ elementPath: '#gone-since-scan' })] })),
      { path: '/clusters' },
    );
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    await host.getByRole('button', { name: /find this on the page/i }).click();

    expect(await page.locator('#__usabl-highlight').count()).toBe(0);
    expect(
      await host
        .getByText('This was flagged here at the last scan; it is not on the page right now.')
        .isVisible(),
    ).toBe(true);
    // The selector that was flagged is shown so the developer can see what to look for.
    expect(await host.getByText('#gone-since-scan', { exact: false }).isVisible()).toBe(true);

    await page.context().close();
  });

  it('guides to other screens with counts and navigating links, without listing their findings', async () => {
    const withOtherScreens = result({
      summary: 'regression: 3 gating findings',
      coverage: {
        changedFiles: ['src/app.tsx'],
        affected: [
          { screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'route-graph' },
          { screenId: 'deployments', url: 'http://127.0.0.1:5173/deployments', provenance: 'route-graph' },
          { screenId: 'jobs', url: 'http://127.0.0.1:5173/jobs', provenance: 'route-graph' },
        ],
        unresolvedFiles: [],
        gaps: [],
        nothingToCheck: false,
      },
      findings: [
        finding({ screenId: 'clusters', whatUserExperiences: 'Clusters barrier.' }),
        finding({
          screenId: 'deployments',
          rule: 'pf-name-me',
          whatUserExperiences: 'Deployments barrier one.',
          elementKey: 'deployments|pf-name-me|name:a',
        }),
        finding({
          screenId: 'deployments',
          rule: 'pf-name-me-2',
          whatUserExperiences: 'Deployments barrier two.',
          elementKey: 'deployments|pf-name-me-2|name:b',
        }),
        finding({
          screenId: 'jobs',
          rule: 'pf-name-me-3',
          whatUserExperiences: 'Jobs barrier.',
          elementKey: 'jobs|pf-name-me-3|name:c',
        }),
      ],
    });
    const page = await mount(projectOverlay(withOtherScreens), { path: '/clusters' });
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    const inspector = host.getByRole('region', { name: 'usabl accessibility inspector' });

    // Current screen shows only the clusters finding.
    expect(await inspector.getByText('Clusters barrier.').isVisible()).toBe(true);
    // Other screens' individual findings are not listed anywhere.
    expect(await inspector.getByText('Deployments barrier one.').count()).toBe(0);
    expect(await inspector.getByText('Jobs barrier.').count()).toBe(0);

    // The elsewhere guide names each other screen with a count. Scope to the elsewhere section
    // because the coverage section also lists these screen ids as tokens.
    const elsewhere = inspector.locator('.elsewhere');
    expect(await inspector.getByRole('heading', { name: 'On other screens' }).isVisible()).toBe(true);
    expect(await elsewhere.getByText('deployments', { exact: true }).isVisible()).toBe(true);
    expect(await elsewhere.getByText('2 findings', { exact: true }).isVisible()).toBe(true);
    expect(await elsewhere.getByText('jobs', { exact: true }).isVisible()).toBe(true);

    // Each other screen has a real navigating link whose href is that screen's pathname.
    const deploymentsLink = inspector.getByRole('link', { name: 'Go to this screen' }).first();
    const hrefs = await inspector
      .getByRole('link', { name: 'Go to this screen' })
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute('href')));
    expect(hrefs).toContain('/deployments');
    expect(hrefs).toContain('/jobs');
    expect(await deploymentsLink.isVisible()).toBe(true);

    await page.context().close();
  });

  it('re-partitions on client-side navigation via pushState and popstate', async () => {
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
          elementKey: 'deployments|pf-deploy|name:d',
        }),
      ],
    });
    const page = await mount(projectOverlay(twoScreens), { path: '/clusters' });
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();
    const inspector = host.getByRole('region', { name: 'usabl accessibility inspector' });

    expect(await inspector.getByText('Clusters barrier.').isVisible()).toBe(true);
    expect(await inspector.getByText('Deployments barrier.').count()).toBe(0);

    // Simulate a single-page-app route change with pushState. The overlay wraps pushState and must
    // re-render the split without a reload.
    await page.evaluate(() => history.pushState({}, '', '/deployments'));
    await expect
      .poll(async () => inspector.getByText('Deployments barrier.').count())
      .toBe(1);
    expect(await inspector.getByText('Clusters barrier.').count()).toBe(0);

    // The browser back button fires popstate, which the overlay also handles.
    await page.evaluate(() => history.pushState({}, '', '/clusters'));
    await page.goBack();
    await expect
      .poll(async () => inspector.getByText('Deployments barrier.').count())
      .toBe(1);

    await page.context().close();
  });

  it('does not use innerHTML with page text and unwraps the untrusted frame', async () => {
    // A finding whose page-derived text carries markup and an untrusted-frame marker. The overlay
    // must render it as text, never as HTML, and must not show the raw frame markers.
    const hostile = finding({
      whatUserExperiences: '<img src=x onerror="window.__usablXss=1">markup impact',
      elementName: '<b>evil</b>',
    });
    const page = await mount(projectOverlay(result({ findings: [hostile] })), { path: '/clusters' });
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    // The onerror never fired, so no injected element and no global side effect.
    const xssRan = await page.evaluate(() => (window as unknown as { __usablXss?: number }).__usablXss);
    expect(xssRan).toBeUndefined();

    // The literal text is present as text content, and no raw frame markers leak to the user.
    const shadowText = await host.evaluate((el) => el.shadowRoot?.textContent ?? '');
    expect(shadowText).toContain('markup impact');
    expect(shadowText).not.toContain('BEGIN UNTRUSTED PAGE TEXT');
    expect(shadowText).not.toContain('END UNTRUSTED PAGE TEXT');

    await page.context().close();
  });

  it('discloses scanning, idle, not covered, approval, and error states', async () => {
    const scanningPage = await mount(projectOverlay(result()), { responseDelayMs: 1000 });
    expect(
      await scanningPage
        .locator('#__usabl-overlay')
        .getByRole('button', { name: /Open usabl inspector.*scanning/i })
        .count(),
    ).toBe(1);
    await scanningPage.context().close();

    const states: Array<{ payload: ReturnType<typeof projectOverlay>; name: RegExp }> = [
      {
        payload: projectOverlay(
          result({
            verdict: null,
            summary: 'nothing to check',
            findings: [],
            receipt: null,
            exitCode: 0,
          }),
        ),
        name: /Open usabl inspector.*idle.*0 findings/i,
      },
      {
        payload: projectOverlay(
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
            receipt: null,
            exitCode: 3,
          }),
        ),
        name: /Open usabl inspector.*not covered.*0 findings/i,
      },
      {
        payload: projectOverlay(
          result({
            verdict: 'approval_required',
            summary: 'approval required: guarded policy changed',
            findings: [],
            receipt: null,
            dirtyGuardedPaths: ['usabl.config.json'],
            exitCode: 2,
          }),
        ),
        name: /Open usabl inspector.*approval required.*0 findings/i,
      },
    ];

    for (const entry of states) {
      const page = await mount(entry.payload);
      expect(await page.locator('#__usabl-overlay').getByRole('button', { name: entry.name }).count()).toBe(1);
      await page.context().close();
    }

    const errorPage = await mount(null);
    const errorHost = errorPage.locator('#__usabl-overlay');
    const errorToggle = errorHost.getByRole('button', { name: /Open usabl inspector.*NOT verified/i });
    expect(await errorToggle.count()).toBe(1);
    await errorToggle.click();
    expect(await errorHost.getByText(/NOT verified: Inspector could not load/).isVisible()).toBe(true);
    await errorPage.context().close();
  });

  it('renders verified receipt binding without inventing new proof fields', async () => {
    const fixed = finding({ status: 'fixed' });
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'verified',
          summary: 'verified: 0 gating findings',
          findings: [fixed],
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
    );
    const host = page.locator('#__usabl-overlay');

    await host.getByRole('button', { name: /Open usabl inspector.*verified/i }).click();
    expect(await host.getByText('abcdef12', { exact: true }).isVisible()).toBe(true);
    expect(await host.getByText('policy12', { exact: true }).isVisible()).toBe(true);
    expect(await host.getByText('0.1.0', { exact: true }).isVisible()).toBe(true);
    expect(await host.getByText('clusters', { exact: true }).first().isVisible()).toBe(true);
    await page.context().close();
  });

  it('stays inside a narrow viewport with long and many-finding content', async () => {
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({
        rule: `rule-${index + 1}`,
        whatUserExperiences: `Finding ${index + 1}: ${'Long accessibility impact text '.repeat(8)}`,
        elementKey: `clusters|rule-${index + 1}|name:control`,
      }),
    );
    const page = await mount(projectOverlay(result({ findings })), {
      viewport: { width: 360, height: 640 },
      path: '/clusters',
    });
    const host = page.locator('#__usabl-overlay');

    await host.getByRole('button', { name: /Open usabl inspector/i }).click();
    const bounds = await host.boundingBox();
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

    expect(bounds).not.toBeNull();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(640);
    expect(horizontalOverflow).toBe(false);
    await page.context().close();
  });

  it('shows the floor pay-down count when greater than zero', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'verified',
          summary: 'verified: 0 gating finding(s)',
          findings: [],
          paidDownCount: 4,
        }),
      ),
    );
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    expect(await host.getByText(/4 previously accepted findings.*cleanly scanned/i).isVisible()).toBe(true);
    expect(await host.getByText(/usabl floor prune.*re-arm/i).isVisible()).toBe(true);
    await page.context().close();
  });

  it('omits the floor pay-down notice when the count is zero', async () => {
    const page = await mount(
      projectOverlay(
        result({
          verdict: 'verified',
          summary: 'verified: 0 gating finding(s)',
          findings: [],
          paidDownCount: 0,
        }),
      ),
    );
    const host = page.locator('#__usabl-overlay');
    await host.getByRole('button', { name: /Open usabl inspector/i }).click();

    expect(await host.getByText(/floor debt/i).count()).toBe(0);
    await page.context().close();
  });
});
