/**
 * Level 1 of the sensitivity measurement: the catalog run on fixture pages that ship with usabl,
 * served on loopback, with no app and no config.
 *
 * The pages are small and correct on purpose, so a defect a mutation adds stands out. The RHDS page
 * defines small stand-in elements with the tag names and the shadow structure the RHDS rules read
 * (a native button inside rh-button, a switch role and a name from accessible-label on rh-switch).
 * It does not load @rhds/elements, which is not a dependency of usabl.
 *
 * The flow and voice pages come with their own design requirements, built here, so the flow and
 * voice lanes run on Level 1 as they would on a team's screen.
 *
 * Measurement only. Nothing on the normal run path imports this file.
 */
import { createServer, type Server } from 'node:http';
import type { BrowserDriver, RequirementBundle, UsablConfig } from '../../contracts/index.js';
import { makeRealBrowserDriver } from '../../deps/real.js';
import { makeCheckRunner } from '../../providers/check-runner.js';
import { makeScanProviders } from '../../providers/core-stack.js';
import { makeStepRunner } from '../../providers/keyboard-walk/steps.js';
import { makeMutatingBrowser } from './browser.js';
import { SENSITIVITY_CATALOG, type CatalogEntry, type Level1ScreenId } from './catalog.js';
import type { MutationEditor } from './edits.js';
import { makeRealMutationEditor } from './real-editor.js';
import { measureCatalog, type EntryMeasurement, type SensitivityScreen } from './runner.js';

function page(title: string, body: string, head = ''): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head>` +
    `<body>${body}</body></html>`
  );
}

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=';

const BASIC = page(
  'Account settings',
  `<main>
  <h1>Account settings</h1>
  <p id="intro">Change how your account works.</p>
  <img id="logo" src="${PIXEL}" alt="Company logo" width="16" height="16">
  <form id="profile" onsubmit="return false">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="email">
  </form>
  <button type="button" id="save">Save</button>
  <button type="button" id="reset">Reset</button>
  <a id="help-link" href="#help">Help</a>
  <h2 id="help">Help</h2>
  <p>Contact support for help.</p>
</main>`,
);

const PF = page(
  'Clusters',
  `<main class="pf-v6-c-page__main">
  <h1>Clusters</h1>
  <div class="pf-v6-c-toolbar" role="toolbar" aria-label="Cluster filters"><button type="button" class="pf-v6-c-button">Filter</button></div>
  <div class="pf-v6-c-toolbar" role="toolbar" aria-label="Cluster actions"><button type="button" class="pf-v6-c-button">Export</button></div>
  <button type="button" class="pf-v6-c-button pf-m-plain" id="close-icon" aria-label="Close"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M2 2 L14 14 M14 2 L2 14" stroke="black"></path></svg></button>
  <button type="button" id="menu-toggle" class="pf-v6-c-menu-toggle" data-ouia-component-type="PF6/MenuToggle" aria-haspopup="menu" aria-expanded="false">Actions</button>
  <div id="menu-slot"></div>
  <button type="button" id="open-dialog" class="pf-v6-c-button" aria-haspopup="dialog">Edit cluster</button>
  <div id="dialog" class="pf-v6-c-modal-box" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden>
    <h2 id="dialog-title">Edit cluster</h2>
    <button type="button" id="dialog-close" class="pf-v6-c-button">Close dialog</button>
  </div>
  <ul class="pf-v6-c-alert-group" aria-live="polite"><li><div class="pf-v6-c-alert pf-m-success"><p>Cluster saved</p></div></li></ul>
  <table class="pf-v6-c-table">
    <caption>Clusters</caption>
    <thead><tr><th scope="col">Name</th><th scope="col">Action</th></tr></thead>
    <tbody>
      <tr><td>alpha</td><td><button type="button" class="pf-v6-c-button" aria-label="Delete alpha">Delete</button></td></tr>
      <tr><td>beta</td><td><button type="button" class="pf-v6-c-button" aria-label="Delete beta">Delete</button></td></tr>
    </tbody>
  </table>
