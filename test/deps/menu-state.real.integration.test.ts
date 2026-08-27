import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProviderContext } from '../../src/contracts/index.js'
import { makeRealBrowserDriver } from '../../src/deps/real.js'
import { checkPfKebabExpandedState } from '../../src/providers/rulepack/pf-kebab-expanded-state.js'
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
