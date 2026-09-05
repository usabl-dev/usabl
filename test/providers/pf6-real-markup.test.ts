/**
 * Selector checks against markup PatternFly rendered, not markup we wrote.
 *
 * fixtures/pf6/rendered-markup.html is the output of scripts/render-pf6-markup.mjs, which
 * renders scripts/pf6-markup-entry.jsx in Chromium against @patternfly/react-core 6.5.1 and
 * @patternfly/react-table 6.5.1. Matching runs in a real Chromium page, so these tests use
 * the same CSS engine that src/deps/real.ts uses at run time.
 *
 * A selector that only matches a fixture we wrote proves nothing, because the fixture gets
 * written to match the selector. That is exactly how the aria-haspopup selectors stayed green
 * for a year while matching no PatternFly 6 menu toggle anywhere.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page as PwPage } from 'playwright';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

// Every test and hook here drives a real Chromium instance, so the whole file uses the shared
// real-process budget, generous enough that machine load cannot decide the outcome. Launching
// the browser cold under a full suite is exactly the case a per-test idle-machine number would
// flake on. See test/support/timing.ts.
vi.setConfig({ testTimeout: REAL_PROCESS_BUDGET_MS, hookTimeout: REAL_PROCESS_BUDGET_MS });
import type { AxNode, Page, ProviderContext } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { checkPfKebabExpandedState } from '../../src/providers/rulepack/pf-kebab-expanded-state.js';
import { probeDialogs } from '../../src/providers/rulepack/probes.js';
import { SEL } from '../../src/providers/rulepack/selectors.js';
import { testConfig } from '../helpers.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/pf6/rendered-markup.html', import.meta.url));

let browser: Browser;
let markup: string;

beforeAll(async () => {
  markup = await readFile(FIXTURE, 'utf8');
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function openFixture(html: string = markup): Promise<PwPage> {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return page;
}

/**
 * Reports what a selector matched, in terms a human can check against the fixture by eye.
 * ids and labels come straight from the rendered markup. Generated OUIA ids are used last
 * because they carry a React render counter and change every time the fixture is rebuilt.
 */
async function matchedLabels(page: PwPage, selector: string): Promise<string[]> {
  return page.evaluate(
    (query) =>
      Array.from(document.querySelectorAll(query)).map(
        (el) =>
          el.id ||
          el.getAttribute('aria-label') ||
          el.getAttribute('data-ouia-component-id') ||
          `${el.tagName.toLowerCase()}.${el.className}`,
      ),
    selector,
  );
}

/**
 * A Page backed by a live Chromium page instead of by canned answers.
 *
 * axAt reports role and name from the DOM rather than from the accessibility tree. That is
 * the strict direction: the rules under test fall back to tree state only when the DOM
 * attribute is missing, and an empty states map never invents state the page does not have.
 */
function livePage(pw: PwPage): Page {
  return makeFakePage({
    async queryAll(selector: string) {
      const refs = await pw.evaluate((query) => {
        const counter = Reflect.get(window, '__usablRefs');
        let next = typeof counter === 'number' ? counter : 0;
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll(query))) {
          let ref = el.getAttribute('data-usabl-ref');
          if (ref === null) {
            ref = String(next);
            next += 1;
            el.setAttribute('data-usabl-ref', ref);
          }
          out.push(ref);
        }
        Reflect.set(window, '__usablRefs', next);
        return out;
      }, selector);
      return refs.map((ref) => ({ selector: `[data-usabl-ref="${ref}"]` }));
    },
    async getAttribute(selector: string, name: string) {
      return pw.locator(selector).first().getAttribute(name);
    },
    async axAt(selector: string): Promise<AxNode | null> {
      const count = await pw.locator(selector).count();
      if (count === 0) {
        return null;
      }
      return pw.locator(selector).first().evaluate((el) => ({
        name: el.getAttribute('aria-label') ?? ((el.textContent ?? '').trim() || null),
        role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
        states: {},
      }));
    },
    async click(selector: string) {
      await pw.locator(selector).first().click();
    },
    async press(key: string) {
      await pw.keyboard.press(key);
    },
    async activeElementIs(selector: string) {
      return pw
        .locator(selector)
        .first()
        .evaluate((el) => document.activeElement === el);
    },
    async activeElementWithin(selector: string) {
      return pw
        .locator(selector)
        .first()
        .evaluate((el) => el.contains(document.activeElement));
    },
  });
}

