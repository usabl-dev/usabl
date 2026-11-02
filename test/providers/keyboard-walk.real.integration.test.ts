import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Draft, Page } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { makeKeyboardWalkProvider } from '../../src/providers/keyboard-walk/index.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { draftsOf, testConfig } from '../helpers.js';

// A custom element whose open shadow root holds the given markup.
function openElement(tag: string, shadowHtml: string): string {
  return (
    `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { constructor() { super();` +
    ` this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(shadowHtml)}; } });</script>`
  );
}

// The same with a closed shadow root, which page script outside the element cannot reach.
function closedElement(tag: string, shadowHtml: string): string {
  return (
    `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { constructor() { super();` +
    ` this.attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(shadowHtml)}; } });</script>`
  );
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Walk</title></head><body><main>${body}</main></body></html>`;
}

const FRAME_DOC = '<!doctype html><html lang="en"><head><title>Inner</title></head><body><button>Inner one</button><button>Inner two</button></body></html>';

function pages(crossOrigin: string): Record<string, string> {
  return {
    // The case the walk got wrong: both shadow buttons read as the host, the second read as a
    // completed cycle, and the unnamed button after the component was never reached.
    '/two-shadow-buttons': page(
      '<button type="button">First</button><x-two></x-two><button type="button" id="trailing"></button>' +
        openElement('x-two', '<button type="button">Alpha</button><button type="button">Beta</button>'),
    ),
    '/three-shadow-buttons': page(
      '<button type="button">First</button><x-three></x-three><button type="button">Last</button>' +
        openElement(
          'x-three',
          '<button type="button">Alpha</button><button type="button">Beta</button><button type="button"></button>',
        ),
    ),
    // A shadow root inside a shadow root, each with more than one control.
    '/nested-shadow': page(
      '<x-outer></x-outer><button type="button" id="trailing"></button>' +
        openElement('x-inner', '<button type="button">Inner one</button><button type="button">Inner two</button>') +
        openElement('x-outer', '<button type="button">Outer</button><x-inner></x-inner>'),
    ),
    // A focus trap: Tab from the last shadow button goes back to the first, so focus never
    // reaches the body and the walk ends only by seeing a stop it has seen before.
    '/shadow-trap': page(
      '<x-trap></x-trap><button type="button" id="outside">Outside</button>' +
        `<script>customElements.define('x-trap', class extends HTMLElement { constructor() { super();` +
        ` const root = this.attachShadow({ mode: 'open' });` +
        ` root.innerHTML = '<button type="button">One</button><button type="button">Two</button>';` +
        ` const [one, two] = root.querySelectorAll('button');` +
        ` two.addEventListener('keydown', (event) => { if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); one.focus(); } }); } });` +
        ` customElements.whenDefined('x-trap').then(() => document.querySelector('x-trap').shadowRoot.querySelector('button').focus());</script>`,
    ),
    '/light-trap': page(
      '<button type="button" id="one">One</button><button type="button" id="two">Two</button><button type="button" id="outside">Outside</button>' +
        `<script>document.getElementById('two').addEventListener('keydown', (event) => {` +
        ` if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); document.getElementById('one').focus(); } });</script>`,
    ),
    '/closed-shadow-buttons': page(
      '<button type="button">First</button><x-closed></x-closed><button type="button" id="trailing"></button>' +
        closedElement('x-closed', '<button type="button">Alpha</button><button type="button">Beta</button>'),
    ),
    // A focusable host with a closed shadow root that holds nothing focusable. Focus sits on the
    // host itself, which the walk can name, so it walks on.
    '/closed-shadow-host': page(
      '<x-card tabindex="0" aria-label="Card"></x-card><button type="button" id="trailing"></button>' +
        closedElement('x-card', '<span>Card text</span>'),
    ),
    '/same-origin-frame': page(
      `<iframe title="Inner" srcdoc="${FRAME_DOC.replace(/"/g, '&quot;')}"></iframe><button type="button" id="trailing"></button>`,
    ),
    '/cross-origin-frame': page(
      `<button type="button">First</button><iframe title="Inner" src="${crossOrigin}/frame"></iframe><button type="button" id="trailing"></button>`,
    ),
    '/frame': FRAME_DOC,
    // Light markup only, with ids that name one element and ids that do not.
    '/light-only': page(
      '<nav><a href="#a" id="nav-link">Home</a></nav><div><span><button type="button">One</button></span>' +
        '<button type="button" id="dup">Two</button><button type="button" id="dup">Three</button></div>' +
        '<form><label>Name <input type="text" /></label></form>',
    ),
  };
}

interface Fixture {
  url: (path: string) => string;
  close: () => Promise<void>;
}

