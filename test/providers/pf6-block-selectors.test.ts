/**
 * Block selectors must land on the block, not its BEM children.
 *
 * PatternFly writes child classes off the same stem as the block: `pf-v6-c-toolbar` also prefixes
 * `pf-v6-c-toolbar__content`, `__group`, `__item`, and `pf-v6-c-alert` prefixes `__icon`,
 * `__title`. A `[class*="pf-v6-c-toolbar"]` substring selector matches every one of those wrappers,
 * so a page with two toolbars reads as twenty-one elements and a page with two alerts reads as six.
 *
 * The consequences are not cosmetic. `pf-toolbar-labeled-when-repeated` fires at two or more
 * matches, so a single real toolbar already trips it against wrapper divs that can carry no name.
 * `pf-toast-live-region` reports one loose alert three times, itself plus its icon and title, and
 * the evidence floor is keyed on findings, so one barrier writes three floor entries.
 *
 * These checks run in a real Chromium page, the same CSS engine src/deps/real.ts uses at run time,
 * against markup PatternFly rendered. A selector that only satisfies a fixture we wrote proves
 * nothing; that is how the aria-haspopup selectors matched no real toggle for a year.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page as PwPage } from 'playwright';
import type { AxNode, Page, ProviderContext } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { checkPfToastLiveRegion } from '../../src/providers/rulepack/pf-toast-live-region.js';
import { checkPfToolbarLabeledWhenRepeated } from '../../src/providers/rulepack/pf-toolbar-labeled-when-repeated.js';
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

async function countMatches(page: PwPage, selector: string): Promise<number> {
  return page.evaluate((query) => document.querySelectorAll(query).length, selector);
}

/**
 * The block-class tokens each selector must land on. Read from the DOM rather than asserted by
 * hand, so the test measures what the CSS engine matched, not what the test author expected.
 */
async function blockClasses(page: PwPage, selector: string): Promise<string[]> {
  return page.evaluate(
    (query) => Array.from(document.querySelectorAll(query)).map((el) => el.className),
    selector,
  );
}

