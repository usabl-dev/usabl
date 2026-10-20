/**
 * pf-toast-live-region resolves an alert's effective aria-live value through its ancestors.
 *
 * WAI-ARIA defines the live value of content as the value set on the nearest ancestor that sets
 * one, explicitly or through a role with an implicit value (alert is assertive; status and log are
 * polite; timer and marquee are off). A flat CSS selector cannot express "nearest". It asks only
 * whether some live container exists anywhere above the alert, so an aria-live="off" wrapper
 * between that container and the alert is invisible to it, and the alert passes while assistive
 * technology stays silent. That is a false green.
 *
 * These cases run in real Chromium through adoptPage, the production Page driver, so the element
 * paths and the ancestor read are the ones a real scan uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { ProviderContext } from '../../src/contracts/index.js';
import { adoptPage } from '../../src/deps/real.js';
import { checkPfToastLiveRegion } from '../../src/providers/rulepack/pf-toast-live-region.js';
import { testConfig } from '../helpers.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const ALERT =
  '<div class="pf-v6-c-alert pf-m-success"><div class="pf-v6-c-alert__icon"></div><h4 class="pf-v6-c-alert__title">Saved</h4></div>';

async function draftsFor(body: string): Promise<number> {
  const pw = await browser.newPage({ viewport: { width: 800, height: 900 } });
  try {
    await pw.setContent(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>${body}</main></body></html>`,
      { waitUntil: 'domcontentloaded' },
    );
    const ctx: ProviderContext = {
      config: testConfig(),
      screen: { id: 'toast', url: 'http://127.0.0.1:5173/toast' },
      page: await adoptPage(pw),
    };
    const drafts = await checkPfToastLiveRegion(ctx);
    expect(drafts.every((draft) => draft.rule === 'pf-toast-live-region')).toBe(true);
    return drafts.length;
  } finally {
    await pw.close();
  }
}

describe('pf-toast-live-region: residual false greens', () => {
  it('flags an alert inside an aria-live="off" wrapper that sits inside a polite region', async () => {
    // The outer polite region still matched the old selector and exempted the alert, but the
    // nearer off wrapper is what decides, so the alert is silent.
    expect(await draftsFor(`<div aria-live="polite"><div aria-live="off">${ALERT}</div></div>`)).toBe(1);
  });

  it('flags an alert inside an aria-live="off" wrapper that sits inside a role="status" host', async () => {
    // The old role arm was [role="status"]:not([aria-live="off"]). :not inspects only the status
    // element, so the off wrapper between the host and the alert was never seen.
    expect(await draftsFor(`<div role="status"><div aria-live="off">${ALERT}</div></div>`)).toBe(1);
  });

  it('flags an alert inside an aria-live="OFF" region, because ARIA token values ignore ASCII case', async () => {
    expect(await draftsFor(`<div aria-live="OFF">${ALERT}</div>`)).toBe(1);
  });

  it('flags an alert inside an empty aria-live attribute with no live role', async () => {
    // An empty value counts as not set, and nothing above sets a value, so the default off holds.
    expect(await draftsFor(`<div aria-live="">${ALERT}</div>`)).toBe(1);
  });

  it('flags an alert inside an unknown aria-live value', async () => {
    // An invalid token takes the attribute default, which is off.
    expect(await draftsFor(`<div aria-live="loud">${ALERT}</div>`)).toBe(1);
  });

  it('flags an alert in a polite region when the alert itself sets aria-live="off"', async () => {
    // The alert's own attribute is the nearest value for its own content.
    expect(
      await draftsFor(`<div aria-live="polite"><div class="pf-v6-c-alert" aria-live="off"><h4 class="pf-v6-c-alert__title">Saved</h4></div></div>`),
    ).toBe(1);
  });

  it('flags an alert under a role="timer" wrapper, whose implicit live value is off', async () => {
    expect(await draftsFor(`<div aria-live="polite"><div role="timer">${ALERT}</div></div>`)).toBe(1);
  });

  it('flags an alert under role="log" with an explicit aria-live="off", because the attribute beats the role', async () => {
    expect(await draftsFor(`<div role="log" aria-live="off">${ALERT}</div>`)).toBe(1);
  });

  it('flags an alert under role="status" with an unknown aria-live value, which resolves to off', async () => {
    expect(await draftsFor(`<div role="status" aria-live="loud">${ALERT}</div>`)).toBe(1);
  });
});

describe('pf-toast-live-region: contained alerts stay silent', () => {
  it('passes an alert in a role="status" host that sits inside an aria-live="off" wrapper', async () => {
    // The nearest live value wins, and the status host is nearer than the off wrapper.
    expect(await draftsFor(`<div aria-live="off"><div role="status">${ALERT}</div></div>`)).toBe(0);
  });

  it('passes an alert in a polite region nested inside an off region', async () => {
    expect(await draftsFor(`<div aria-live="off"><div aria-live="polite">${ALERT}</div></div>`)).toBe(0);
  });

  it('passes an alert in aria-live="POLITE", because ARIA token values ignore ASCII case', async () => {
    expect(await draftsFor(`<div aria-live="POLITE">${ALERT}</div>`)).toBe(0);
  });

  it('passes an alert in role="status" with an empty aria-live, which falls back to the implicit polite', async () => {
    expect(await draftsFor(`<div role="status" aria-live="">${ALERT}</div>`)).toBe(0);
  });

  it('passes an alert in role="status" with aria-live="assertive", because the attribute beats the role', async () => {
    expect(await draftsFor(`<div role="status" aria-live="assertive">${ALERT}</div>`)).toBe(0);
  });

  it('passes an alert in a role="alert" host and in a role="log" host', async () => {
    expect(await draftsFor(`<div role="alert">${ALERT}</div>`)).toBe(0);
    expect(await draftsFor(`<div role="log">${ALERT}</div>`)).toBe(0);
  });

  it('uses the first recognized role in a role list, as browsers do', async () => {
    // "banana" is not a role, so the browser falls back to status, which is polite.
    expect(await draftsFor(`<div role="banana status">${ALERT}</div>`)).toBe(0);
  });
});

describe('pf-toast-live-region: role lists', () => {
  it('flags an alert when the first recognized role in the list has an off live value', async () => {
    // "banana" is skipped, "timer" is the role, and timer is off, so the polite region above
    // does not reach the alert.
    expect(await draftsFor(`<div aria-live="polite"><div role="banana timer">${ALERT}</div></div>`)).toBe(1);
  });

  it('does not treat a later live role as the role when an earlier token is a recognized role', async () => {
    // "region" is a recognized role and comes first, so "status" is a fallback that is never used
    // and the element has no live value of its own. Nothing above sets one, so the alert is silent.
    expect(await draftsFor(`<div role="region status">${ALERT}</div>`)).toBe(1);
  });
});

describe('pf-toast-live-region: shadow DOM slots', () => {
  it('reads the live region a slotted alert renders inside, not only its light DOM parents', async () => {
    // The accessibility tree follows the flat tree. Here the alert is slotted into a shadow root
    // whose role="status" wrapper surrounds the slot, and the light DOM wrapper above the host is
    // off. The status wrapper is nearer in the flat tree, so the alert is announced. A plain
    // parentElement walk skips the slot and reaches the off wrapper first.
    const body = `<div aria-live="off"><x-toaster>${ALERT}</x-toaster></div>
      <script>
        customElements.define('x-toaster', class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML = '<div role="status"><slot></slot></div>';
          }
        });
      </script>`;
    expect(await draftsFor(body)).toBe(0);
  });
});
