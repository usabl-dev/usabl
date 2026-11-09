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

// A whole document for a frame, with the given body.
function frameDoc(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Inner</title></head><body>${body}</body></html>`;
}

const FRAME_STEP = ' >> internal:control=enter-frame >> ';

// Tab from the button with id b sends focus back to the button with id a.
const TRAP_SCRIPT =
  `document.getElementById('b').addEventListener('keydown', (event) => {` +
  ` if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); document.getElementById('a').focus(); } });`;

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
    // A dialog element opened with showModal() on load, with nothing but the browser's own focus
    // handling.
    '/native-modal': page(
      '<dialog id="dialog"><button type="button" id="a">A</button><button type="button" id="b">B</button></dialog>' +
        '<button type="button" id="outside">Outside</button>' +
        `<script>document.getElementById('dialog').showModal();</script>`,
    ),
    // The same dialog with a script focus trap of its own, as a dialog library adds.
    '/native-modal-trap': page(
      '<dialog id="dialog"><button type="button" id="a">A</button><button type="button" id="b">B</button></dialog>' +
        '<button type="button" id="outside">Outside</button>' +
        `<script>document.getElementById('dialog').showModal(); ${TRAP_SCRIPT}</script>`,
    ),
    // A dialog element opened with show(), which is not modal: the rest of the page stays live, so
    // a script trap inside it is a keyboard trap.
    '/non-modal-dialog-trap': page(
      '<dialog id="dialog"><button type="button" id="a">A</button><button type="button" id="b">B</button></dialog>' +
        '<button type="button" id="outside">Outside</button>' +
        `<script>document.getElementById('dialog').show(); ${TRAP_SCRIPT}</script>`,
    ),
    // An ARIA modal dialog shown on load with a script focus trap.
    '/aria-modal-trap': page(
      '<div role="dialog" aria-modal="true" aria-label="Settings" id="dialog"><button type="button" id="a">A</button>' +
        '<button type="button" id="b">B</button></div><button type="button" id="outside">Outside</button>' +
        `<script>${TRAP_SCRIPT}</script>`,
    ),
    // The same, with aria-modal false: a trap in a dialog that does not claim to be modal.
    '/aria-non-modal-trap': page(
      '<div role="dialog" aria-modal="false" aria-label="Settings" id="dialog"><button type="button" id="a">A</button>' +
        '<button type="button" id="b">B</button></div><button type="button" id="outside">Outside</button>' +
        `<script>${TRAP_SCRIPT}</script>`,
    ),
    // An ARIA modal dialog inside the shadow root of a web component, with the trapped buttons in
    // the light tree, slotted into it. Only a climb of the flat tree finds the dialog above them.
    '/slotted-modal-trap': page(
      '<x-modal><button type="button" id="a">A</button><button type="button" id="b">B</button></x-modal>' +
        '<button type="button" id="outside">Outside</button>' +
        openElement('x-modal', '<div role="dialog" aria-modal="true" aria-label="Settings"><slot></slot></div>') +
        `<script>${TRAP_SCRIPT}</script>`,
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
    // A frame inside an open shadow root.
    '/frame-in-shadow': page(
      '<x-framer></x-framer><button type="button" id="trailing"></button>' +
        openElement('x-framer', '<iframe title="Inner" src="/frame"></iframe>'),
    ),
    // An open shadow root inside a frame.
    '/shadow-frame-doc': frameDoc(
      '<x-pair></x-pair>' + openElement('x-pair', '<button type="button">Alpha</button><button type="button">Beta</button>'),
    ),
    '/shadow-in-frame': page('<iframe title="Inner" src="/shadow-frame-doc"></iframe><button type="button" id="trailing"></button>'),
    // A frame inside a frame, each with more than one control.
    '/outer-frame-doc': frameDoc('<button type="button">Outer</button><iframe title="Innermost" src="/frame"></iframe>'),
    '/nested-frames': page('<iframe title="Outer" src="/outer-frame-doc"></iframe><button type="button" id="trailing"></button>'),
    // A closed shadow root inside a same-origin frame.
    '/closed-shadow-frame-doc': frameDoc(
      '<x-closed></x-closed>' + closedElement('x-closed', '<button type="button">Alpha</button><button type="button">Beta</button>'),
    ),
    '/closed-shadow-in-frame': page(
      '<iframe title="Inner" src="/closed-shadow-frame-doc"></iframe><button type="button" id="trailing"></button>',
    ),
    // A same-origin document shown by an object element. document.activeElement reads the object
    // for every control inside it, so the second control would read as a completed cycle.
    '/object-frame': page(
      '<button type="button">First</button><object data="/frame" type="text/html" aria-label="Form" width="300" height="80"></object>' +
        '<button type="button" id="trailing"></button>',
    ),
    // Pages for the end of the walk: what one more Tab after the body does.
    '/end-three': page('<button type="button" id="one">One</button><a href="#x" id="two">Two</a><input id="three" aria-label="Three" />'),
    '/end-one': page('<button type="button" id="only">Only</button>'),
    '/end-none': page('<p>Nothing here can take focus.</p>'),
    // A focus handler that blurs its control, so focus falls to the body in the middle of the page.
    '/end-blur': page(
      '<button type="button">One</button><button type="button" id="blurs">Two</button><button type="button">Three</button>' +
        `<script>document.getElementById('blurs').addEventListener('focus', (event) => event.target.blur());</script>`,
    ),
    // The same on the first control, so the walk reaches no stop before focus falls to the body.
    '/end-blur-first': page(
      '<button type="button" id="blurs">One</button><button type="button">Two</button>' +
        `<script>document.getElementById('blurs').addEventListener('focus', (event) => event.target.blur());</script>`,
    ),
    // A keydown handler that swallows Tab on the second control and drops focus to the body.
    '/end-swallow': page(
      '<button type="button">One</button><button type="button" id="swallows">Two</button><button type="button">Three</button>' +
        `<script>document.addEventListener('keydown', (event) => { const swallows = document.getElementById('swallows');` +
        ` if (event.key === 'Tab' && document.activeElement === swallows) { event.preventDefault(); swallows.blur(); } });</script>`,
    ),
    // A banner whose dismiss control is the first stop and goes away during the walk, as a timed
    // banner does. Removing it shifts the position of every control after it.
    '/end-banner': page(
      '<div id="banner"><button type="button">Dismiss</button></div><button type="button">One</button><button type="button" id="last">Two</button>' +
        `<script>document.getElementById('last').addEventListener('focus', () => document.getElementById('banner')?.remove());</script>`,
    ),
    // A list that re-renders while it is walked: a new item is put first, so every item moves down.
    '/end-rerender': page(
      '<ul id="list"><li><button type="button">A</button></li><li><button type="button">B</button></li><li><button type="button" id="last">C</button></li></ul>' +
        `<script>document.getElementById('last').addEventListener('focus', () => { const item = document.createElement('li');` +
        ` item.innerHTML = '<button type="button">New</button>'; document.getElementById('list').prepend(item); }, { once: true });</script>`,
    ),
    // A skip link before the content it skips to.
    '/end-skip-link': `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Walk</title></head><body>` +
      '<a href="#content">Skip to content</a><nav><a href="#home">Home</a></nav>' +
      '<main id="content" tabindex="-1"><button type="button">Save</button></main></body></html>',
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

  // A focus trap the walk read as a completed cycle: it reported nothing, so the screen read as
  // covered while the Outside button after the trap was never reached.
  it('reports a keyboard trap inside a shadow root and ends with a truncation gap', async () => {
    const opened = await open('/shadow-trap');
    try {
      const stops = await paths(opened, 4);
      expect(stops[0]).toBe(stops[2]);
      expect(stops[0]).not.toBe(stops[1]);
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([
        ['keyboard-walk-trap', stops[0]],
        ['keyboard-walk-truncated', ''],
      ]);
      expect(drafts[0]).toMatchObject({ severity: 'critical', confidence: 'fail', evidenceClass: 'deterministic', elementName: null });
      expect(drafts[0]?.evidence.extra?.['cycle']).toEqual([stops[0], stops[1]]);
      expect(drafts[1]?.confidence).toBe('unverified');
      expect(drafts[1]?.why).toContain('controls after the trap were never walked');
    } finally {
      await opened.close();
    }
  });

  it('reports a keyboard trap in the light tree and ends with a truncation gap', async () => {
    const opened = await open('/light-trap');
    try {
      const stops = await paths(opened, 3);
      expect(stops).toEqual(['#one', '#two', '#one']);
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([
        ['keyboard-walk-trap', '#one'],
        ['keyboard-walk-truncated', ''],
      ]);
      expect(drafts[0]?.evidence.extra?.['cycle']).toEqual(['#one', '#two']);
      // The trapped buttons are named One and Two. No page text reaches the drafts.
      expect(JSON.stringify(drafts)).not.toMatch(/One|Two/);
    } finally {
      await opened.close();
    }
  });

  // A dialog opened with showModal() and no script trap lets Tab leave the document after its last
  // control, so focus reaches the body and the walk ends complete. The content behind the dialog is
  // inert then: out of reach of the keyboard and left out of the accessibility tree.
  it('walks a dialog opened with showModal() to the body when no script keeps focus in it', async () => {
    const opened = await open('/native-modal');
    try {
      const stops = await paths(opened, 2);
      expect(stops).toEqual(['#b', 'html > body:nth-child(2)']);
      expect(await walk(opened)).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  for (const [path, dialog] of [
    ['/native-modal-trap', '#dialog'],
    ['/aria-modal-trap', '#dialog'],
    ['/slotted-modal-trap', 'html > body:nth-child(2) > main:nth-child(1) > x-modal:nth-child(1) >> div:nth-child(1)'],
  ] as const) {
    it(`ends with a gap and no trap when focus cycles inside an open modal dialog (${path})`, async () => {
      const opened = await open(path);
      try {
        await opened.focusBody();
        await opened.tab();
        expect(await opened.activeModalDialogs()).toEqual([dialog]);
        const drafts = await walk(opened);
        expect(summary(drafts)).toEqual([['keyboard-walk-truncated', '']]);
        expect(drafts[0]?.confidence).toBe('unverified');
        expect(drafts[0]?.why).toContain('inside one open modal dialog');
        expect(drafts[0]?.why).toContain('the rest of the page was not walked');
      } finally {
        await opened.close();
      }
    });
  }

  for (const path of ['/non-modal-dialog-trap', '/aria-non-modal-trap']) {
    it(`reports a keyboard trap inside a dialog that is not modal (${path})`, async () => {
      const opened = await open(path);
      try {
        await opened.focusBody();
        await opened.tab();
        expect(await opened.activeModalDialogs()).toEqual([]);
        const drafts = await walk(opened);
        expect(summary(drafts)).toEqual([
          ['keyboard-walk-trap', '#a'],
          ['keyboard-walk-truncated', ''],
        ]);
        expect(drafts[0]?.evidence.extra?.['cycle']).toEqual(['#a', '#b']);
      } finally {
        await opened.close();
      }
    });
  }

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

  it('walks a frame inside a shadow root to the control after it', async () => {
    const opened = await open('/frame-in-shadow');
    try {
      const stops = await paths(opened, 2);
      expect(new Set(stops).size).toBe(2);
      for (const stop of stops) expect(stop).toContain(' >> iframe:nth-child(1)' + FRAME_STEP);
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-unnamed-interactive', '#trailing']]);
    } finally {
      await opened.close();
    }
  });

  it('walks a shadow root inside a frame to the control after it', async () => {
    const opened = await open('/shadow-in-frame');
    try {
      const stops = await paths(opened, 2);
      expect(new Set(stops).size).toBe(2);
      for (const stop of stops) {
        expect(stop).toContain(FRAME_STEP);
        expect(stop.indexOf(' >> button:nth-child(')).toBeGreaterThan(stop.indexOf(FRAME_STEP));
      }
      await opened.focusBody();
      await opened.tab();
      expect(await opened.activeNode()).toMatchObject({ name: 'Alpha', role: 'button' });
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-unnamed-interactive', '#trailing']]);
    } finally {
      await opened.close();
    }
  });

  it('walks a frame inside a frame to the control after it', async () => {
    const opened = await open('/nested-frames');
    try {
      const stops = await paths(opened, 3);
      expect(new Set(stops).size).toBe(3);
      expect(stops[0]?.split(FRAME_STEP)).toHaveLength(2);
      expect(stops[1]?.split(FRAME_STEP)).toHaveLength(3);
      expect(stops[2]?.split(FRAME_STEP)).toHaveLength(3);
      await opened.focusBody();
      await opened.tab();
      await opened.tab();
      expect(await opened.activeNode()).toMatchObject({ name: 'Inner one', role: 'button' });
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-unnamed-interactive', '#trailing']]);
    } finally {
      await opened.close();
    }
  });

  it('discloses a truncated walk when focus moves into a closed shadow root inside a frame', async () => {
    const opened = await open('/closed-shadow-in-frame');
    try {
      await opened.focusBody();
      await opened.tab();
      expect(await opened.activeFocusUnreadable()).toBe('closed-shadow-root');
      expect(await opened.activeNode()).toBeNull();
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-truncated', '']]);
      expect(drafts[0]?.why).toContain('closed shadow root');
    } finally {
      await opened.close();
    }
  });

  it('discloses a truncated walk when focus moves into the frame of an object element', async () => {
    const opened = await open('/object-frame');
    try {
      const drafts = await walk(opened);
      expect(summary(drafts)).toEqual([['keyboard-walk-truncated', '']]);
      expect(drafts[0]?.confidence).toBe('unverified');
      expect(drafts[0]?.why).toContain('object');
      // Wherever the object's controls sit in the tab order, a stop inside them reads as unreadable.
      await opened.focusBody();
      const reasons: Array<string | null> = [];
      for (let i = 0; i < 4; i += 1) {
        await opened.tab();
        reasons.push(await opened.activeFocusUnreadable());
      }
      expect(reasons[0]).toBeNull();
      expect(reasons).toContain('frame-unreadable');
    } finally {
      await opened.close();
    }
  });

  // What Chromium does when Tab is pressed after the last tabbable control. The walk confirms its
  // end with one more Tab, so this records the browser behaviour that rule rests on. Each entry is
  // the path of the focused element, or 'BODY' when the body has focus.
  async function tabTrail(page: Page, tabs: number): Promise<string[]> {
    await page.focusBody();
    const trail: string[] = [];
    for (let i = 0; i < tabs; i += 1) {
      await page.tab();
      trail.push((await page.activeElementIs('body')) ? 'BODY' : await page.activePath());
    }
    return trail;
  }

  it('Chromium: after the last of three controls, Tab goes to the body, and the next Tab goes back to the first control', async () => {
    const opened = await open('/end-three');
    try {
      expect(await tabTrail(opened, 6)).toEqual(['#one', '#two', '#three', 'BODY', '#one', '#two']);
    } finally {
      await opened.close();
    }
  });

  it('Chromium: with one control, Tab goes to the body, and the next Tab goes back to that control', async () => {
    const opened = await open('/end-one');
    try {
      expect(await tabTrail(opened, 4)).toEqual(['#only', 'BODY', '#only', 'BODY']);
    } finally {
      await opened.close();
    }
  });

  it('Chromium: with no control, every Tab leaves focus on the body', async () => {
    const opened = await open('/end-none');
    try {
      expect(await tabTrail(opened, 3)).toEqual(['BODY', 'BODY', 'BODY']);
    } finally {
      await opened.close();
    }
  });

  // The end of the walk is confirmed by one more Tab, which must land on a stop already walked.
  // Focus that falls to the body in the middle of the page fails that check.
  for (const path of ['/end-blur', '/end-blur-first', '/end-swallow']) {
    it(`ends with a truncation gap when a handler drops focus to the body mid page (${path})`, async () => {
      const opened = await open(path);
      try {
        const drafts = await walk(opened);
        expect(summary(drafts)).toEqual([['keyboard-walk-truncated', '']]);
        expect(drafts[0]?.confidence).toBe('unverified');
        expect(drafts[0]?.why).toContain('one more Tab');
      } finally {
        await opened.close();
      }
    });
  }

  // Ordinary pages whose walk must still end complete.
  for (const path of ['/end-three', '/end-one', '/end-none', '/end-banner', '/end-rerender', '/end-skip-link']) {
    it(`ends complete on an ordinary page (${path})`, async () => {
      const opened = await open(path);
      try {
        expect(await walk(opened)).toEqual([]);
      } finally {
        await opened.close();
      }
    });
  }

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
