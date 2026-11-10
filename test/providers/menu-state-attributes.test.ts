import { describe, expect, it } from 'vitest'
import type { Page, ProviderContext } from '../../src/contracts/index.js'
import { makeFakePage } from '../../src/deps/fakes.js'
import { makeRulepackProvider } from '../../src/providers/rulepack/index.js'
import { SEL } from '../../src/providers/rulepack/selectors.js'
import { draftsOf, gapsOf, testConfig } from '../helpers.js'

describe('menu toggle state attributes', () => {
  it('accepts valid false expanded state when Chromium omits it from AX properties', async () => {
    const selector = '.menu-toggle'
    // The toggle opens its menu and moves focus into it, as a correct menu does, so the menu probe
    // has nothing to report either.
    let open = false
    const page = makeFakePage({
      // A PatternFly page, so the pack runs.
      countEverywhere: async (query) => (query === SEL.pfMarker ? 1 : 0),
      queryAll: async (query) =>
        query === SEL.pfMarker
          ? [{ selector: '.pf-v6-c-page' }]
          : query === SEL.menuToggle
            ? [{ selector }]
            : query === SEL.menu && open
              ? [{ selector: '#menu' }]
              : [],
      axAt: async () => ({ name: 'Actions for policy-worker', role: 'button', states: {} }),
      click: async () => {
        open = true
      },
      press: async () => {
        open = false
      },
      activeElementWithin: async (query) => query === '#menu' && open,
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

    const output = await makeRulepackProvider().run(context)

    expect(draftsOf(output)).toEqual([])
    expect(gapsOf(output)).toEqual([])
  })
})
