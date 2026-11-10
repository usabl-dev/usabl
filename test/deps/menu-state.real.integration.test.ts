import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProviderContext } from '../../src/contracts/index.js'
import { makeRealBrowserDriver } from '../../src/deps/real.js'
import { checkPfKebabExpandedState } from '../../src/providers/rulepack/pf-kebab-expanded-state.js'
import { probeMenus } from '../../src/providers/rulepack/probes.js'
import { testConfig } from '../helpers.js'

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('real menu state attributes', () => {
  const driver = makeRealBrowserDriver()
  let server: Server
  let url: string

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>
        <html lang="en">
          <body>
            <button class="menu-toggle" type="button" aria-haspopup="menu" aria-expanded="false">
              Actions for policy-worker
            </button>
          </body>
        </html>`)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('menu state fixture failed to bind')
    }
    url = `http://127.0.0.1:${address.port}/`
  })

  afterAll(async () => {
    await driver.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('accepts false expanded and menu popup attributes from a real page', async () => {
    const page = await driver.open(url)
    try {
      await page.gotoReady()
      expect(await page.getAttribute('.menu-toggle', 'aria-expanded')).toBe('false')
      expect(await page.getAttribute('.menu-toggle', 'aria-haspopup')).toBe('menu')
      const context: ProviderContext = {
        page,
        screen: { id: 'deployments', url },
        config: testConfig(),
      }

      await expect(checkPfKebabExpandedState(context)).resolves.toEqual([])
    } finally {
      await page.close()
    }
  })
})

// The menu probe in Chromium: a menu that mounts a moment after the click, a toggle that promises a
// menu and opens none, and a toggle whose menu is already open.
const MENU_PAGES: Record<string, string> = {
  // The menu mounts 150 ms after the click and focus stays on the toggle, so the probe must wait for
  // the menu and then report that focus did not move into it.
  '/late-menu': menuPage(
    `toggle.addEventListener('click', () => setTimeout(() => {
       toggle.setAttribute('aria-expanded', 'true');
       document.body.insertAdjacentHTML('beforeend', '<ul role="menu" id="menu"><li role="menuitem" tabindex="-1">Edit</li></ul>');
     }, 150));`,
  ),
  // The same at 800 ms, long after the click returns, so a probe that reads the menu at once always
  // misses it, whatever the load on the machine.
  '/later-menu': menuPage(
    `toggle.addEventListener('click', () => setTimeout(() => {
       toggle.setAttribute('aria-expanded', 'true');
       document.body.insertAdjacentHTML('beforeend', '<ul role="menu" id="menu"><li role="menuitem" tabindex="-1">Edit</li></ul>');
     }, 800));`,
  ),
  // The same, with focus moved into the menu when it mounts: a correct menu.
  '/late-menu-focus': menuPage(
    `toggle.addEventListener('click', () => setTimeout(() => {
       toggle.setAttribute('aria-expanded', 'true');
       document.body.insertAdjacentHTML('beforeend', '<ul role="menu" id="menu"><li role="menuitem" tabindex="-1">Edit</li></ul>');
       document.querySelector('#menu [role="menuitem"]').focus();
     }, 150));`,
  ),
  // aria-haspopup promises a menu, and the click opens nothing.
  '/no-menu': menuPage(''),
  // The menu is open before the probe runs, and the click would close it.
  '/open-menu': `<!doctype html><html lang="en"><head><title>Menu</title></head><body>
    <button id="toggle" type="button" aria-haspopup="menu" aria-expanded="true">Actions</button>
    <ul role="menu" id="menu"><li role="menuitem" tabindex="-1">Edit</li></ul>
    <script>document.getElementById('toggle').addEventListener('click', () => document.getElementById('menu').remove());</script>
  </body></html>`,
};

function menuPage(script: string): string {
  return `<!doctype html><html lang="en"><head><title>Menu</title></head><body>
    <button id="toggle" type="button" aria-haspopup="menu" aria-expanded="false">Actions</button>
    <script>const toggle = document.getElementById('toggle');
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { document.getElementById('menu')?.remove(); toggle.setAttribute('aria-expanded', 'false'); } });
      ${script}</script>
  </body></html>`;
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('the PatternFly menu probe in Chromium', { timeout: 30_000 }, () => {
  const driver = makeRealBrowserDriver()
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = MENU_PAGES[new URL(req.url ?? '/', 'http://127.0.0.1').pathname]
      res.writeHead(html === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html ?? 'not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('menu probe fixture failed to bind')
    }
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await driver.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function probe(path: string): Promise<{ drafts: Array<[string, string]>; menuOpen: boolean }> {
    const page = await driver.open(`${base}${path}`)
    try {
      await page.gotoReady()
      const drafts = await probeMenus({ page, screen: { id: 'menus', url: `${base}${path}` }, config: testConfig() })
      return {
        drafts: drafts.map((draft) => [draft.rule, draft.confidence]),
        menuOpen: (await page.queryAll('#menu')).length > 0,
      }
    } finally {
      await page.close()
    }
  }

  it('checks a menu that mounts 150 ms after the click', async () => {
    expect((await probe('/late-menu')).drafts).toEqual([['pf-kebab-expanded-state', 'fail']])
    expect((await probe('/later-menu')).drafts).toEqual([['pf-kebab-expanded-state', 'fail']])
    expect((await probe('/late-menu-focus')).drafts).toEqual([])
  })

  it('reports a toggle that promises a menu and opens none as unverified', async () => {
    expect((await probe('/no-menu')).drafts).toEqual([['pf-kebab-expanded-state', 'unverified']])
  })

  it('leaves a menu that is already open alone', async () => {
    expect(await probe('/open-menu')).toEqual({ drafts: [], menuOpen: true })
  })
})