</main>
<script>
(() => {
  const toggle = document.getElementById('menu-toggle');
  const slot = document.getElementById('menu-slot');
  const closeMenu = () => {
    slot.replaceChildren();
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  };
  toggle.addEventListener('click', () => {
    if (slot.firstChild) { closeMenu(); return; }
    const menu = document.createElement('ul');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Actions');
    menu.innerHTML = '<li role="none"><button type="button" role="menuitem">Rename</button></li><li role="none"><button type="button" role="menuitem">Archive</button></li>';
    menu.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
    slot.appendChild(menu);
    toggle.setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
  });
  const opener = document.getElementById('open-dialog');
  const dialog = document.getElementById('dialog');
  opener.addEventListener('click', () => {
    dialog.hidden = false;
    document.getElementById('dialog-close').focus();
  });
  const closeDialog = () => { dialog.hidden = true; opener.focus(); };
  document.getElementById('dialog-close').addEventListener('click', closeDialog);
  dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDialog(); });
})();
</script>`,
);

const RHDS_STAND_INS = `<script>
customElements.define('rh-button', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button type="button"><slot></slot></button>'; }
});
customElements.define('rh-switch', class extends HTMLElement {
  static observedAttributes = ['accessible-label'];
  constructor() { super(); this.internals = this.attachInternals(); this.internals.role = 'switch'; this.internals.ariaChecked = 'false'; }
  connectedCallback() { if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0'); this.sync(); }
  attributeChangedCallback() { this.sync(); }
  sync() { this.internals.ariaLabel = this.getAttribute('accessible-label'); }
});
</script>`;

const RHDS = page(
  'Product tour',
  `<rh-skip-link href="#main-content">Skip to main content</rh-skip-link>
<main id="main-content">
  <h1>Product tour</h1>
  <rh-button>Start the tour</rh-button>
  <rh-cta><a href="#tour">Read the tour guide</a></rh-cta>
  <rh-tabs>
    <rh-tab slot="tab">Overview</rh-tab>
    <rh-tab slot="tab">Details</rh-tab>
    <rh-tab-panel>The overview panel.</rh-tab-panel>
    <rh-tab-panel>The details panel.</rh-tab-panel>
  </rh-tabs>
  <rh-switch accessible-label="Show tips"></rh-switch>
  <h2 id="tour">Tour guide</h2>
  <p>The guide walks through each part of the product.</p>
</main>`,
  RHDS_STAND_INS,
);

// The status region is written in the click handler, before the click returns, so the flow and
// voice lanes hear it whatever their own timing.
function savePage(title: string): string {
  return page(
    title,
    `<main>
  <h1>${title}</h1>
  <button type="button" id="save">Save profile</button>
  <div id="status" aria-live="polite"></div>
</main>
<script>
document.getElementById('save').addEventListener('click', () => {
  document.getElementById('status').textContent = 'Profile saved';
});
</script>`,
  );
}

// A documentation page with no focusable element reads as a page that never rendered, because the
// keyboard walk stays on the body, so this one has a link, as real documentation pages do.
const DOCS = page(
  'Install the agent',
  `<main>
  <h1>Install the agent</h1>
  <p>These steps install the agent on one host.</p>
  <h2>Before you begin</h2>
  <p>Check that the host runs one of the <a href="#versions">supported versions</a>.</p>
  <h3 id="versions">Supported versions</h3>
  <p>Version 2 and later are supported.</p>
</main>`,
);

export const LEVEL1_PAGES: Readonly<Record<Level1ScreenId, string>> = {
  'sensitivity-basic': BASIC,
  'sensitivity-pf': PF,
  'sensitivity-rhds': RHDS,
  'sensitivity-flow': savePage('Profile'),
  'sensitivity-voice': savePage('Profile with voice'),
  'sensitivity-docs': DOCS,
};

export const LEVEL1_SCREEN_IDS: readonly Level1ScreenId[] = Object.keys(LEVEL1_PAGES).sort() as Level1ScreenId[];

/** The design requirements of the Level 1 flow and voice pages. */
export const LEVEL1_REQUIREMENTS: RequirementBundle = {
  version: 1,
  requirements: [
    {
      id: 'sensitivity-profile-saved',
      kind: 'flow',
      surface: 'sensitivity-flow',
      description: 'Saving the profile announces that it was saved.',
      approved: true,
      assertion: { type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Profile saved' },
    },
    {
      id: 'sensitivity-profile-saved-voice',
      kind: 'voice',
      surface: 'sensitivity-voice',
      description: 'Saving the profile is heard in a live region.',
      approved: true,
      assertion: {
        type: 'voice',
        steps: [{ do: 'click', selector: '#save' }],
        obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['saved'], mustAnnounce: true }],
      },
    },
  ],
};

export interface Level1Server {
  baseUrl: string;
  screens: SensitivityScreen[];
  close(): Promise<void>;
}

/** Serves the Level 1 pages on loopback, one path per screen id. */
export async function serveLevel1(): Promise<Level1Server> {
  const server: Server = createServer((request, response) => {
    const id = (request.url ?? '/').split('?')[0]?.slice(1) ?? '';
    const html = (LEVEL1_PAGES as Record<string, string | undefined>)[id];
    if (html === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the Level 1 fixture server has no port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    screens: LEVEL1_SCREEN_IDS.map((id): SensitivityScreen => ({
      id,
      url: `${baseUrl}/${id}`,
      ...(id === 'sensitivity-docs' ? { profile: 'docs' as const } : {}),
    })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The config the Level 1 scans run with. It names no screen, so no readiness signal applies. */
export function level1Config(baseUrl: string): UsablConfig {
  return {
    appBaseUrl: baseUrl,
    uiFileGlobs: [],
    discovery: { routerFile: '', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: [],
  };
}

export interface Level1Options {
  now: string;
  entries?: readonly CatalogEntry[];
  // The browser to scan with. Default: a real scan browser, closed at the end.
  browser?: BrowserDriver;
  editor?: MutationEditor;
}

/** Runs each catalog entry on its own Level 1 screen, through the core provider stack. */
export async function runLevel1(options: Level1Options): Promise<EntryMeasurement[]> {
  const entries = options.entries ?? SENSITIVITY_CATALOG;
  const fixtures = await serveLevel1();
  const base = options.browser ?? makeRealBrowserDriver();
  try {
    const browser = makeMutatingBrowser(base, options.editor ?? makeRealMutationEditor());
    const checkRunner = makeCheckRunner({
      browser,
      providers: makeScanProviders(LEVEL1_REQUIREMENTS),
      config: level1Config(fixtures.baseUrl),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });
    const byId = new Map(fixtures.screens.map((screen) => [screen.id, screen]));
    return await measureCatalog(
      { checkRunner, browser, requirements: LEVEL1_REQUIREMENTS, now: options.now },
      entries.map((entry) => {
        const screen = byId.get(entry.level1Screen);
        return { entry, screens: screen === undefined ? [] : [screen] };
      }),
    );
  } finally {
    if (options.browser === undefined) {
      await base.close();
    }
    await fixtures.close();
  }
}
