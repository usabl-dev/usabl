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
import { LIVE_AND_PATH_INIT_SCRIPT, INSTALL_PATH_HELPER_SCRIPT } from '../../src/deps/real.js';
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

  it('pf-toast-live-region flags an alert inside aria-live="off", instead of exempting it', async () => {
    // aria-live="off" is not a live region. An alert inside it is as unannounced as a loose
    // alert. The bare [aria-live] term treated every aria-live value as a container, so the
    // set-difference dropped this alert from the flagged set and the page passed clean. That
    // is a false green: a real barrier is reported as fine.
    const offRegion = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div aria-live="off">
        <div class="pf-v6-c-alert pf-m-success"><div class="pf-v6-c-alert__icon"></div><h4 class="pf-v6-c-alert__title">Saved</h4></div>
      </div>
    </main></body></html>`;
    const page = await openFixture(offRegion);
    try {
      const drafts = await checkPfToastLiveRegion(liveContext(page));
      expect(drafts.length).toBe(1);
      expect(drafts[0]?.rule).toBe('pf-toast-live-region');
    } finally {
      await page.close();
    }
  });

  it('pf-toast-live-region flags an alert inside a status region that sets aria-live="off"', async () => {
    // PatternFly live regions typically carry both role="status" and aria-live. An explicit
    // aria-live="off" overrides the role's implicit polite live value, so the region is not
    // announced. Excluding off only from the [aria-live] term would still match [role="status"]
    // and keep this as a false green.
    const statusOff = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div role="status" aria-live="off">
        <div class="pf-v6-c-alert pf-m-success"><div class="pf-v6-c-alert__icon"></div><h4 class="pf-v6-c-alert__title">Saved</h4></div>
      </div>
    </main></body></html>`;
    const page = await openFixture(statusOff);
    try {
      const drafts = await checkPfToastLiveRegion(liveContext(page));
      expect(drafts.length).toBe(1);
      expect(drafts[0]?.rule).toBe('pf-toast-live-region');
    } finally {
      await page.close();
    }
  });
});

/**
 * pathFor identity collision: duplicate id causes a false green in set-difference rules.
 *
 * The existing livePage helper uses data-usabl-ref, which bypasses pathFor entirely. These tests
 * use a queryAll that calls window.__usablPathFor — the same path the real driver takes —
 * so the duplicate-id collision is actually observable and the fix is actually tested.
 *
 * The LIVE_AND_PATH_INIT_SCRIPT is evaluated before setContent to install __usablPathFor the same
 * way the real driver does via addInitScript.
 */
