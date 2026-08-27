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
  ...over,
});

async function mount(
  payload: ReturnType<typeof projectOverlay> | null,
  viewport = { width: 1280, height: 900 },
  responseDelayMs = 0,
): Promise<Page> {
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
            <main><button type="button">Host action</button></main>
            <script type="module">${overlayClientSource}</script>
          </body>
        </html>`,
    });
  });
  await page.goto('http://usabl.test/');
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
  await browser.close();
});

describe('overlay browser client', () => {
  it('renders an accessible regression inspector and returns focus on Escape', async () => {
    const page = await mount(projectOverlay(result()));
    const host = page.locator('#__usabl-overlay');
    const toggle = host.getByRole('button', { name: /Open usabl inspector.*regression.*2 findings/i });

    expect(await toggle.count()).toBe(1);
    await toggle.click();

    const inspector = host.getByRole('region', { name: 'usabl accessibility inspector' });
    expect(await inspector.isVisible()).toBe(true);
    expect(await inspector.getByText('Affected screens').isVisible()).toBe(true);
    expect(await inspector.getByText('clusters', { exact: true }).first().isVisible()).toBe(true);

    const findingButton = inspector.getByRole('button', {
      name: 'Focus stays behind the dialog when it opens.',
    });
    await findingButton.click();
    expect(
      await inspector.getByText('The dialog focus lifecycle does not establish a keyboard position.').isVisible(),
    ).toBe(true);
    expect(await inspector.getByText('Move focus into the dialog when it opens.').isVisible()).toBe(true);
    expect(await inspector.getByText('pf-focus-into-dialog', { exact: true }).isVisible()).toBe(true);

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

  it('discloses scanning, idle, not covered, approval, and error states', async () => {
    const scanningPage = await mount(projectOverlay(result()), { width: 1280, height: 900 }, 1000);
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
    const page = await mount(projectOverlay(result({ findings })), { width: 360, height: 640 });
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
});
