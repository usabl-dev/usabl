/**
 * Real Chromium with real @rhds/elements components: the RHDS rulepack fires every rule on a broken
 * page and none on a correct one, axe still reads the inner button of an rh-button through its
 * shadow root, each design-system pack runs only where its marker is, and the keyboard walk
 * confirms focus on the inner button of an rh-button, which delegates focus.
 *
 * Gated behind USABL_INTEGRATION=1 like the other browser tests, because it launches Chromium. The
 * fixture markup follows the RHDS element documentation.
 */
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Draft, Page, ProviderRunResult, RuleApplicability } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { axeProvider } from '../../src/providers/axe/index.js';
import { runProviders } from '../../src/providers/index.js';
import { makeKeyboardWalkProvider } from '../../src/providers/keyboard-walk/index.js';
import { makeRhdsRulepackProvider } from '../../src/providers/rhds/index.js';
import { RHDS_RULES } from '../../src/providers/rhds/sources.js';
import { makeRulepackProvider, PF_RULES } from '../../src/providers/rulepack/index.js';
import { draftsOf, testConfig } from '../helpers.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

// The modules the fixtures use, bundled once for the browser. Icons load on demand from a package
// the fixtures do not serve, so they stay out of the bundle and an icon simply does not draw.
const RHDS_IMPORTS = [
  'rh-accordion/rh-accordion.js',
  'rh-accordion/rh-accordion-header.js',
  'rh-accordion/rh-accordion-panel.js',
  'rh-button/rh-button.js',
  'rh-cta/rh-cta.js',
  'rh-dialog/rh-dialog.js',
  'rh-skip-link/rh-skip-link.js',
  'rh-switch/rh-switch.js',
  'rh-tabs/rh-tabs.js',
  'rh-tabs/rh-tab.js',
  'rh-tabs/rh-tab-panel.js',
]
  .map((path) => `import '@rhds/elements/${path}';`)
  .join('\n');

