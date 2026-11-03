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
      await page.drainAnnouncements();
      await pw.evaluate(`new Promise((resolve) => {
        window.say('outside', 'said in outside');
        window.say('in-first', 'said in in-first');
        setTimeout(() => { document.getElementById('first').showModal(); resolve(); }, 0);
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

  // The false green end to end: a flow requirement that expects "Saved" passed on a polite region
  // outside the modal the same click opened, which no screen reader speaks.
  it('does not pass a flow requirement on a region outside the modal the step opened', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title></head><body>
      <main><button type="button" id="save">Save</button><div aria-live="polite" id="message"></div>
      <dialog id="confirm"><p>Saving</p><button type="button">Close</button></dialog></main>
      <script>
        document.getElementById('save').addEventListener('click', () => {
          document.getElementById('confirm').showModal();
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
});