async function serve(): Promise<Fixture> {
  let served: Record<string, string> = {};
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const html = served[path];
    if (html === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server failed to bind a TCP port');
  // localhost and 127.0.0.1 are different origins, so a frame served from one inside a page
  // served from the other is a frame from another origin.
  served = pages(`http://localhost:${address.port}`);
  return {
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const SCREEN = { id: 'walk', url: 'http://127.0.0.1/walk' };

async function walk(page: Page): Promise<Draft[]> {
  const provider = makeKeyboardWalkProvider({ tabCap: 40 });
  return draftsOf(await provider.run({ page, screen: SCREEN, config: testConfig() }));
}

function summary(drafts: Draft[]): Array<[string, string]> {
  return drafts.map((draft) => [draft.rule, draft.elementPath]);
}

// Each test opens a real page and walks it in Chromium, a few seconds when the machine is idle. The
// budget is set well above that, so machine load cannot decide the outcome.
const WALK_BUDGET_MS = 30_000;

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('keyboard walk through shadow roots and frames, in Chromium', { timeout: WALK_BUDGET_MS }, () => {
  const driver = makeRealBrowserDriver();
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await serve();
  });

  afterAll(async () => {
    await driver.close();
    await fixture.close();
  });

  async function open(path: string): Promise<Page> {
    const opened = await driver.open(fixture.url(path));
    await opened.gotoReady();
    return opened;
  }

  async function paths(page: Page, tabs: number): Promise<string[]> {
    await page.focusBody();
    const stops = await makeStepRunner().run(page, Array.from({ length: tabs }, () => ({ do: 'tab' })));
    return stops.map((stop) => stop.elementPath);
  }

  it('reports the unnamed button after a component with two shadow buttons', async () => {
    const opened = await open('/two-shadow-buttons');
    try {
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-unnamed-interactive', '#trailing']]);
    } finally {
      await opened.close();
    }
  });

  it('gives each shadow button its own stop and reports the unnamed one', async () => {
    const opened = await open('/three-shadow-buttons');
    try {
      const stops = await paths(opened, 5);
      expect(new Set(stops).size).toBe(5);
      expect(stops.slice(1, 4)).toEqual([
        'html > body:nth-child(2) > main:nth-child(1) > x-three:nth-child(2) >> button:nth-child(1)',
        'html > body:nth-child(2) > main:nth-child(1) > x-three:nth-child(2) >> button:nth-child(2)',
        'html > body:nth-child(2) > main:nth-child(1) > x-three:nth-child(2) >> button:nth-child(3)',
      ]);
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([
        ['keyboard-walk-unnamed-interactive', 'html > body:nth-child(2) > main:nth-child(1) > x-three:nth-child(2) >> button:nth-child(3)'],
      ]);
      expect(drafts[0]?.role).toBe('button');
    } finally {
      await opened.close();
    }
  });

  it('walks a shadow root inside a shadow root to the control after it', async () => {
    const opened = await open('/nested-shadow');
    try {
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-unnamed-interactive', '#trailing']]);
    } finally {
      await opened.close();
    }
  });

  it('reads the accessibility node of the shadow control that has focus, not its host', async () => {
    const opened = await open('/two-shadow-buttons');
    try {
      await opened.focusBody();
      await opened.tab();
      await opened.tab();
      expect(await opened.activeNode()).toMatchObject({ name: 'Alpha', role: 'button' });
      expect(await opened.activeFocusUnreadable()).toBeNull();
      await opened.tab();
      expect(await opened.activeNode()).toMatchObject({ name: 'Beta', role: 'button' });
    } finally {
      await opened.close();
    }
  });

  it('reads no accessibility node for focus inside a closed shadow root', async () => {
    const opened = await open('/closed-shadow-buttons');
    try {
      await opened.focusBody();
      await opened.tab();
      expect(await opened.activeFocusUnreadable()).toBeNull();
      await opened.tab();
      expect(await opened.activeFocusUnreadable()).toBe('closed-shadow-root');
      expect(await opened.activeNode()).toBeNull();
    } finally {
      await opened.close();
    }
  });

  it('still ends on a real focus cycle inside a shadow root, with no truncation', async () => {
    const opened = await open('/shadow-trap');
    try {
      const stops = await paths(opened, 4);
      expect(stops[0]).toBe(stops[2]);
      expect(stops[0]).not.toBe(stops[1]);
      const drafts = await walk(opened);
      expect(drafts).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it('still ends on a real focus cycle in the light tree, with no truncation', async () => {
    const opened = await open('/light-trap');
    try {
      const stops = await paths(opened, 3);
      expect(stops).toEqual(['#one', '#two', '#one']);
      expect(await walk(opened)).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it('discloses a truncated walk when focus moves into a closed shadow root', async () => {
    const opened = await open('/closed-shadow-buttons');
    try {
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-truncated', '']]);
      expect(drafts[0]?.confidence).toBe('unverified');
      expect(drafts[0]?.why).toContain('closed shadow root');
    } finally {
      await opened.close();
    }
  });

  it('walks past a focusable host whose closed shadow root holds no focus', async () => {
    const opened = await open('/closed-shadow-host');
    try {
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-unnamed-interactive', '#trailing']]);
    } finally {
      await opened.close();
    }
  });

  it('walks the controls of a same-origin frame and the control after it', async () => {
    const opened = await open('/same-origin-frame');
    try {
      const stops = await paths(opened, 3);
      expect(new Set(stops).size).toBe(3);
      expect(stops[0]).toContain('iframe:nth-child(1) >> internal:control=enter-frame >> ');
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-unnamed-interactive', '#trailing']]);
    } finally {
      await opened.close();
    }
  });

  it('discloses a truncated walk when focus moves into a frame from another origin', async () => {
    const opened = await open('/cross-origin-frame');
    try {
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-truncated', '']]);
      expect(drafts[0]?.why).toContain('frame from another origin');
    } finally {
      await opened.close();
    }
  });

  it('keeps the path of every element outside shadow roots and frames as it was', async () => {
    const opened = await open('/light-only');
    try {
      // The path a selector read gives each element is the one stop paths used before shadow
      // roots and frames were followed. A Tab stop on the same element must give the same path.
      const expected = (await opened.queryAll('a, button, input')).map((ref) => ref.selector);
      expect(expected).toHaveLength(5);
      expect(await paths(opened, 5)).toEqual(expected);
    } finally {
      await opened.close();
    }
  });
});