async function bundleRhds(): Promise<string> {
  const result = await build({
    stdin: { contents: RHDS_IMPORTS, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external: ['@rhds/icons/*'],
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error('esbuild produced no bundle');
  return output.text;
}

function page(title: string, body: string, withRhds = true): string {
  const script = withRhds ? '<script type="module" src="/rhds.js"></script>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${script}</head><body>${body}</body></html>`;
}

// Every rule broken once. The dialog opens as a modal, which makes the rest of the page inert, so
// the controls whose names the tree must confirm sit inside it.
const BROKEN = page(
  'RHDS broken',
  `<rh-skip-link id="skip-missing"></rh-skip-link>
  <rh-skip-link id="skip-dangling" href="#no-such-target">Skip to main content</rh-skip-link>
  <main id="main-content">
    <h1>Broken</h1>
    <rh-cta id="cta-bare">Learn more</rh-cta>
    <rh-tabs id="tabs-unpaired">
      <rh-tab slot="tab">One</rh-tab>
      <rh-tab slot="tab">Two</rh-tab>
      <rh-tab-panel>Panel one</rh-tab-panel>
    </rh-tabs>
    <div id="stray-wrapper"><rh-accordion-header id="stray-header"><h3>Stray header</h3></rh-accordion-header></div>
    <rh-dialog id="dialog-unnamed">
      <p>Settings body</p>
      <rh-button id="icon-only"></rh-button>
      <rh-switch id="switch-unlabeled"></rh-switch>
    </rh-dialog>
  </main>
  <script type="module">
    await customElements.whenDefined('rh-dialog');
    document.getElementById('dialog-unnamed').show();
  </script>`,
);

const CORRECT = page(
  'RHDS correct',
  `<rh-skip-link href="#main-content">Skip to main content</rh-skip-link>
  <rh-skip-link><a href="#main-content">Skip to content</a></rh-skip-link>
  <main id="main-content">
    <h1>Correct</h1>
    <rh-button id="save">Save</rh-button>
    <rh-button id="labelled" accessible-label="Close panel"></rh-button>
    <rh-cta href="#details">Read the details</rh-cta>
    <rh-cta><a href="#details">Read more</a></rh-cta>
    <rh-tabs>
      <rh-tab slot="tab">One</rh-tab>
      <rh-tab slot="tab">Two</rh-tab>
      <rh-tab-panel>Panel one</rh-tab-panel>
      <rh-tab-panel>Panel two</rh-tab-panel>
    </rh-tabs>
    <rh-accordion>
      <rh-accordion-header><h3>Question</h3></rh-accordion-header>
      <rh-accordion-panel><p>Answer</p></rh-accordion-panel>
    </rh-accordion>
    <rh-switch id="wifi" accessible-label="Wi-Fi"></rh-switch>
    <label for="bluetooth">Bluetooth</label><rh-switch id="bluetooth"></rh-switch>
    <rh-button id="open-terms">Open terms</rh-button>
    <rh-dialog trigger="open-terms"><h2 slot="header">Terms</h2><p>Terms text</p></rh-dialog>
    <p id="details">Details</p>
  </main>`,
);

// PatternFly markup as PatternFly 6 renders a plain icon button, here with no name.
const PF_PAGE = page(
  'PatternFly',
  `<main><h1>PatternFly</h1>
  <button id="pf-plain" class="pf-v6-c-button pf-m-plain" type="button"><span class="pf-v6-c-button__icon"><svg aria-hidden="true" width="12" height="12"></svg></span></button>
  </main>`,
  false,
);

// Neither design system, with a class that only contains a PatternFly prefix and a custom element
// that only resembles an RHDS one.
const NEITHER = page(
  'Neither',
  `<main><h1>Neither</h1><div class="xpf-c-card">Card</div><x-rh-button>Not RHDS</x-rh-button>
  <div role="alert">Saved</div><button type="button"><svg aria-hidden="true" width="12" height="12"></svg></button></main>`,
  false,
);

// The only RHDS element sits in an open shadow root, or in a same-origin frame.
const IN_SHADOW = page(
  'RHDS in shadow',
  `<main><h1>Shadow</h1><x-host></x-host></main>
  <script>customElements.define('x-host', class extends HTMLElement { constructor() { super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<rh-cta>Shadow call to action</rh-cta>'; } });</script>`,
  false,
);
const IN_FRAME = page('RHDS in frame', '<main><h1>Frame</h1><iframe title="Inner" src="/inner-frame"></iframe></main>', false);
const INNER_FRAME = page('Inner', '<rh-cta>Frame call to action</rh-cta>', false);

// An rh-button whose definition never loads.
const NOT_UPGRADED = page('Not upgraded', '<main><h1>Not upgraded</h1><rh-button id="lonely"></rh-button></main>', false);

// The keyboard walk pages. rh-button renders its native button in an open shadow root that
// delegates focus. The closed host does the same in a closed root, which the walk cannot read.
const WALK_RH_BUTTON = page(
  'Walk',
  '<main><h1>Walk</h1><rh-button id="save">Save</rh-button><rh-button id="icon-only"></rh-button><button type="button">After</button></main>',
);
const WALK_CLOSED = page(
  'Walk closed',
  `<main><h1>Walk closed</h1><button type="button">Before</button><x-closed-button></x-closed-button><button type="button">After</button></main>
  <script>customElements.define('x-closed-button', class extends HTMLElement { constructor() { super();
    this.attachShadow({ mode: 'closed', delegatesFocus: true }).innerHTML = '<button type="button">Inside</button>'; } });</script>`,
  false,
);

const PAGES: Record<string, string> = {
  '/broken': BROKEN,
  '/correct': CORRECT,
  '/pf': PF_PAGE,
  '/neither': NEITHER,
  '/in-shadow': IN_SHADOW,
  '/in-frame': IN_FRAME,
  '/inner-frame': INNER_FRAME,
  '/not-upgraded': NOT_UPGRADED,
  '/walk-rh-button': WALK_RH_BUTTON,
  '/walk-closed': WALK_CLOSED,
};

interface Fixture {
  url(path: string): string;
  close(): Promise<void>;
}

async function serve(bundle: string): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/rhds.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(bundle);
      return;
    }
    const html = PAGES[path];
    if (html === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port');
  return {
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function inapplicable(screenId: string, layer: string, rules: readonly string[]): RuleApplicability[] {
  return rules.map((rule) => ({ screenId, layer, rule, outcome: 'inapplicable', elementCount: 0 }));
}

function packEntries(result: ProviderRunResult, layer: string): RuleApplicability[] {
  return result.applicability.filter((entry) => entry.layer === layer);
}

function rulesOf(drafts: Draft[], layer: string): string[] {
  return [...new Set(drafts.filter((draft) => draft.layer === layer).map((draft) => draft.rule))].sort();
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('RHDS rulepack and design-system markers, in Chromium', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const driver = makeRealBrowserDriver();
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await serve(await bundleRhds());
  }, REAL_PROCESS_BUDGET_MS);

  afterAll(async () => {
    await driver.close();
    await fixture.close();
  });

  async function open(path: string): Promise<Page> {
    const opened = await driver.open(fixture.url(path));
    await opened.gotoReady();
    return opened;
  }

  async function scan(path: string, withAxe = true): Promise<ProviderRunResult> {
    const opened = await open(path);
    try {
      const providers = [...(withAxe ? [axeProvider] : []), makeRulepackProvider(), makeRhdsRulepackProvider()];
      return await runProviders(providers, { page: opened, screen: { id: path.slice(1), url: fixture.url(path) }, config: testConfig() }, ['live']);
    } finally {
      await opened.close();
    }
  }

  it('fires every RHDS rule on the broken page, as a deterministic fail', async () => {
    const result = await scan('/broken');
    const rhds = result.drafts.filter((draft) => draft.layer === 'rhds');

    expect(rulesOf(rhds, 'rhds')).toEqual([...RHDS_RULES]);
    expect(rhds.every((draft) => draft.evidenceClass === 'deterministic' && draft.confidence === 'fail')).toBe(true);
    expect(rhds.map((draft) => [draft.rule, draft.elementPath]).sort()).toEqual(
      [
        ['rhds-accordion-header-parent', '#stray-header'],
        ['rhds-button-accessible-label', '#icon-only'],
        ['rhds-cta-link', '#cta-bare'],
        ['rhds-dialog-name', '#dialog-unnamed'],
        ['rhds-skip-link-target', '#skip-dangling'],
        ['rhds-skip-link-target', '#skip-missing'],
        ['rhds-switch-label', '#switch-unlabeled'],
        ['rhds-tabs-paired', '#tabs-unpaired'],
      ].sort(),
    );
    expect(JSON.stringify(rhds)).not.toContain('no-such-target');
    expect(result.gaps.filter((gap) => gap.ref.startsWith('provider:rhds-rulepack'))).toEqual([]);

    // axe reads the inner button through the open shadow root and reports it too.
    const buttonName = result.drafts.filter((draft) => draft.layer === 'axe' && draft.rule === 'button-name');
    expect(buttonName.map((draft) => draft.elementPath)).toContainEqual(expect.stringContaining('#icon-only'));

    // No PatternFly here, so the PatternFly pack shows it ran and matched nothing.
    expect(rulesOf(result.drafts, 'pf')).toEqual([]);
    expect(packEntries(result, 'pf')).toEqual(inapplicable('broken', 'pf', PF_RULES));
    expect(packEntries(result, 'rhds')).toEqual([]);
  });

  it('fires no RHDS rule on the correct page', async () => {
    const result = await scan('/correct');

    expect(result.drafts.filter((draft) => draft.layer === 'rhds')).toEqual([]);
    expect(result.gaps.filter((gap) => gap.ref.startsWith('provider:rhds-rulepack'))).toEqual([]);
    expect(result.drafts.filter((draft) => draft.rule === 'button-name')).toEqual([]);
    expect(packEntries(result, 'pf')).toEqual(inapplicable('correct', 'pf', PF_RULES));
    expect(packEntries(result, 'rhds')).toEqual([]);
  });

  it('gives a PatternFly page PatternFly findings and shows the RHDS pack as inapplicable', async () => {
    const result = await scan('/pf', false);

    expect(rulesOf(result.drafts, 'pf')).toContain('pf-icon-button-name');
    expect(rulesOf(result.drafts, 'rhds')).toEqual([]);
    expect(packEntries(result, 'rhds')).toEqual(inapplicable('pf', 'rhds', RHDS_RULES));
    expect(packEntries(result, 'pf')).toEqual([]);
  });

  it('gives a page with neither design system no pack findings and shows both packs as inapplicable', async () => {
    const result = await scan('/neither', false);

    expect(result.drafts).toEqual([]);
    expect(result.gaps).toEqual([]);
    // The runner moves the PatternFly pack, which clicks, after the read-only RHDS pack.
    expect(result.applicability).toEqual([...inapplicable('neither', 'rhds', RHDS_RULES), ...inapplicable('neither', 'pf', PF_RULES)]);
  });

  it('sees an RHDS element inside an open shadow root or a same-origin frame as RHDS on the page', async () => {
    for (const path of ['/in-shadow', '/in-frame']) {
      const result = await scan(path, false);
      expect(packEntries(result, 'rhds')).toEqual([]);
      // The rules read the top document, so the element inside is not checked. See ground truth.
      expect(rulesOf(result.drafts, 'rhds')).toEqual([]);
    }
  });

  it('reports an rh-button whose definition never loaded as unverified, never fail', async () => {
    const result = await scan('/not-upgraded', false);

    expect(result.drafts.filter((draft) => draft.layer === 'rhds')).toEqual([
      expect.objectContaining({ rule: 'rhds-button-accessible-label', elementPath: '#lonely', confidence: 'unverified' }),
    ]);
  });

  it('confirms keyboard focus on the inner button of an rh-button, which delegates focus', async () => {
    const opened = await open('/walk-rh-button');
    try {
      const drafts = draftsOf(await makeKeyboardWalkProvider({ tabCap: 20 }).run({ page: opened, screen: { id: 'walk', url: '' }, config: testConfig() }));

      expect(drafts.filter((draft) => draft.rule === 'keyboard-walk-unconfirmed-focus')).toEqual([]);
      expect(drafts.filter((draft) => draft.rule === 'keyboard-walk-truncated')).toEqual([]);
      // The walk reads the inner button itself: the labelled one is named, the icon-only one is not.
      expect(drafts.map((draft) => [draft.rule, draft.elementPath])).toEqual([['keyboard-walk-unnamed-interactive', '#icon-only >> button:nth-child(1)']]);
      expect(drafts[0]?.role).toBe('button');
    } finally {
      await opened.close();
    }
  });

  it('still reads focus inside a closed shadow root as unconfirmed', async () => {
    const opened = await open('/walk-closed');
    try {
      const drafts = draftsOf(await makeKeyboardWalkProvider({ tabCap: 20 }).run({ page: opened, screen: { id: 'walk', url: '' }, config: testConfig() }));

      expect(drafts).toEqual([
        expect.objectContaining({ rule: 'keyboard-walk-truncated', confidence: 'unverified', why: expect.stringContaining('closed shadow root') }),
      ]);
    } finally {
      await opened.close();
    }
  });
});
