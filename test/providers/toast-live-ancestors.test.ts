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
import { chromium, type Browser, type Page as PwPage } from 'playwright';
import type { CoverageGap, Page, ProviderContext } from '../../src/contracts/index.js';
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

interface ToastResult {
  drafts: number;
  gaps: CoverageGap[];
}

// Runs the check on a page built from the body. `between` runs after the alerts are listed and
// before their ancestors are read, which is how a test makes an alert vanish at a fixed point.
async function resultFor(body: string, between?: (pw: PwPage) => Promise<void>): Promise<ToastResult> {
  const pw = await browser.newPage({ viewport: { width: 800, height: 900 } });
  try {
    await pw.setContent(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /></head><body><main>${body}</main></body></html>`,
      { waitUntil: 'domcontentloaded' },
    );
    const adopted = await adoptPage(pw);
    const page: Page =
      between === undefined
        ? adopted
        : {
            ...adopted,
            async queryAll(selector: string) {
              const refs = await adopted.queryAll(selector);
              await between(pw);
              return refs;
            },
          };
    const ctx: ProviderContext = {
      config: testConfig(),
      screen: { id: 'toast', url: 'http://127.0.0.1:5173/toast' },
      page,
    };
    const { drafts, gaps } = await checkPfToastLiveRegion(ctx);
    expect(drafts.every((draft) => draft.rule === 'pf-toast-live-region')).toBe(true);
    return { drafts: drafts.length, gaps };
  } finally {
    await pw.close();
  }
}

async function draftsFor(body: string): Promise<number> {
  const result = await resultFor(body);
  expect(result.gaps).toEqual([]);
  return result.drafts;
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

  it('flags an alert inside an aria-live="OFF" region', async () => {
    expect(await draftsFor(`<div aria-live="OFF">${ALERT}</div>`)).toBe(1);
  });

  it('flags an alert in aria-live="POLITE" or "Assertive", because only the exact lowercase tokens count as live', async () => {
    // Chromium passes these tokens to the screen reader as written, not as polite or assertive.
    // Nothing shows that screen readers honor them, so the check does not pass on them.
    expect(await draftsFor(`<div aria-live="POLITE">${ALERT}</div>`)).toBe(1);
    expect(await draftsFor(`<div aria-live="Assertive">${ALERT}</div>`)).toBe(1);
    expect(await draftsFor(`<div role="status" aria-live="POLITE">${ALERT}</div>`)).toBe(1);
  });

  it('flags an alert inside an empty aria-live attribute with no live role', async () => {
    // An empty value counts as not set, and nothing above sets a value, so the default off holds.
    expect(await draftsFor(`<div aria-live="">${ALERT}</div>`)).toBe(1);
  });

  it('flags an alert inside an unknown aria-live value', async () => {
    // Chromium passes an unknown token through as written. The check reads it as off, which can
    // only make an alert less live, so it can never pass a silent alert.
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

  it('flags an alert under role="status" with an unknown aria-live value, which the check reads as off', async () => {
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

describe('pf-toast-live-region: role names match without regard to ASCII case, as Chromium matches them', () => {
  it('passes an alert in a role="STATUS" host, which Chromium exposes as status with polite', async () => {
    expect(await draftsFor(`<div role="STATUS">${ALERT}</div>`)).toBe(0);
  });

  it('flags an alert under role="TIMER" inside a polite region, because Chromium reads TIMER as timer, which is off', async () => {
    // Exact-case role matching would skip TIMER, reach the polite region, and pass a silent alert.
    expect(await draftsFor(`<div aria-live="polite"><div role="TIMER">${ALERT}</div></div>`)).toBe(1);
  });
});

// A component whose closed shadow root wraps its slot in the given markup. The alert is slotted
// into it. A closed root hides its slot from page script: assignedSlot reads null.
function closedHost(tag: string, shadow: string, light: string): string {
  return `<${tag}>${light}</${tag}>
    <script>
      customElements.define('${tag}', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'closed' }).innerHTML = '${shadow}';
        }
      });
    </script>`;
}

describe('pf-toast-live-region: closed shadow roots', () => {
  it('flags an alert slotted into an aria-live="off" wrapper inside a closed shadow root, under a polite region', async () => {
    // The flat tree runs alert, slot, off wrapper, host, polite region. The off wrapper is nearer,
    // so the alert is silent. A walk that cannot see the closed slot skips the wrapper and passes.
    const body = `<div aria-live="polite">${closedHost('x-closed-off', '<div aria-live="off"><slot></slot></div>', ALERT)}</div>`;
    expect(await draftsFor(body)).toBe(1);
  });

  it('passes an alert slotted into a role="status" wrapper inside a closed shadow root, under an off region', async () => {
    const body = `<div aria-live="off">${closedHost('x-closed-status', '<div role="status"><slot></slot></div>', ALERT)}</div>`;
    expect(await draftsFor(body)).toBe(0);
  });
});

describe('pf-toast-live-region: a hostile or very deep page', () => {
  it('finishes, and reads the real flat tree, when the page redefines assignedSlot to make a loop', async () => {
    // Every element now claims to be its own slot. A walk that trusts page script never ends.
    const body = `<script>
        Object.defineProperty(Element.prototype, 'assignedSlot', { configurable: true, get() { return this; } });
      </script>
      <div aria-live="polite"><div aria-live="off">${ALERT}</div></div>`;
    expect(await draftsFor(body)).toBe(1);
  }, 20_000);

  it('discloses a gap, never a pass, when the ancestor walk passes the depth cap', async () => {
    // A polite region sits above 600 plain wrappers. The cap stops the walk before it gets there,
    // so the check cannot say what the alert resolves to.
    const body = `<div aria-live="polite">${'<div>'.repeat(600)}${ALERT}${'</div>'.repeat(600)}</div>`;
    const result = await resultFor(body);
    expect(result.drafts).toBe(0);
    expect(result.gaps).toEqual([
      expect.objectContaining({ ref: 'provider:pf-rulepack/pf-toast-live-region', state: 'not-covered' }),
    ]);
    expect(result.gaps[0]?.reason).toContain('512');
  }, 30_000);
});

describe('pf-toast-live-region: an alert that vanishes', () => {
  it('records the vanished alert as its own gap and still flags a loose alert on the same screen', async () => {
    // PatternFly toasts close on a timer. Here the first alert is removed after it is listed and
    // before its ancestors are read. The second alert sits in no live region.
    const body = `<div id="closing" role="status">${ALERT}</div><div id="loose">${ALERT}</div>`;
    const result = await resultFor(body, async (pw) => {
      await pw.evaluate(() => document.getElementById('closing')?.remove());
    });
    expect(result.drafts).toBe(1);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ ref: 'provider:pf-rulepack/pf-toast-live-region', state: 'not-covered' });
    expect(result.gaps[0]?.reason).toContain('could not be found');
  });
});
