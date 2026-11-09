/**
 * The silent change rule in real Chromium. The rule compares two reads of the whole accessibility
 * tree around one action step, so this file first proves what that read covers: the main frame,
 * and open shadow roots, because the browser builds the tree from the flat tree. The docs claim
 * that only because this test holds it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AxTreeNode, BrowserDriver, Page } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';

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

function named(nodes: AxTreeNode[], role: string, name: string): AxTreeNode | undefined {
  return nodes.find((node) => !node.ignored && node.role === role && node.name?.trim() === name);
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('the silent change rule in Chromium', { timeout: BROWSER_BUDGET_MS }, () => {
  let driver: BrowserDriver;

  beforeAll(() => {
    driver = makeRealBrowserDriver();
  });

  afterAll(async () => {
    await driver.close();
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
      await withPage(CONTROLS_PAGE, async (page) => {
        const read = await page.fullAxTree();
        if (read.kind !== 'tree') throw new Error('the read was over budget');
        expect(await page.controlNodeId('main > button.row-action')).toBe(named(read.nodes, 'button', 'Delete row 1')?.nodeId);
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
});
