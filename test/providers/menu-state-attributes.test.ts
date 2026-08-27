import { describe, expect, it } from 'vitest'
import type { Page, ProviderContext } from '../../src/contracts/index.js'
import { makeFakePage } from '../../src/deps/fakes.js'
import { makeRulepackProvider } from '../../src/providers/rulepack/index.js'
import { SEL } from '../../src/providers/rulepack/selectors.js'
import { testConfig } from '../helpers.js'

describe('menu toggle state attributes', () => {
  it('accepts valid false expanded state when Chromium omits it from AX properties', async () => {
    const selector = '.menu-toggle'
    const page = makeFakePage({
      queryAll: async (query) => (query === SEL.menuToggle ? [{ selector }] : []),
      axAt: async () => ({ name: 'Actions for policy-worker', role: 'button', states: {} }),
    }) as Page & { getAttribute(selector: string, name: string): Promise<string | null> }
    page.getAttribute = async (_selector, name) => {
      if (name === 'aria-expanded') return 'false'
      if (name === 'aria-haspopup') return 'menu'
      return null
    }
    const context: ProviderContext = {
      page,
      screen: { id: 'deployments', url: 'http://127.0.0.1:5173/deployments' },
      config: testConfig(),
    }

    const drafts = await makeRulepackProvider().run(context)

    expect(drafts).toEqual([])
  })
})