function liveContext(pw: PwPage): ProviderContext {
  return {
    config: testConfig(),
    screen: { id: 'pf6', url: 'http://127.0.0.1:5173/pf6' },
    page: livePage(pw),
  };
}

/** Every PatternFly 6 MenuToggle in the fixture, by the id or label the library rendered. */
const PF6_MENU_TOGGLES = [
  'help-menu-menu-toggle', // plain kebab in a Dropdown
  'actions-toggle', // labelled Dropdown toggle
  'status-toggle', // Select toggle
  'Typeahead toggle', // typeahead variant, toggle is an inner button
  'split-toggle', // split button variant, toggle is an inner button
  'Kebab toggle', // row action kebab from @patternfly/react-table ActionsColumn
];

describe('PatternFly 6 selectors against rendered PatternFly markup', () => {
  it('the fixture really is PatternFly 6 output', async () => {
    const page = await openFixture();
    try {
      expect(markup).toContain('@patternfly/react-core 6.5.1');
      // If PatternFly ever starts emitting aria-haspopup on MenuToggle this test should be
      // revisited, so pin the fact the fix depends on.
      const haspopupOnToggles = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-ouia-component-type="PF6/MenuToggle"]')).filter((el) =>
          el.hasAttribute('aria-haspopup'),
        ).length,
      );
      expect(haspopupOnToggles).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('pf-kebab-expanded-state: SEL.menuToggle matches every PatternFly menu toggle', async () => {
    const page = await openFixture();
    try {
      const matched = await matchedLabels(page, SEL.menuToggle);
      for (const toggle of PF6_MENU_TOGGLES) {
        expect(matched).toContain(toggle);
      }
    } finally {
      await page.close();
    }
  });

  it('pf-kebab-expanded-state: the static check reports a real PatternFly kebab', async () => {
    const page = await openFixture();
    try {
      const drafts = await checkPfKebabExpandedState(liveContext(page));
      expect(drafts.length).toBeGreaterThanOrEqual(PF6_MENU_TOGGLES.length);
      expect(drafts.every((draft) => draft.rule === 'pf-kebab-expanded-state')).toBe(true);
      expect(drafts.map((draft) => draft.elementName)).toContain('Kebab toggle');
    } finally {
      await page.close();
    }
  });

  it('pf-focus-into-dialog: SEL.dialogTrigger matches the control that opens a real modal', async () => {
    const page = await openFixture();
    try {
      const matched = await matchedLabels(page, SEL.dialogTrigger);
      expect(matched).toContain('disclosure-modal-button');
      // PatternFly's own DatePicker button, the one thing in the library that declares dialog intent.
      expect(matched).toContain('Toggle date picker');
      // The documented gap: a Modal trigger with no ARIA relationship is not findable, and the
      // probe will not click arbitrary buttons on a live page to go looking for one.
      expect(matched).not.toContain('open-modal-button');
    } finally {
      await page.close();
    }
  });

  it('pf-modal-focus-return: the dialog probe evaluates a real PatternFly modal', async () => {
    // Rebuild a page from two fragments of the rendered fixture, unchanged: the modal trigger
    // and the modal box PatternFly produced. Only the open-on-click wiring is written here,
    // because a static file cannot open anything and the probe has to click something.
    const source = await openFixture();
    const trigger = await source.locator('#disclosure-modal-button').evaluate((el) => el.outerHTML);
    const dialog = await source.locator('[role="dialog"][class*="modal-box"]').evaluate((el) => el.outerHTML);
    await source.close();

    const page = await openFixture(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>PatternFly 6 modal</title></head>
<body>
  <main>${trigger}<div id="dialog-host" hidden>${dialog}</div></main>
  <script>
    // Show the modal on click and deliberately leave focus on the trigger, which is the
    // failure pf-focus-into-dialog exists to catch.
    document.getElementById('disclosure-modal-button').addEventListener('click', () => {
      document.getElementById('dialog-host').hidden = false;
    });
  </script>
</body></html>`);
    try {
      const drafts = await probeDialogs(liveContext(page));
      expect(drafts.map((draft) => draft.rule)).toEqual(['pf-focus-into-dialog', 'pf-modal-focus-return']);
      expect(drafts.every((draft) => draft.confidence === 'fail')).toBe(true);
    } finally {
      await page.close();
    }
    // Budget comes from the file-level vi.setConfig above (shared real-process budget).
  });
});
