import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type CDPSession } from 'playwright';
import { adoptPage, makeRealBrowserDriver } from '../../src/deps/real.js';
import type { Page } from '../../src/contracts/index.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { draftsOf, testConfig } from '../helpers.js';

// While a dialog opened with showModal() is open, Chromium leaves everything outside it out of the
// accessibility tree, with the ignored reason activeModalDialog, so a screen reader says nothing
// for a live region there. The capture must not record it either, or a flow requirement passes on
// words nobody heard. Each case changes polite regions by page script, reads what the capture
// heard, and checks each region against the accessibility tree at the same moment.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Modal</title></head><body>
  <main>
    <div aria-live="polite" id="outside"></div>
    <dialog id="first"><p>First</p><div aria-live="polite" id="in-first"></div>
      <dialog id="nested"><p>Nested</p><div aria-live="polite" id="in-nested"></div></dialog>
    </dialog>
    <dialog id="second"><p>Second</p><div aria-live="polite" id="in-second"></div></dialog>
    <x-shadow-dialog id="host"></x-shadow-dialog>
    <x-slot-dialog id="slot-host"><div aria-live="polite" id="slotted"></div></x-slot-dialog>
    <div id="aria-wrap"><div role="dialog" aria-modal="true" aria-label="Aria" id="aria" hidden><p>Aria</p><div aria-live="polite" id="in-aria"></div></div></div>
    <x-closed-aria id="closed-aria"></x-closed-aria>
    <iframe id="frame" title="Framed" srcdoc="<!doctype html><title>Framed</title><dialog id='framed'><p>Framed</p></dialog>"></iframe>
  </main>
  <script>
    customElements.define('x-shadow-dialog', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<dialog><p>Shadow</p></dialog>';
      }
    });
    customElements.define('x-slot-dialog', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<dialog><p>Slot</p><slot></slot></dialog>';
      }
    });
    customElements.define('x-closed-aria', class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'closed' });
        root.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Closed" hidden><p>Closed</p></div>';
        this.show = () => root.querySelector('[role=dialog]').removeAttribute('hidden');
      }
    });
    window.say = (id, text) => { document.getElementById(id).textContent = text; };
    // Resolves once the frame's document is ready, then opens the dialog inside it as a modal.
    window.openFramedModal = () => new Promise((resolve) => {
      const frame = document.getElementById('frame');
      const open = () => { frame.contentDocument.getElementById('framed').showModal(); resolve(); };
      const ready = frame.contentDocument && frame.contentDocument.readyState === 'complete' && frame.contentDocument.getElementById('framed');
      if (ready) open(); else frame.addEventListener('load', open, { once: true });
    });
  </script>
</body></html>`;

interface Heard {
  heard: boolean;
  exposed: boolean;
  reasons: string[];
}

async function regionState(cdp: CDPSession, ids: readonly string[], drained: readonly string[]): Promise<Record<string, Heard>> {
  const out: Record<string, Heard> = {};
  for (const id of ids) {
    const handle = await cdp.send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)})` });
    const objectId = handle.result.objectId;
    if (objectId === undefined) throw new Error(`no element #${id}`);
    const described = await cdp.send('DOM.describeNode', { objectId });
    const tree = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: described.node.backendNodeId, fetchRelatives: false });
    const node = tree.nodes[0];
    out[id] = {
      heard: drained.includes(`said in ${id}`),
      exposed: node !== undefined && node.ignored !== true,
      reasons: (node?.ignoredReasons ?? []).map((reason) => reason.name).sort(),
    };
  }
  return out;
}

// The rule matches the browser: a region is heard exactly when the tree exposes it.
function expectMatchesTree(state: Record<string, Heard>): void {
  for (const [id, region] of Object.entries(state)) {
    expect({ id, heard: region.heard }).toEqual({ id, heard: region.exposed });
  }
}

