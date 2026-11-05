/**
 * The Deque provider on a real page in real Chromium. Deque's package is on a private registry,
 * so the builder here is a stand-in whose analyze() runs open-source axe through
 * @axe-core/playwright on the very page the provider handed it, then adds one Deque-only rule.
 * That is the shape Deque documents: standard axe results with Deque's own rules beside them. The
 * stand-in also has the two builder methods usabl calls, enableTracking and withTags.
 * Gated behind USABL_INTEGRATION=1 like the other real-browser tests.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type Page as PwPage } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adoptPage } from '../../../src/deps/real.js';
import { makeDequeProvider } from '../../../src/providers/engines/deque.js';
import { applicabilityOf, draftsOf, testConfig } from '../../helpers.js';

const EXTRA_VIOLATION = {
  id: 'deque-extra-rule',
  impact: 'serious',
  description: 'Deque extra rule description',
  nodes: [{ target: ['main > a'], failureSummary: 'Fix the link.' }],
};

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('Deque provider on a real page', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('drops the open-source axe findings and maps the Deque-only rule', async () => {
    const html = await readFile(
      fileURLToPath(new URL('../../../fixtures/engines/deque-page.html', import.meta.url)),
      'utf8',
    );
    const context = await browser.newContext();
    try {
      const pw = await context.newPage();
      await pw.setContent(html, { waitUntil: 'domcontentloaded' });
      const page = await adoptPage(pw);

      const seen: { page: unknown; axeViolations: string[]; tracking: boolean[] } = {
        page: null,
        axeViolations: [],
        tracking: [],
      };
      const provider = makeDequeProvider(
        { enabled: true },
        {
          env: { AXE_TRACK_USAGE: 'false' },
          fileExists: async () => false,
          load: async () => ({
            AxeDevToolsBuilder: class {
              private readonly page: PwPage;
              constructor(options: { page: PwPage }) {
                this.page = options.page;
                seen.page = options.page;
              }
              enableTracking(state: boolean) {
                seen.tracking.push(state);
                return this;
              }
              async analyze() {
                const results = await new AxeBuilder({ page: this.page }).analyze();
                seen.axeViolations = results.violations.map((issue) => issue.id);
                return { ...results, violations: [...results.violations, EXTRA_VIOLATION] };
              }
            },
          }),
        },
      );

      const output = await provider.run({
        page,
        screen: { id: 'clusters', url: pw.url() },
        config: testConfig(),
      });

      // The provider handed the SDK the real Playwright page, and open-source axe really did fail
      // the page, so the removal below was exercised on real results.
      expect(seen.page).toBe(pw);
      expect(seen.tracking).toEqual([false]);
      expect(seen.axeViolations).toEqual(expect.arrayContaining(['button-name', 'image-alt']));
      expect(draftsOf(output).map((draft) => [draft.layer, draft.rule, draft.elementPath, draft.evidenceClass])).toEqual([
        ['deque', 'deque:deque-extra-rule', 'main > a', 'preview'],
      ]);
      expect(applicabilityOf(output)).toEqual([
        { screenId: 'clusters', layer: 'deque', rule: 'deque:deque-extra-rule', outcome: 'failed', elementCount: 1 },
      ]);
    } finally {
      await context.close();
    }
  });
});