/**
 * A live-Chromium Page for the two rules under test. Mirrors the fake in pf6-real-markup.test.ts:
 * queryAll assigns a stable ref per matched element, axAt reads role and name from the DOM.
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
      return pw.locator(selector).first().evaluate((el) => document.activeElement === el);
    },
    async activeElementWithin(selector: string) {
      return pw.locator(selector).first().evaluate((el) => el.contains(document.activeElement));
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

describe('block selectors match blocks, not their BEM children', () => {
  it('SEL.toolbar matches the two real toolbars, not their nineteen wrappers', async () => {
    const page = await openFixture();
    try {
      const count = await countMatches(page, SEL.toolbar);
      // The fixture has two toolbars. The substring form matched twenty-one: two blocks plus
      // content, content-section, expandable-content, group, item and toggle wrappers.
      expect(count).toBe(2);

      // Every match is a toolbar block, so none is a __child wrapper.
      const classes = await blockClasses(page, SEL.toolbar);
      for (const className of classes) {
        expect(className.split(/\s+/)).toContain('pf-v6-c-toolbar');
        expect(className).not.toContain('pf-v6-c-toolbar__');
      }
    } finally {
      await page.close();
    }
  });

  it('SEL.alert matches the two real alerts, not their icon and title children', async () => {
    const page = await openFixture();
    try {
      const count = await countMatches(page, SEL.alert);
      // The fixture has two alerts. The substring form matched six: two blocks plus each alert's
      // __icon and __title.
      expect(count).toBe(2);

      const classes = await blockClasses(page, SEL.alert);
      for (const className of classes) {
        expect(className.split(/\s+/)).toContain('pf-v6-c-alert');
        expect(className).not.toContain('pf-v6-c-alert__');
      }
    } finally {
      await page.close();
    }
  });

  it('pf-toolbar-labeled-when-repeated does not fire on a page with one real toolbar', async () => {
    // One toolbar with the full set of BEM wrappers. The only control carries its name on an
    // aria-label, so every wrapper div has an empty accessible name. Under the substring selector
    // that is four unnamed "toolbars", which clears the two-or-more threshold and demands names on
    // wrapper divs that cannot carry one. The block selector sees one toolbar, so the rule stays
    // silent. The empty-name wrappers are what make this a real red, not an accidental pass on the
    // wrappers happening to inherit the button text.
    const oneToolbar = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div class="pf-v6-c-toolbar">
        <div class="pf-v6-c-toolbar__content">
          <div class="pf-v6-c-toolbar__content-section">
            <div class="pf-v6-c-toolbar__group">
              <div class="pf-v6-c-toolbar__item">
                <button type="button" aria-label="Filter"></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main></body></html>`;
    const page = await openFixture(oneToolbar);
    try {
      const drafts = await checkPfToolbarLabeledWhenRepeated(liveContext(page));
      expect(drafts).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('pf-toolbar-labeled-when-repeated still fires when two real toolbars are unnamed', async () => {
    // The rule must keep its real job: under-matching would be worse than the over-match being
    // fixed. Two toolbar blocks, neither with an accessible name, so the controls carry their own
    // names on aria-label and each toolbar div reads empty. The rule reports one finding per block.
    const twoToolbars = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div class="pf-v6-c-toolbar"><div class="pf-v6-c-toolbar__content"><button type="button" aria-label="A"></button></div></div>
      <div class="pf-v6-c-toolbar"><div class="pf-v6-c-toolbar__content"><button type="button" aria-label="B"></button></div></div>
    </main></body></html>`;
    const page = await openFixture(twoToolbars);
    try {
      const drafts = await checkPfToolbarLabeledWhenRepeated(liveContext(page));
      expect(drafts.length).toBe(2);
      expect(drafts.every((draft) => draft.rule === 'pf-toolbar-labeled-when-repeated')).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('pf-toast-live-region counts one loose alert once, not the whole alert subtree', async () => {
    // The fixture has one contained alert, inside a role="status" live region, and one loose alert.
    // Only the loose one should fail. The substring selector matched both alert blocks plus each
    // one's __icon and __title, so the rule produced six findings, and the evidence floor is keyed
    // on findings, so one real barrier wrote six floor entries. The block selector reduces that to
    // the two alert blocks, and the corrected contained query excludes the alert in the live
    // region, so exactly one finding remains for the loose alert.
    const page = await openFixture();
    try {
      const drafts = await checkPfToastLiveRegion(liveContext(page));
      expect(drafts.length).toBe(1);
      expect(drafts[0]?.rule).toBe('pf-toast-live-region');
    } finally {
      await page.close();
    }
  });

  it('pf-toast-live-region does not fail an alert that sits inside a live region', async () => {
    // The containment half of the rule. An alert inside a role="status" region is announced, so it
    // must not be reported. This is a real red on the malformed contained query: a comma binds
    // looser than the descendant combinator, so the old `liveContainer alert` string paired the
    // alert with only the last container term and read the others as bare matches, which put no
    // alert in the contained set and failed a contained alert.
    const containedOnly = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div role="status" aria-live="polite">
        <div class="pf-v6-c-alert pf-m-success"><div class="pf-v6-c-alert__icon"></div><h4 class="pf-v6-c-alert__title">Saved</h4></div>
      </div>
    </main></body></html>`;
    const page = await openFixture(containedOnly);
    try {
      const drafts = await checkPfToastLiveRegion(liveContext(page));
      expect(drafts).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('pf-toast-live-region does not fail an alert nested several levels inside a live region', async () => {
    // The other containment tests place the alert as a direct child of the live region, so a
    // regression that swapped the descendant combinator for a child combinator would still pass
    // them while quietly failing every real nested alert. PatternFly nests alerts inside lists and
    // wrappers, so the alert here sits three levels below the role="status" region. The distributed
    // query uses a descendant space, which matches at any depth, so this alert is contained and no
    // draft is produced. Swap the space for a child combinator in the rule and this goes red, which
    // is what gives the test teeth.
    const nestedContained = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div role="status" aria-live="polite">
        <ul>
          <li>
            <div class="toast-wrapper">
              <div class="pf-v6-c-alert pf-m-success"><div class="pf-v6-c-alert__icon"></div><h4 class="pf-v6-c-alert__title">Saved</h4></div>
            </div>
          </li>
        </ul>
      </div>
    </main></body></html>`;
    const page = await openFixture(nestedContained);
    try {
      const drafts = await checkPfToastLiveRegion(liveContext(page));
      expect(drafts).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