// Each test opens a real page in Chromium, under a second when the machine is idle; the flow test
// launches its own browser. The budget is set well above that, so machine load cannot decide the
// outcome.
const BROWSER_BUDGET_MS = 30_000;

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('the announcement capture and an open modal dialog, in Chromium', { timeout: BROWSER_BUDGET_MS }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  async function scenario(
    setup: string,
    ids: readonly string[],
  ): Promise<Record<string, Heard>> {
    const context = await browser.newContext();
    try {
      const pw = await context.newPage();
      await pw.setContent(PAGE, { waitUntil: 'domcontentloaded' });
      const page: Page = await adoptPage(pw);
      const cdp = await context.newCDPSession(pw);
      await cdp.send('Accessibility.enable');
      await pw.evaluate(setup);
      await page.drainAnnouncements();
      await pw.evaluate(`for (const id of ${JSON.stringify(ids)}) window.say(id, 'said in ' + id);`);
      const drained = await page.drainAnnouncements();
      const state = await regionState(cdp, ids, drained);
      // The capture never hears a region the tree leaves out. Hearing less can only fail a flow
      // requirement; hearing more can pass one on words nobody heard.
      for (const [id, region] of Object.entries(state)) {
        if (region.heard) expect({ id, exposed: region.exposed }).toEqual({ id, exposed: true });
      }
      return state;
    } finally {
      await context.close();
    }
  }

  it('does not hear a region outside an open modal, and hears one inside it', async () => {
    const state = await scenario(`document.getElementById('first').showModal()`, ['outside', 'in-first']);
    expect(state['outside']).toEqual({ heard: false, exposed: false, reasons: ['activeModalDialog'] });
    expect(state['in-first']?.heard).toBe(true);
    expectMatchesTree(state);
  });

  it('hears the region outside again once the modal closes', async () => {
    const state = await scenario(
      `document.getElementById('first').showModal(); document.getElementById('first').close()`,
      ['outside'],
    );
    expect(state['outside']).toEqual({ heard: true, exposed: true, reasons: [] });
    expectMatchesTree(state);
  });

  it('hears every region when a dialog is opened without showModal', async () => {
    const state = await scenario(`document.getElementById('first').show()`, ['outside', 'in-first']);
    expect(state['outside']?.heard).toBe(true);
    expect(state['in-first']?.heard).toBe(true);
    expectMatchesTree(state);
  });

  it('does not hear a region in the outer modal when a nested modal is on top', async () => {
    const state = await scenario(
      `document.getElementById('first').showModal(); document.getElementById('nested').showModal()`,
      ['outside', 'in-first', 'in-nested'],
    );
    expect(state['outside']?.heard).toBe(false);
    expect(state['in-first']).toEqual({ heard: false, exposed: false, reasons: ['activeModalDialog'] });
    expect(state['in-nested']?.heard).toBe(true);
    expectMatchesTree(state);
  });

  it('hears nothing in two open sibling modals, where the browser exposes the top one', async () => {
    const state = await scenario(
      `document.getElementById('first').showModal(); document.getElementById('second').showModal()`,
      ['outside', 'in-first', 'in-second'],
    );
    // Which open modal is on top is not in the DOM, so the capture hears only content inside every
    // open modal. Here that is nothing, while the browser still exposes the top one. The capture
    // hears less than a screen reader would, which can fail a flow requirement but never pass one.
    expect(state['outside']).toMatchObject({ heard: false, exposed: false });
    expect(state['in-first']).toMatchObject({ heard: false, exposed: false });
    expect(state['in-second']).toMatchObject({ heard: false, exposed: true });
  });

  it('does not hear a region outside a modal opened inside an open shadow root', async () => {
    const state = await scenario(
      `document.getElementById('host').shadowRoot.querySelector('dialog').showModal()`,
      ['outside'],
    );
    expect(state['outside']).toEqual({ heard: false, exposed: false, reasons: ['activeModalDialog'] });
    expectMatchesTree(state);
  });

  it('hears a region slotted into a modal that lives in a shadow root, and not one outside', async () => {
    const state = await scenario(
      `document.getElementById('slot-host').shadowRoot.querySelector('dialog').showModal()`,
      ['outside', 'slotted'],
    );
    expect(state['slotted']).toEqual({ heard: true, exposed: true, reasons: [] });
    expect(state['outside']).toEqual({ heard: false, exposed: false, reasons: ['activeModalDialog'] });
    expectMatchesTree(state);
  });

  it('still hears the document when a modal opens inside a frame, which blocks only that frame', async () => {
    const state = await scenario(`window.openFramedModal()`, ['outside']);
    expect(state['outside']).toEqual({ heard: true, exposed: true, reasons: [] });
    expectMatchesTree(state);
  });

  // A page writes a region, and a later task opens a modal before the browser updates the
  // accessibility tree. The change was observed with no modal open, so only a check at drain sees
  // that the region is now outside an open modal.
  it('decides by the modal state at drain when a modal opens after the change was observed', async () => {
    const context = await browser.newContext();
    try {
      const pw = await context.newPage();
      await pw.setContent(PAGE, { waitUntil: 'domcontentloaded' });
      const page: Page = await adoptPage(pw);
      const cdp = await context.newCDPSession(pw);
      await cdp.send('Accessibility.enable');
      // The dialog is open, though not modal, when the region inside it is written, so the
      // region is in the accessibility tree at the write. A later task makes it modal.
      await pw.evaluate(`document.getElementById('first').show()`);
      await page.drainAnnouncements();
      await pw.evaluate(`new Promise((resolve) => {
        window.say('outside', 'said in outside');
        window.say('in-first', 'said in in-first');
        setTimeout(() => { const first = document.getElementById('first'); first.close(); first.showModal(); resolve(); }, 0);
      })`);
      const record = await page.drainAnnouncementRecord();
      expect(record.undecidable).toBeNull();
      const state = await regionState(cdp, ['outside', 'in-first'], record.texts);
      expect(state['outside']).toEqual({ heard: false, exposed: false, reasons: ['activeModalDialog'] });
      expect(state['in-first']?.heard).toBe(true);
      expectMatchesTree(state);
    } finally {
      await context.close();
    }
  });

  it('says it cannot decide when a changed region left the document and a modal is open', async () => {
    const context = await browser.newContext();
    try {
      const pw = await context.newPage();
      await pw.setContent(PAGE, { waitUntil: 'domcontentloaded' });
      const page: Page = await adoptPage(pw);
      await page.drainAnnouncements();
      await pw.evaluate(`new Promise((resolve) => {
        window.say('outside', 'said in outside');
        setTimeout(() => { document.getElementById('outside').remove(); document.getElementById('first').showModal(); resolve(); }, 0);
      })`);
      expect(await page.drainAnnouncementRecord()).toEqual({ texts: [], undecidable: 'changed-element-removed' });
    } finally {
      await context.close();
    }
  });

  // A modal dialog inside a closed shadow root cannot be seen from the capture's world, so the
  // capture cannot tell which regions it hides. A flow requirement must not pass on text heard
  // while one is open: it is a gap.
  it('makes a flow a gap when a modal is open inside a closed shadow root', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title></head><body>
      <main><button type="button" id="save">Save</button><div aria-live="polite" id="message"></div>
      <x-closed-modal id="host"></x-closed-modal></main>
      <script>
        customElements.define('x-closed-modal', class extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: 'closed' });
            root.innerHTML = '<dialog><p>Saving</p><button type="button">Close</button></dialog>';
            this.openModal = () => root.querySelector('dialog').showModal();
          }
        });
        document.getElementById('save').addEventListener('click', () => {
          document.getElementById('host').openModal();
          document.getElementById('message').textContent = 'Saved';
        });
      </script>
    </body></html>`;
    const driver = makeRealBrowserDriver();
    try {
      const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      try {
        // A closed dialog there hides nothing, so nothing is undecidable before the click.
        expect(await page.drainAnnouncementRecord()).toEqual({ texts: [], undecidable: null });
        const [provider] = mapRequirementsToProviders({
          version: 1,
          requirements: [
            {
              id: 'save-announces',
              kind: 'flow',
              surface: 'clusters',
              description: 'Saving announces that the change was saved.',
              assertion: { type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Saved' },
              approved: true,
            },
          ],
        });
        if (provider === undefined) throw new Error('no flow provider');
        const drafts = draftsOf(
          await provider.run({ page, screen: { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' }, config: testConfig() }),
        );
        expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:save-announces', 'unverified']]);
        expect(drafts[0]?.why).toContain('closed shadow root');
      } finally {
        await page.close();
      }
    } finally {
      await driver.close();
    }
  });

  // usabl's own rule for aria-modal, not Chromium's tree: Chromium prunes for aria-modal only on Mac
  // and Android, so on Linux the tree still exposes the regions outside. Safari with VoiceOver hides
  // them whenever the dialog is shown, so the capture does too. These cases check the rule only.
  describe('a dialog with aria-modal', () => {
    async function heard(setup: string, ids: readonly string[]): Promise<Record<string, boolean>> {
      const state = await scenario(setup, ids);
      return Object.fromEntries(Object.entries(state).map(([id, region]) => [id, region.heard]));
    }
    const show = `document.getElementById('aria').removeAttribute('hidden')`;

    it('hears only inside a shown aria-modal dialog', async () => {
      expect(await heard(show, ['outside', 'in-aria'])).toEqual({ outside: false, 'in-aria': true });
    });

    it('hears outside again once the dialog is hidden', async () => {
      expect(await heard(`${show}; document.getElementById('aria').setAttribute('hidden', '')`, ['outside'])).toEqual({ outside: true });
    });

    for (const [why, setup] of [
      ['aria-modal is false', `${show}; document.getElementById('aria').setAttribute('aria-modal', 'false')`],
      ['its first recognized role is not dialog', `${show}; document.getElementById('aria').setAttribute('role', 'region dialog')`],
      ['it is not rendered', `${show}; document.getElementById('aria').style.display = 'none'`],
      ['it is hidden by visibility', `${show}; document.getElementById('aria').style.visibility = 'hidden'`],
      ['an ancestor is aria-hidden', `${show}; document.getElementById('aria-wrap').setAttribute('aria-hidden', 'true')`],
      ['an ancestor is inert', `${show}; document.getElementById('aria-wrap').inert = true`],
    ] as const) {
      it(`hears outside when ${why}`, async () => {
        expect(await heard(setup, ['outside'])).toEqual({ outside: true });
      });
    }

    for (const [why, setup] of [
      ['its role list starts with an unknown token', `${show}; document.getElementById('aria').setAttribute('role', 'banana alertdialog')`],
      ['aria-modal is TRUE', `${show}; document.getElementById('aria').setAttribute('aria-modal', 'TRUE')`],
    ] as const) {
      it(`does not hear outside when ${why}`, async () => {
        expect(await heard(setup, ['outside'])).toEqual({ outside: false });
      });
    }

    it('says it cannot decide while an aria-modal dialog inside a closed shadow root is shown', async () => {
      const context = await browser.newContext();
      try {
        const pw = await context.newPage();
        await pw.setContent(PAGE, { waitUntil: 'domcontentloaded' });
        const page: Page = await adoptPage(pw);
        expect((await page.drainAnnouncementRecord()).undecidable).toBeNull();
        await pw.evaluate(`document.getElementById('closed-aria').show(); window.say('outside', 'said in outside')`);
        expect((await page.drainAnnouncementRecord()).undecidable).toBe('closed-shadow-modal');
      } finally {
        await context.close();
      }
    });
  });

  // The false green end to end: a flow requirement that expects "Saved" passed on a polite region
  // outside the modal the same click opened, which no screen reader speaks.
  for (const [kind, opens, modal] of [
    ['a dialog opened with showModal()', "document.getElementById('confirm').showModal();", '<dialog id="confirm"><p>Saving</p><button type="button">Close</button></dialog>'],
    ['an aria-modal dialog', "document.getElementById('confirm').hidden = false;", '<div role="dialog" aria-modal="true" aria-label="Saving" id="confirm" hidden><button type="button">Close</button></div>'],
  ] as const) {
  it(`does not pass a flow requirement on a region outside ${kind} the step opened`, async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title></head><body>
      <main><button type="button" id="save">Save</button><div aria-live="polite" id="message"></div>
      ${modal}</main>
      <script>
        document.getElementById('save').addEventListener('click', () => {
          ${opens}
          document.getElementById('message').textContent = 'Saved';
        });
      </script>
    </body></html>`;
    const driver = makeRealBrowserDriver();
    try {
      const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      try {
        const [provider] = mapRequirementsToProviders({
          version: 1,
          requirements: [
            {
              id: 'save-announces',
              kind: 'flow',
              surface: 'clusters',
              description: 'Saving announces that the change was saved.',
              assertion: { type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Saved' },
              approved: true,
            },
          ],
        });
        if (provider === undefined) throw new Error('no flow provider');
        const drafts = draftsOf(
          await provider.run({ page, screen: { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' }, config: testConfig() }),
        );
        expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:save-announces', 'fail']]);
      } finally {
        await page.close();
      }
    } finally {
      await driver.close();
    }
  });
  }

  // A dialog that closes in the same task that writes a live region inside it. The observer runs
  // after the task, when the dialog is already closed and its content is out of the accessibility
  // tree, so no screen reader speaks the text. The capture recorded it anyway.
  it('does not hear a region inside a dialog that closed in the task that wrote it', async () => {
    const context = await browser.newContext();
    try {
      const pw = await context.newPage();
      await pw.setContent(PAGE, { waitUntil: 'domcontentloaded' });
      const page: Page = await adoptPage(pw);
      const cdp = await context.newCDPSession(pw);
      await cdp.send('Accessibility.enable');
      await pw.evaluate(`document.getElementById('first').showModal()`);
      await page.drainAnnouncements();
      await pw.evaluate(`window.say('in-first', 'said in in-first'); document.getElementById('first').close()`);
      const drained = await page.drainAnnouncements();
      const state = await regionState(cdp, ['in-first'], drained);
      expect(state['in-first']).toMatchObject({ heard: false, exposed: false });
      expectMatchesTree(state);
    } finally {
      await context.close();
    }
  });

  it('still hears a region inside a dialog that stays open after the write', async () => {
    const context = await browser.newContext();
    try {
      const pw = await context.newPage();
      await pw.setContent(PAGE, { waitUntil: 'domcontentloaded' });
      const page: Page = await adoptPage(pw);
      const cdp = await context.newCDPSession(pw);
      await cdp.send('Accessibility.enable');
      await pw.evaluate(`document.getElementById('first').showModal()`);
      await page.drainAnnouncements();
      await pw.evaluate(`window.say('in-first', 'said in in-first')`);
      const state = await regionState(cdp, ['in-first'], await page.drainAnnouncements());
      expect(state['in-first']).toEqual({ heard: true, exposed: true, reasons: [] });
    } finally {
      await context.close();
    }
  });

  // The dialog closes after the write, one task later or after an awaited promise. The observer
  // reads the change while the dialog is still open, but by the drain the dialog is closed and its
  // content is out of the accessibility tree. The hidden state at drain decides, as the modal state
  // does.
  for (const [when, closeLater] of [
    ['one task after the write', `setTimeout(() => { document.getElementById('first').close(); resolve(); }, 0);`],
    ['after a promise that follows the write', `Promise.resolve().then(() => { document.getElementById('first').close(); resolve(); });`],
  ] as const) {
    it(`does not hear a region inside a dialog that closed ${when}`, async () => {
      const context = await browser.newContext();
      try {
        const pw = await context.newPage();
        await pw.setContent(PAGE, { waitUntil: 'domcontentloaded' });
        const page: Page = await adoptPage(pw);
        const cdp = await context.newCDPSession(pw);
        await cdp.send('Accessibility.enable');
        await pw.evaluate(`document.getElementById('first').showModal()`);
        await page.drainAnnouncements();
        await pw.evaluate(`new Promise((resolve) => {
          window.say('in-first', 'said in in-first');
          ${closeLater}
        })`);
        const state = await regionState(cdp, ['in-first'], await page.drainAnnouncements());
        expect(state['in-first']).toMatchObject({ heard: false, exposed: false });
        expectMatchesTree(state);
      } finally {
        await context.close();
      }
    });
  }

  // The false green end to end: a Save button in a modal dialog writes "Saved" into a polite region
  // inside the dialog and closes it. No screen reader speaks the text, and a flow requirement that
  // expects it passed. A close in a later task is not tested here: the flow step does not wait for a
  // later task, so the order of the close and the drain is not fixed, and the capture-level test
  // above covers that case by awaiting the close before it drains.
  for (const [when, close] of [
    ['in the same task', 'dialog.close();'],
    ['after an awaited promise', 'await Promise.resolve(); dialog.close();'],
  ] as const) {
  it(`does not pass a flow requirement on a region inside a dialog the step closed ${when}`, async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title></head><body>
      <main><dialog id="edit"><p>Edit</p><div aria-live="polite" id="message"></div>
      <button type="button" id="save">Save</button></dialog></main>
      <script>
        const dialog = document.getElementById('edit');
        dialog.showModal();
        document.getElementById('save').addEventListener('click', async () => {
          document.getElementById('message').textContent = 'Saved';
          ${close}
        });
      </script>
    </body></html>`;
    const driver = makeRealBrowserDriver();
    try {
      const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      try {
        const [provider] = mapRequirementsToProviders({
          version: 1,
          requirements: [
            {
              id: 'save-announces',
              kind: 'flow',
              surface: 'clusters',
              description: 'Saving announces that the change was saved.',
              assertion: { type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Saved' },
              approved: true,
            },
          ],
        });
        if (provider === undefined) throw new Error('no flow provider');
        const drafts = draftsOf(
          await provider.run({ page, screen: { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' }, config: testConfig() }),
        );
        expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:save-announces', 'fail']]);
      } finally {
        await page.close();
      }
    } finally {
      await driver.close();
    }
  });
  }
});