describe('pathFor does not collapse elements that share an id', () => {
  async function openWithPathHelper(html: string): Promise<PwPage> {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // addInitScript only fires on a real navigation (goto), not setContent. Evaluating the IIFE
    // directly after setContent installs __usablPathFor the same way the real driver does.
    await page.evaluate(LIVE_AND_PATH_INIT_SCRIPT);
    return page;
  }

  /**
   * A Page whose queryAll calls window.__usablPathFor, matching stablePathsForSelector in real.ts.
   * This is the path the production driver takes; data-usabl-ref is a test-only shortcut that
   * bypasses pathFor and cannot observe the duplicate-id collision.
   */
  function pathForPage(pw: PwPage): Page {
    return makeFakePage({
      async queryAll(selector: string) {
        const paths = await pw.evaluate((query) => {
          const pathFor = Reflect.get(window, '__usablPathFor');
          if (typeof pathFor !== 'function') {
            return [] as string[];
          }
          return Array.from(document.querySelectorAll(query)).map(
            (element) => pathFor(element) as string,
          );
        }, selector);
        return paths.map((path) => ({ selector: path }));
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
    });
  }

  function pathForContext(pw: PwPage): ProviderContext {
    return {
      config: testConfig(),
      screen: { id: 'pf6', url: 'http://127.0.0.1:5173/pf6' },
      page: pathForPage(pw),
    };
  }

  it('pathFor returns distinct selectors for two elements sharing an id', async () => {
    // Two divs with the same id. The old pathFor returned "#dup" for both, so any set operation
    // keyed on element identity could not distinguish them. The fix falls back to the structural
    // nth-child path when an id is not unique in the document.
    const page = await openWithPathHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body>
      <div id="dup" class="first">first</div>
      <div id="dup" class="second">second</div>
    </body></html>`);
    try {
      const paths = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor');
        if (typeof pathFor !== 'function') {
          return [] as string[];
        }
        return Array.from(document.querySelectorAll('[id="dup"]')).map(
          (el) => pathFor(el) as string,
        );
      });
      expect(paths).toHaveLength(2);
      // Paths must be distinct: if they are the same, the identity collision is not fixed.
      expect(paths[0]).not.toBe(paths[1]);
      // Neither path should be the bare #dup shortcut, because the id is not unique.
      expect(paths[0]).not.toBe('#dup');
      expect(paths[1]).not.toBe('#dup');
    } finally {
      await page.close();
    }
  });

  it('pathFor keeps the #id shortcut when the id is unique in the document', async () => {
    // Uniqueness check must not break the common case. A unique id should still produce
    // the short #id form so selectors stay human-readable and stable.
    const page = await openWithPathHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body>
      <div id="unique-a">first</div>
      <div id="unique-b">second</div>
    </body></html>`);
    try {
      const paths = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor');
        if (typeof pathFor !== 'function') {
          return [] as string[];
        }
        const a = document.getElementById('unique-a');
        const b = document.getElementById('unique-b');
        return [pathFor(a), pathFor(b)] as string[];
      });
      expect(paths[0]).toBe('#unique-a');
      expect(paths[1]).toBe('#unique-b');
    } finally {
      await page.close();
    }
  });

  it('pf-toast-live-region flags a loose alert that shares an id with a contained alert', async () => {
    // The exact scenario from #182. Two alerts with id="dup": one inside a live region (should
    // be exempt), one loose (should be flagged). The old pathFor produced "#dup" for both, so
    // the set difference dropped the loose alert, yielding a false green. The fix makes their
    // paths structurally distinct, so only the contained alert is exempt.
    const dupIdPage = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div role="status" aria-live="polite">
        <div id="dup" class="pf-v6-c-alert pf-m-success"><h4 class="pf-v6-c-alert__title">Contained</h4></div>
      </div>
      <div id="dup" class="pf-v6-c-alert pf-m-warning"><h4 class="pf-v6-c-alert__title">Loose</h4></div>
    </main></body></html>`;
    const page = await openWithPathHelper(dupIdPage);
    try {
      const drafts = await checkPfToastLiveRegion(pathForContext(page));
      expect(drafts.length).toBe(1);
      expect(drafts[0]?.rule).toBe('pf-toast-live-region');
      // The loose alert is the one flagged; the contained one must be silent.
      expect(drafts[0]?.elementName).toContain('Loose');
    } finally {
      await page.close();
    }
  });

  it('pathFor anchors on a unique ancestor id rather than building the full path from root', async () => {
    // The ancestor shortcut also keys on id. Two elements with different ids but sharing a
    // common ancestor that has a unique id should still anchor on that ancestor.
    const page = await openWithPathHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body>
      <section id="section-a">
        <div class="child-a">child</div>
      </section>
    </body></html>`);
    try {
      const path = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor');
        if (typeof pathFor !== 'function') {
          return '';
        }
        return pathFor(document.querySelector('.child-a')) as string;
      });
      // Should anchor on the unique #section-a rather than walking all the way to html.
      expect(path).toContain('#section-a');
    } finally {
      await page.close();
    }
  });

  it('pathFor does not anchor on an ancestor id when that ancestor id is duplicated', async () => {
    // Two sections with id="dup" each containing a .child element. Without the fix the ancestor
    // shortcut would produce "#dup > div:nth-child(1)" for both children, collapsing them. With
    // the fix neither child can anchor on its (non-unique) ancestor id, so their paths differ.
    const page = await openWithPathHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body>
      <section id="dup"><div class="child">child-a</div></section>
      <section id="dup"><div class="child">child-b</div></section>
    </body></html>`);
    try {
      const paths = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor');
        if (typeof pathFor !== 'function') {
          return [] as string[];
        }
        return Array.from(document.querySelectorAll('.child')).map(
          (el) => pathFor(el) as string,
        );
      });
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
    } finally {
      await page.close();
    }
  });

  it('pathFor element with no id falls back to full structural path from root', async () => {
    // No id anywhere in the ancestry. The path must walk all the way up via nth-child.
    const page = await openWithPathHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body>
      <main><section><p class="target">text</p></section></main>
    </body></html>`);
    try {
      const path = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor') as ((el: Element | null) => string) | undefined;
        return pathFor ? pathFor(document.querySelector('.target')) : '';
      });
      // Must contain nth-child segments, not an id shortcut.
      expect(path).toContain('nth-child');
      expect(path).not.toMatch(/^#/);
    } finally {
      await page.close();
    }
  });

  it('pathFor returns empty string for null', async () => {
    const page = await openWithPathHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body></body></html>`);
    try {
      const path = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor') as ((el: Element | null) => string) | undefined;
        return pathFor ? pathFor(null) : 'NOT_EMPTY';
      });
      expect(path).toBe('');
    } finally {
      await page.close();
    }
  });
});

/**
 * INSTALL_PATH_HELPER_SCRIPT (the adoptPage path) must apply the same uniqueness check.
 * makeRealBrowserDriver uses LIVE_AND_PATH_INIT_SCRIPT at document start; adoptPage uses
 * INSTALL_PATH_HELPER_SCRIPT after-the-fact. Both share PATH_FOR_IMPL, and both install
 * paths are tested independently here.
 */
describe('INSTALL_PATH_HELPER_SCRIPT (adoptPage path) also rejects duplicate ids', () => {
  async function openWithInstallHelper(html: string): Promise<PwPage> {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // INSTALL_PATH_HELPER_SCRIPT is what adoptPage evaluates after a caller-navigated page is handed to usabl.
    // It must NOT be preceded by LIVE_AND_PATH_INIT_SCRIPT, or the guard returns early and the
    // shared install script is never executed.
    await page.evaluate(INSTALL_PATH_HELPER_SCRIPT);
    return page;
  }

  it('INSTALL_PATH_HELPER_SCRIPT: duplicate ids produce distinct paths', async () => {
    const page = await openWithInstallHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body>
      <div id="dup" class="first">first</div>
      <div id="dup" class="second">second</div>
    </body></html>`);
    try {
      const paths = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor') as ((el: Element | null) => string) | undefined;
        return pathFor
          ? Array.from(document.querySelectorAll('[id="dup"]')).map((el) => pathFor(el))
          : [];
      });
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
      expect(paths[0]).not.toBe('#dup');
      expect(paths[1]).not.toBe('#dup');
    } finally {
      await page.close();
    }
  });

  it('INSTALL_PATH_HELPER_SCRIPT: unique id still produces #id shortcut', async () => {
    const page = await openWithInstallHelper(`<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body>
      <div id="only-one">content</div>
    </body></html>`);
    try {
      const path = await page.evaluate(() => {
        const pathFor = Reflect.get(window, '__usablPathFor') as ((el: Element | null) => string) | undefined;
        return pathFor ? pathFor(document.getElementById('only-one')) : '';
      });
      expect(path).toBe('#only-one');
    } finally {
      await page.close();
    }
  });

  it('INSTALL_PATH_HELPER_SCRIPT: pf-toast-live-region flags loose alert sharing an id with a contained alert', async () => {
    // Same false-green scenario as the init-script test, but through the adoptPage code path.
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>
      <div role="status" aria-live="polite">
        <div id="dup" class="pf-v6-c-alert pf-m-success"><h4 class="pf-v6-c-alert__title">Contained</h4></div>
      </div>
      <div id="dup" class="pf-v6-c-alert pf-m-warning"><h4 class="pf-v6-c-alert__title">Loose</h4></div>
    </main></body></html>`;
    const page = await openWithInstallHelper(html);
    // pathForPage uses window.__usablPathFor, so it exercises the adoptPage install path.
    const ctx: ProviderContext = {
      config: testConfig(),
      screen: { id: 'pf6', url: 'http://127.0.0.1:5173/pf6' },
      page: makeFakePage({
        async queryAll(selector: string) {
          const paths = await page.evaluate((query) => {
            const pathFor = Reflect.get(window, '__usablPathFor') as ((el: Element | null) => string) | undefined;
            return pathFor
              ? Array.from(document.querySelectorAll(query)).map((el) => pathFor(el))
              : [];
          }, selector);
          return paths.map((p) => ({ selector: p }));
        },
        async axAt(selector: string): Promise<AxNode | null> {
          const count = await page.locator(selector).count();
          if (count === 0) return null;
          return page.locator(selector).first().evaluate((el) => ({
            name: el.getAttribute('aria-label') ?? ((el.textContent ?? '').trim() || null),
            role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
            states: {},
          }));
        },
      }),
    };
    try {
      const drafts = await checkPfToastLiveRegion(ctx);
      expect(drafts.length).toBe(1);
      expect(drafts[0]?.rule).toBe('pf-toast-live-region');
      expect(drafts[0]?.elementName).toContain('Loose');
    } finally {
      await page.close();
    }
  });
});
