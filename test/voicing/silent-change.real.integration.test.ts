/**
 * The silent change rule in real Chromium. The rule compares two reads of the whole accessibility
 * tree around one action step, so this file first proves what that read covers: the main frame,
 * and open shadow roots, because the browser builds the tree from the flat tree. The docs claim
 * that only because this test holds it. Then each fixture in the pass criteria runs as a flow
 * requirement in fixtures/live/silent-change.html, and the rule's drafts are checked.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AxTreeNode, BrowserDriver, Draft, Page, Step } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { draftsOf, testConfig } from '../helpers.js';

// Each test opens a fresh page, under a second when the machine is idle, and some wait up to the
// settle cap after a step. The budget is set well above that, so machine load cannot decide the
// outcome.
const BROWSER_BUDGET_MS = 60_000;

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const TREE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Tree</title></head><body>
  <main>
    <h1>Rows</h1>
    <x-card id="card"></x-card>
    <table><thead><tr><th aria-sort="ascending"><button type="button">Name</button></th></tr></thead>
      <tbody><tr><td>Alpha</td></tr></tbody></table>
    <label>Email <input id="email" value="alice@example.com" /></label>
    <iframe title="Inner" srcdoc="<button>In a frame</button>"></iframe>
  </main>
  <script>
    customElements.define('x-card', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<section aria-label="Card"><button type="button" id="inner">Inside the card</button></section>';
      }
    });
  </script>
</body></html>`;

const OTHER_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Other</title></head><body><main><h1>Next page</h1></main></body></html>';

const SCREEN = { id: 'accounts', url: 'http://127.0.0.1/accounts' };

function named(nodes: AxTreeNode[], role: string, name: string): AxTreeNode | undefined {
  return nodes.find((node) => !node.ignored && node.role === role && node.name?.trim() === name);
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('the silent change rule in Chromium', { timeout: BROWSER_BUDGET_MS }, () => {
  let driver: BrowserDriver;

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    driver = makeRealBrowserDriver();
    const html = await readFile(fileURLToPath(new URL('../../fixtures/live/silent-change.html', import.meta.url)), 'utf8');
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url?.startsWith('/other.html') ? OTHER_PAGE : html);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}/silent-change.html`;
  });

  afterAll(async () => {
    await driver.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  async function withPage<T>(html: string, use: (page: Page) => Promise<T>): Promise<T> {
    const page = await driver.open(dataUrl(html));
    try {
      await page.gotoReady();
      return await use(page);
    } finally {
      await page.close();
    }
  }

  describe('the full tree read', () => {
    it('covers open shadow roots, and names the same node the focus read names', async () => {
      await withPage(TREE_PAGE, async (page) => {
        const read = await page.fullAxTree();
        expect(read.kind).toBe('tree');
        if (read.kind !== 'tree') return;

        const inner = named(read.nodes, 'button', 'Inside the card');
        expect(inner).toBeDefined();
        expect(named(read.nodes, 'region', 'Card')).toBeDefined();

        // Focus the button inside the shadow root: the focus read and the tree name one node.
        await page.tab();
        expect(await page.activePath()).toContain(' >> ');
        expect(await page.focusedNodeId()).toBe(inner?.nodeId);
      });
    });

    it('reads the sort state of a header, and never a value', async () => {
      await withPage(TREE_PAGE, async (page) => {
        const read = await page.fullAxTree();
        if (read.kind !== 'tree') throw new Error('the read was over budget');
        expect(named(read.nodes, 'columnheader', 'Name')?.states.sort).toBe('ascending');
        expect(named(read.nodes, 'textbox', 'Email')).toBeDefined();
        expect(JSON.stringify(read)).not.toContain('alice@example.com');
      });
    });

    it('does not read into a child frame', async () => {
      await withPage(TREE_PAGE, async (page) => {
        const read = await page.fullAxTree();
        if (read.kind !== 'tree') throw new Error('the read was over budget');
        expect(read.nodes.some((node) => node.name === 'In a frame')).toBe(false);
      });
    });

    it('gives the same node ids and document id on two reads of one document', async () => {
      await withPage(TREE_PAGE, async (page) => {
        const first = await page.fullAxTree();
        const second = await page.fullAxTree();
        if (first.kind !== 'tree' || second.kind !== 'tree') throw new Error('a read was over budget');
        expect(second.nodes.map((node) => node.nodeId)).toEqual(first.nodes.map((node) => node.nodeId));
        expect(second.documentNodeId).toBe(first.documentNodeId);
        expect(first.documentNodeId).not.toBeNull();
      });
    });

    it('names no named control as focused on a fresh page, where only the body has focus', async () => {
      await withPage(TREE_PAGE, async (page) => {
        const read = await page.fullAxTree();
        if (read.kind !== 'tree') throw new Error('the read was over budget');
        const focused = await page.focusedNodeId();
        // The body has focus on a fresh page. It is a node, but not a named control.
        const node = read.nodes.find((entry) => entry.nodeId === focused);
        expect(node === undefined || node.ignored || node.name === null || node.name === '').toBe(true);
      });
    });
  });

  describe('the acted control of a click step', () => {
    const CONTROLS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Controls</title></head><body>
      <main>
        <button type="button" id="save">Save</button>
        <button type="button" class="row-action">Delete row 1</button>
        <button type="button" class="row-action">Delete row 2</button>
        <x-card></x-card>
      </main>
      <script>
        customElements.define('x-card', class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML =
              '<button type="button" id="inner">Inside the card</button><button type="button" class="row-action">Delete row 3</button>';
          }
        });
      </script>
    </body></html>`;

    // The same controls with no shadow root, so a selector with a combinator can be resolved.
    const LIGHT_CONTROLS_PAGE = CONTROLS_PAGE.replace('<x-card></x-card>', '');

    // The click lands where the resolution points: a mouse click focuses the button it lands on.
    async function clickedIsResolved(page: Page, selector: string): Promise<void> {
      const resolved = await page.controlNodeId(selector);
      expect(resolved).not.toBeNull();
      await page.click(selector);
      expect(await page.focusedNodeId()).toBe(resolved);
    }

    it('resolves a control in the document to the node the click lands on', async () => {
      await withPage(CONTROLS_PAGE, (page) => clickedIsResolved(page, '#save'));
    });

    it('resolves a control inside an open shadow root, which the click reaches too', async () => {
      await withPage(CONTROLS_PAGE, (page) => clickedIsResolved(page, '#inner'));
    });

    it('resolves the first of several matches in the document, the one the click takes', async () => {
      await withPage(LIGHT_CONTROLS_PAGE, async (page) => {
        const read = await page.fullAxTree();
        if (read.kind !== 'tree') throw new Error('the read was over budget');
        expect(await page.controlNodeId('main > button.row-action')).toBe(named(read.nodes, 'button', 'Delete row 1')?.nodeId);
        await clickedIsResolved(page, 'main > button.row-action');
      });
    });

    it('cannot say which control a selector with a combinator means on a page with an open shadow root', async () => {
      await withPage(CONTROLS_PAGE, async (page) => {
        expect(await page.controlNodeId('main > button.row-action')).toBeNull();
        expect(await page.controlNodeId('main #save')).toBeNull();
        // A selector with no combinator still resolves there.
        expect(await page.controlNodeId('#save')).not.toBeNull();
      });
    });

    it('cannot say which control is meant when matches sit both in the document and in a shadow root', async () => {
      await withPage(CONTROLS_PAGE, async (page) => {
        expect(await page.controlNodeId('.row-action')).toBeNull();
      });
    });

    it('cannot resolve a selector that matches nothing, or one only Playwright can parse', async () => {
      await withPage(CONTROLS_PAGE, async (page) => {
        expect(await page.controlNodeId('#missing')).toBeNull();
        expect(await page.controlNodeId('text=Save')).toBeNull();
      });
    });
  });
  // Runs one flow requirement on a fresh page of the fixture and returns every draft it made. The
  // optional earlier action runs on the page first, the way an earlier check would.
  async function flow(which: string, steps: Step[], expectedAnnouncement?: string, earlier?: (page: Page) => Promise<void>): Promise<Draft[]> {
    const page = await driver.open(`${baseUrl}?case=${which}`);
    try {
      await page.gotoReady();
      await earlier?.(page);
      const [provider] = mapRequirementsToProviders({
        version: 1,
        requirements: [
          {
            id: 'accounts-flow',
            kind: 'flow',
            surface: SCREEN.id,
            description: 'An action on the accounts screen',
            approved: true,
            assertion: { type: 'flow', steps, ...(expectedAnnouncement === undefined ? {} : { expectedAnnouncement }) },
          },
        ],
      });
      if (provider === undefined) throw new Error('no flow provider');
      return draftsOf(await provider.run({ page, screen: SCREEN, config: testConfig() }));
    } finally {
      await page.close();
    }
  }

  function outcome(drafts: Draft[]): unknown[] {
    return drafts
      .filter((draft) => draft.rule === 'voicing/silent-change')
      .map((draft) => (draft.confidence === 'fail' ? 'finding' : draft.evidence.extra?.reason));
  }

  const click = (selector: string): Step[] => [{ do: 'click', selector }];

  describe('the pass criteria fixtures', () => {
    it('reports a silent Save as a preview finding', async () => {
      const drafts = await flow('silent-save', click('#save'));
      expect(outcome(drafts)).toEqual(['finding']);
      expect(drafts[0]).toMatchObject({
        rule: 'voicing/silent-change',
        evidenceClass: 'preview',
        severity: 'serious',
        confidence: 'fail',
        elementPath: '#save',
        role: 'button',
        evidence: { extra: { step: { do: 'click', selector: '#save' }, removed: {}, addedNames: ['Saved'] } },
      });
    });

    it('reports a silent Save reached with Tab and activated with Enter, on the focused control', async () => {
      const drafts = await flow('silent-save', [{ do: 'tab' }, { do: 'activate' }]);
      expect(outcome(drafts)).toEqual(['finding']);
      expect(drafts[0]?.elementPath).toBe('#save');
    });

    it('finds nothing for a Save that writes a shown polite region', async () => {
      expect(await flow('polite-save', click('#save'))).toEqual([]);
    });

    it('finds nothing for a Delete that moves focus to "Delete row 2, button"', async () => {
      expect(await flow('delete-focus', click('#delete-1'))).toEqual([]);
    });

    it('reports a Delete that removes the row and leaves focus on the body, with no email in the draft', async () => {
      const drafts = await flow('delete-body', click('#delete-1'));
      expect(outcome(drafts)).toEqual(['finding']);
      expect(drafts[0]?.evidence.extra).toMatchObject({ removed: expect.objectContaining({ row: 1 }), addedNames: [] });
      expect(JSON.stringify(drafts)).not.toContain('alice');
      expect(JSON.stringify(drafts)).not.toContain('example.com');
    });

    it('reports a Save that writes into a region inside a dialog it closes in the same step', async () => {
      expect(outcome(await flow('dialog-save', click('#save')))).toEqual(['finding']);
    });

    it('finds nothing for a disclosure, a tab, or a sort header: each speaks for itself', async () => {
      expect(await flow('disclosure', click('#toggle'))).toEqual([]);
      expect(await flow('tabs', click('#tab-2'))).toEqual([]);
      expect(await flow('sort', click('#sort'))).toEqual([]);
    });

    it('finds nothing for a step that changes only CSS classes', async () => {
      expect(await flow('css', click('#highlight'))).toEqual([]);
    });

    it('reports a link that loads a new document as a gap, navigated', async () => {
      const drafts = await flow('link', click('#next'));
      expect(outcome(drafts)).toEqual(['navigated']);
      expect(drafts[0]?.confidence).toBe('unverified');
    });

    it('reports a step whose drain is undecidable as a gap', async () => {
      expect(outcome(await flow('closed-modal', click('#save')))).toEqual(['announcements undecidable']);
    });

    it('reports a Save button drawn again with the same name as a gap', async () => {
      expect(outcome(await flow('rerender', click('#save')))).toEqual(['replaced focus']);
    });

    it('never hears a toast line that dismissed itself, because the record holds only a removal', async () => {
      expect(outcome(await flow('toast', click('#save')))).toEqual(['finding']);
    });

    it('reports a click that moves focus into a same-origin child frame as a gap, focus unreadable', async () => {
      const drafts = await flow('frame-focus', click('#edit'));
      expect(outcome(drafts)).toEqual(['focus unreadable']);
      expect(drafts[0]?.confidence).toBe('unverified');
    });

    it('reports a click whose combinator selector also matches inside an open shadow root as a gap, unreadable control', async () => {
      expect(outcome(await flow('shadow-combinator', click('.row button')))).toEqual(['unreadable control']);
    });

    it('never shows a field value through the name of an added row that holds the field', async () => {
      const drafts = await flow('field-row', click('#add'));
      expect(outcome(drafts)).toEqual(['finding']);
      const shown = JSON.stringify(drafts);
      expect(shown).not.toContain('alice');
      expect(shown).not.toContain('example.com');
    });
  });

  describe('determinism', () => {
    it('gives the same findings and the same evidence on two runs of a known interaction', async () => {
      for (const which of ['silent-save', 'delete-body']) {
        const selector = which === 'silent-save' ? '#save' : '#delete-1';
        const first = await flow(which, click(selector));
        const second = await flow(which, click(selector));
        expect(first.length).toBeGreaterThan(0);
        expect(second).toEqual(first);
      }
    });
  });

  describe('the flow requirement itself', () => {
    it('still passes a flow that announces on step 1, with each step drained on its own', async () => {
      expect(await flow('polite-save', [{ do: 'click', selector: '#save' }, { do: 'tab' }], 'Saved')).toEqual([]);
    });

    it('still fails a silent Save, and the rule adds nothing for the step the flow fails on', async () => {
      const drafts = await flow('silent-save', click('#save'), 'Saved');
      expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:accounts-flow', 'fail']]);
    });

    // The flow reads each step's drain at its own time, after the settle wait. These verdicts
    // differ from the single drain the flow used to take after its last step.
    const own = (drafts: Draft[]): unknown[] => drafts.filter((draft) => draft.rule === 'intake:accounts-flow').map((draft) => draft.confidence);

    it('now hears text written inside a dialog that a later step closes', async () => {
      const steps: Step[] = [{ do: 'click', selector: '#save' }, { do: 'click', selector: '#close' }];
      expect(own(await flow('dialog-heard', steps, 'Saved'))).toEqual([]);
    });

    it('now drops text written outside an open modal that a later step closes', async () => {
      const steps: Step[] = [{ do: 'click', selector: '#delete' }, { do: 'click', selector: '#close' }];
      expect(own(await flow('modal-outside', steps, 'Deleted'))).toEqual(['fail']);
    });

    it('now hears an announcement that lands shortly after the click', async () => {
      expect(await flow('late-announce', click('#save'), 'Saved')).toEqual([]);
    });

    it('does not pass on an announcement an earlier action caused when its own steps announce nothing', async () => {
      // An earlier action clicks Save, which writes "Saved" into the shown polite region, and waits
      // for the page to settle. The flow then only presses Tab, which announces nothing.
      const earlier = async (page: Page): Promise<void> => {
        await page.click('#save');
        await page.settleAfterAction();
      };
      const drafts = await flow('polite-save', [{ do: 'tab' }], 'Saved', earlier);
      expect(own(drafts)).toEqual(['fail']);
      expect(drafts.find((draft) => draft.rule === 'intake:accounts-flow')?.evidence.extra?.announcements).toEqual([]);
    });

    it('still passes when a step of the flow announces, after an earlier action announced the same text', async () => {
      const earlier = async (page: Page): Promise<void> => {
        await page.click('#save');
        await page.settleAfterAction();
      };
      expect(own(await flow('polite-save', click('#save'), 'Saved', earlier))).toEqual([]);
    });
  });
});
