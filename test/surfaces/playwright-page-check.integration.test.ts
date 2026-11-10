import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { UsablConfig } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { checkPage } from '../../src/surfaces/playwright-helper.js';

// A minimal accessible page: titled, one landmark, one h1, one named control, high contrast.
// axe finds no violations and no incompletes here, so a full page check should be verified.
const CLEAN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Reports</title>
  </head>
  <body>
    <main>
      <h1>Reports</h1>
      <button type="button">Run report</button>
    </main>
  </body>
</html>`;

// The clean page, with its only RHDS element inside an open shadow root, where the RHDS rules do
// not read. The pack says so in a note, and the note does not block the page.
const RHDS_IN_SHADOW_HTML = CLEAN_HTML.replace(
  '</main>',
  `<x-shell></x-shell></main>
    <script>customElements.define('x-shell', class extends HTMLElement { constructor() { super();
      this.attachShadow({ mode: 'open' }).innerHTML = '<rh-cta>Read the guide</rh-cta>'; } });</script>`,
);

// A page with a guaranteed deterministic failure: an image with no alt text. image-alt is a
// hard axe violation (never incomplete), so this must gate to a regression.
const IMAGE_ALT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Broken</title>
  </head>
  <body>
    <main>
      <h1>Dashboard</h1>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
    </main>
  </body>
</html>`;

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('checkPage on a live Playwright page', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  // Real Playwright suites hand checkPage a page from the @playwright/test `page` fixture, which is
  // created from a per-test browser.newContext(). Mirror that here (not the browser.newPage()
  // shortcut) because @axe-core/playwright only runs on context-owned pages.
  async function openPage(html: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return { context, page };
  }

  it('returns verified for an accessible page', async () => {
    const { context, page } = await openPage(CLEAN_HTML);
    try {
      const result = await checkPage(page, { tabCap: 10 });

      expect(result.failures).toEqual([]);
      expect(result.verdict).toBe('verified');
    } finally {
      await context.close();
    }
  });

  it('discloses RHDS markup it did not read in a note, with no gap and no change to the verdict', async () => {
    const { context, page } = await openPage(RHDS_IN_SHADOW_HTML);
    try {
      const result = await checkPage(page, { tabCap: 10 });

      expect(result.verdict).toBe('verified');
      expect(result.gaps).toEqual([]);
      expect(result.notes).toEqual([
        {
          ref: 'provider:rhds-rulepack/out-of-document',
          reason: '1 RHDS element(s) sit inside frames or shadow roots, which the RHDS rulepack does not read, so the RHDS rules did not check them.',
        },
      ]);
    } finally {
      await context.close();
    }
  });

  it('returns regression for a page with a missing image alt', async () => {
    const { context, page } = await openPage(IMAGE_ALT_HTML);
    try {
      const result = await checkPage(page, { tabCap: 10 });

      expect(result.verdict).toBe('regression');
      expect(result.failures.some((f) => f.rule === 'image-alt')).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('leaves the caller-supplied page open and usable', async () => {
    const { context, page } = await openPage(CLEAN_HTML);
    try {
      await checkPage(page, { tabCap: 5 });

      // adoptPage must never close a page or context it did not create.
      expect(page.isClosed()).toBe(false);
      await expect(page.title()).resolves.toBe('Reports');
    } finally {
      await context.close();
    }
  });

  it('detaches its CDP session and removes its listeners when it is done, and keeps the page open', async () => {
    const { context, page } = await openPage(CLEAN_HTML);
    try {
      const sessions: Array<Awaited<ReturnType<BrowserContext['newCDPSession']>>> = [];
      const original = context.newCDPSession.bind(context);
      context.newCDPSession = async (target) => {
        const session = await original(target);
        sessions.push(session);
        return session;
      };
      // Playwright's page is an event emitter at run time; its types leave listenerCount out.
      const emitter = page as unknown as { listenerCount(event: string): number };
      const listeners = (): number => emitter.listenerCount('request') + emitter.listenerCount('response');
      const listenersBefore = listeners();

      await checkPage(page, { tabCap: 5 });

      expect(sessions).toHaveLength(1);
      // A detached session refuses every command.
      await expect(sessions[0]?.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow();
      expect(listeners()).toBe(listenersBefore);
      expect(page.isClosed()).toBe(false);
      await expect(page.evaluate(() => document.title)).resolves.toBe('Reports');
    } finally {
      await context.close();
    }
  });
});

// A page whose heading text breaks an authored design requirement. Nothing else on it fails, so
// a regression can only come from the requirement.
function headingPage(heading: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      <button type="button">Refresh</button>
    </main>
  </body>
</html>`;
}

// A sign-in page: accessible, with a password field.
const SIGN_IN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sign in</title>
  </head>
  <body>
    <main>
      <h1>Sign in</h1>
      <label>Password <input type="password" /></label>
      <button type="submit">Sign in</button>
    </main>
  </body>
</html>`;

const HEADING_REQUIREMENT = `version: 1
requirements:
  - id: clusters-heading
    kind: content
    surface: clusters
    description: The clusters screen heading reads Clusters.
    assertion:
      type: content
      selector: h1
      expectedText: Clusters
    approved: true
`;

const ORPHAN_REQUIREMENT = `version: 1
requirements:
  - id: clustrs-heading
    kind: content
    surface: clustrs
    description: A requirement whose surface is misspelled, so no screen is ever that surface.
    assertion:
      type: content
      selector: h1
      expectedText: Clusters
    approved: true
`;

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('checkPage runs the design requirements the CLI runs', { timeout: 60_000 }, () => {
  let browser: Browser;
  let server: Server;
  let baseUrl: string;
  let html = headingPage('Reports');

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  // A project directory the way a consumer has one: usabl.config.json at the root and a
  // requirements directory beside it. Surfaces are clusters and reports.
  async function makeProject(
    requirementFiles: Record<string, string>,
    surfaceIds: readonly string[] = ['clusters', 'reports'],
  ): Promise<{ dir: string; config: UsablConfig }> {
    const dir = await mkdtemp(join(tmpdir(), 'usabl-checkpage-'));
    const config: UsablConfig = {
      appBaseUrl: baseUrl,
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: surfaceIds.map((id) => ({ id, url: `${baseUrl}/${id}`, files: [`src/${id}.tsx`] })),
      requirements: 'requirements',
      guardedPaths: [],
    };
    await writeFile(join(dir, 'usabl.config.json'), JSON.stringify(config, null, 2));
    await mkdir(join(dir, 'requirements'));
    for (const [name, body] of Object.entries(requirementFiles)) {
      await writeFile(join(dir, 'requirements', name), body);
    }
    return { dir, config };
  }

  async function openUrl(url: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { context, page };
  }

  it('regresses in checkPage on the same requirement the CLI scan flags', async () => {
    html = headingPage('Reports');
    const { dir, config } = await makeProject({ 'heading.yaml': HEADING_REQUIREMENT });
    try {
      // The CLI path: the same Deps every operator surface builds, scanning the clusters screen.
      const deps = await buildDeps(config, { cwd: dir, env: {} });
      let cliRules: string[];
      try {
        const scan = await deps.checkRunner.scan({ id: 'clusters', url: `${baseUrl}/clusters` });
        cliRules = scan.drafts.filter((d) => d.confidence === 'fail').map((d) => d.rule);
      } finally {
        await deps.browser.close();
      }
      expect(cliRules).toContain('intake:clusters-heading');

      // The helper path on the same page, labeled as the same surface, reading the same project.
      const { context, page } = await openUrl(`${baseUrl}/clusters`);
      try {
        const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
        expect(result.verdict).toBe('regression');
        expect(result.failures.map((f) => f.rule)).toContain('intake:clusters-heading');
      } finally {
        await context.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is verified when the page meets the requirement', async () => {
    html = headingPage('Clusters');
    const { dir } = await makeProject({ 'heading.yaml': HEADING_REQUIREMENT });
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
      expect(result.gaps).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(result.verdict).toBe('verified');
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not hold a page to a requirement written for a different configured surface', async () => {
    html = headingPage('Reports');
    const { dir } = await makeProject({ 'heading.yaml': HEADING_REQUIREMENT });
    const { context, page } = await openUrl(`${baseUrl}/reports`);
    try {
      const result = await checkPage(page, { screenId: 'reports', projectRoot: dir, tabCap: 10 });
      expect(result.gaps).toEqual([]);
      expect(result.verdict).toBe('verified');
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is not_covered, never verified, when the page is not labeled with a surface the requirements can match', async () => {
    // Without a screenId the page is "page", which is no surface. The requirement for clusters
    // might be about this page, and nothing checked it, so the honest answer is a gap.
    html = headingPage('Reports');
    const { dir } = await makeProject({ 'heading.yaml': HEADING_REQUIREMENT });
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { projectRoot: dir, tabCap: 10 });
      expect(result.verdict).toBe('not_covered');
      expect(result.gaps.map((g) => g.ref)).toContain('requirement:clusters-heading');
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is not_covered when a requirement names a surface that matches no configured or discovered surface', async () => {
    html = headingPage('Clusters');
    const { dir } = await makeProject({ 'orphan.yaml': ORPHAN_REQUIREMENT });
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
      expect(result.verdict).toBe('not_covered');
      expect(result.gaps.map((g) => g.ref)).toContain('requirement:clustrs-heading');
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is not_covered when the requirements cannot be loaded', async () => {
    html = headingPage('Clusters');
    const { dir } = await makeProject({ 'broken.yaml': 'version: 1\nrequirements: [1, 2\n' });
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
      expect(result.verdict).toBe('not_covered');
      expect(result.gaps.map((g) => g.ref)).toEqual(['requirements/broken.yaml']);
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('agrees with the CLI on a flow requirement that expects a live region announcement', async () => {
    // Save writes "Saved" into a role="status" region. The CLI's init script observes live regions
    // from document start. checkPage adopts a page that is already open, so it has to install the
    // same observer, or the flow reads no announcement and regresses where the CLI passes.
    html = SAVE_PAGE;
    const { dir, config } = await makeProject({ 'save.yaml': SAVE_REQUIREMENT });
    try {
      const deps = await buildDeps(config, { cwd: dir, env: {} });
      let cliFailures: string[];
      try {
        const scan = await deps.checkRunner.scan({ id: 'clusters', url: `${baseUrl}/clusters` });
        cliFailures = scan.drafts.filter((d) => d.confidence === 'fail').map((d) => d.rule);
      } finally {
        await deps.browser.close();
      }
      expect(cliFailures).toEqual([]);

      const { context, page } = await openUrl(`${baseUrl}/clusters`);
      try {
        const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
        expect(result.failures.map((f) => f.rule)).toEqual([]);
        expect(result.gaps).toEqual([]);
        expect(result.verdict).toBe('verified');
      } finally {
        await context.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs a voice requirement in the CLI scan and in checkPage, and finds nothing when the save is announced', async () => {
    html = SAVE_PAGE;
    const { dir, config } = await makeProject({ 'save-voice.yaml': SAVE_VOICE_REQUIREMENT });
    try {
      const deps = await buildDeps(config, { cwd: dir, env: {} });
      try {
        const scan = await deps.checkRunner.scan({ id: 'clusters', url: `${baseUrl}/clusters` });
        expect(scan.gaps.filter((g) => g.ref === 'provider:intake:save-voices')).toEqual([]);
        expect(scan.drafts.filter((d) => d.layer === 'voicing')).toEqual([]);
      } finally {
        await deps.browser.close();
      }

      const { context, page } = await openUrl(`${baseUrl}/clusters`);
      try {
        const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
        expect(result.drafts.filter((d) => d.layer === 'voicing')).toEqual([]);
        expect(result.gaps).toEqual([]);
        expect(result.verdict).toBe('verified');
      } finally {
        await context.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a silent save under a voice requirement as preview drafts that never block', async () => {
    html = silentSavePage('');
    const { dir, config } = await makeProject({ 'save-voice.yaml': SAVE_VOICE_REQUIREMENT });
    try {
      const deps = await buildDeps(config, { cwd: dir, env: {} });
      try {
        const scan = await deps.checkRunner.scan({ id: 'clusters', url: `${baseUrl}/clusters` });
        const voicing = scan.drafts.filter((d) => d.layer === 'voicing');
        expect(voicing.map((d) => [d.rule, d.evidenceClass, d.confidence]).sort()).toEqual([
          ['intake:save-voices/missing-announcement', 'preview', 'unverified'],
          ['intake:save-voices/missing-live-announcement', 'preview', 'unverified'],
        ]);
      } finally {
        await deps.browser.close();
      }

      const { context, page } = await openUrl(`${baseUrl}/clusters`);
      try {
        const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
        // Preview evidence decides nothing on a page check, as in the gate: it is advisory.
        expect(result.failures.filter((d) => d.layer === 'voicing')).toEqual([]);
        expect(result.needsReview.filter((d) => d.layer === 'voicing')).toEqual([]);
        expect((result.advisory ?? []).map((d) => d.rule).sort()).toEqual([
          'intake:save-voices/missing-announcement',
          'intake:save-voices/missing-live-announcement',
        ]);
        expect(result.gaps).toEqual([]);
        expect(result.verdict).toBe('verified');
      } finally {
        await context.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Announcements used to be read through window.__usablDrain, a function in the page's own world.
  // A page could define one before adoption, or replace usabl's after load, and hand usabl an
  // announcement no screen reader spoke. Neither may pass a flow requirement.
  it('does not pass a flow requirement on announcements from a drain the page defined before adoption', async () => {
    html = silentSavePage(`window.__usablDrain = () => ['Saved'];`);
    const { dir } = await makeProject({ 'save.yaml': SAVE_REQUIREMENT });
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 10 });
      expect(result.verdict).not.toBe('verified');
      expect(result.failures.map((f) => f.rule)).toContain('intake:save-announces');
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not pass a flow requirement on announcements from a drain the page replaced after load', async () => {
    html = silentSavePage(`window.addEventListener('load', () => { window.__usablDrain = () => ['Saved']; });`);
    const { dir, config } = await makeProject({ 'save.yaml': SAVE_REQUIREMENT });
    try {
      const deps = await buildDeps(config, { cwd: dir, env: {} });
      try {
        const scan = await deps.checkRunner.scan({ id: 'clusters', url: `${baseUrl}/clusters` });
        const failures = scan.drafts.filter((d) => d.confidence === 'fail').map((d) => d.rule);
        expect(failures).toContain('intake:save-announces');
      } finally {
        await deps.browser.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is not_covered, and names the root, when the caller passes a projectRoot with no usabl.config.json', async () => {
    html = headingPage('Clusters');
    const empty = await mkdtemp(join(tmpdir(), 'usabl-checkpage-empty-'));
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { screenId: 'clusters', projectRoot: empty, tabCap: 10 });
      expect(result.verdict).toBe('not_covered');
      const configGap = result.gaps.find((g) => g.ref === 'usabl.config.json');
      expect(configGap?.reason).toContain(empty);
      expect(result.project).toEqual({ root: empty, configFound: false });
    } finally {
      await context.close();
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('says which root it read when projectRoot defaults to the working directory', async () => {
    html = headingPage('Clusters');
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { tabCap: 10 });
      expect(result.project?.root).toBe(process.cwd());
      expect(result.project?.configFound).toBe(existsSync(join(process.cwd(), 'usabl.config.json')));
    } finally {
      await context.close();
    }
  });

  it('gives an unlabeled page a gap for every requirement, even when a surface is literally named page', async () => {
    // If the unlabeled default read as the surface "page", the clusters requirement would drop out
    // of scope with no gap, and the page requirement would be judged on a page nobody labeled.
    html = headingPage('Reports');
    const { dir } = await makeProject(
      { 'heading.yaml': HEADING_REQUIREMENT, 'page.yaml': PAGE_SURFACE_REQUIREMENT },
      ['page', 'clusters'],
    );
    const { context, page } = await openUrl(`${baseUrl}/clusters`);
    try {
      const result = await checkPage(page, { projectRoot: dir, tabCap: 10 });
      expect(result.verdict).toBe('not_covered');
      expect(result.failures.filter((f) => f.rule.startsWith('intake:'))).toEqual([]);
      expect(result.gaps.map((g) => g.ref).sort()).toEqual(['requirement:clusters-heading', 'requirement:page-heading']);
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const SAVE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Clusters</title>
  </head>
  <body>
    <main>
      <h1>Clusters</h1>
      <button type="button" id="save">Save</button>
      <div role="status" id="message"></div>
    </main>
    <script>
      document.getElementById('save').addEventListener('click', () => {
        document.getElementById('message').textContent = 'Saved';
      });
    </script>
  </body>
</html>`;

// The save page with a Save button that announces nothing, and a script of the page's own.
function silentSavePage(script: string): string {
  return SAVE_PAGE.replace("document.getElementById('message').textContent = 'Saved';", '').replace(
    '</body>',
    `<script>${script}</script></body>`,
  );
}

const SAVE_REQUIREMENT = `version: 1
requirements:
  - id: save-announces
    kind: flow
    surface: clusters
    description: Saving announces that the change was saved.
    assertion:
      type: flow
      steps:
        - do: click
          selector: '#save'
      expectedAnnouncement: Saved
    approved: true
`;

// The same save action written as a voice requirement: an interaction contract the virtual screen
// reader runs. Its drafts are preview, because no obligation class is promoted.
const SAVE_VOICE_REQUIREMENT = `version: 1
requirements:
  - id: save-voices
    kind: voice
    surface: clusters
    description: Saving keeps focus on Save and announces that the change was saved.
    assertion:
      type: voice
      steps:
        - do: click
          selector: '#save'
      obligations:
        - class: live-polite
          afterStep: 0
          requiredTokens: [saved]
          focusedRole: button
          mustAnnounce: true
    approved: true
`;

const PAGE_SURFACE_REQUIREMENT = `version: 1
requirements:
  - id: page-heading
    kind: content
    surface: page
    description: The page surface heading reads Page.
    assertion:
      type: content
      selector: h1
      expectedText: Page
    approved: true
`;

// A screen in usabl.config.json can declare a readiness signal: a selector that must match, and a
// data response that must have been answered, before usabl will check it. The CLI waits for it and
// gaps the screen when it does not hold. checkPage used to ignore it and check whatever the page
// showed, so a sign-in page or a half-mounted shell handed to it as the clusters screen could pass.
describe.skipIf(process.env.USABL_INTEGRATION !== '1')('checkPage applies a declared readiness signal', { timeout: 60_000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  // The page has an image with no alt text, so a check that ran its providers reports a failure.
  function ordersPage(mountScript: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Clusters</title>
  </head>
  <body>
    <main id="main">
      <h1>Clusters</h1>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
    </main>
    <script>${mountScript}</script>
  </body>
</html>`;
  }

  const MOUNT_NOW = `document.getElementById('main').insertAdjacentHTML('beforeend', '<table id="orders"><tr><th>Order</th></tr></table>');`;
  // The late content carries the only barrier on its page: a second image with no alt text, with
  // its own id so its path differs from the first image's.
  const LATE_PAGE = ordersPage(
    `setTimeout(() => { document.getElementById('main').innerHTML = '<h1>Clusters</h1><table id="orders"><tr><th>Order</th></tr></table><img id="late" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />'; }, 4000);`,
  ).replace(/<img src=[^>]*>/, '');

  async function makeSignalProject(reachedWhen: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'usabl-checkpage-ready-'));
    const config = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['src/clusters.tsx'], reachedWhen }],
      guardedPaths: [],
      signalTimeoutMs: 10000,
    };
    await writeFile(join(dir, 'usabl.config.json'), JSON.stringify(config, null, 2));
    return dir;
  }

  async function check(html: string, reachedWhen: unknown) {
    const dir = await makeSignalProject(reachedWhen);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // The page is served at the address the config gives the screen, because checkPage holds a
      // labeled page to that address. Nothing listens there; the route answers instead.
      await page.route('http://127.0.0.1:5173/clusters', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
      );
      await page.goto('http://127.0.0.1:5173/clusters', { waitUntil: 'domcontentloaded' });
      return await checkPage(page, { screenId: 'clusters', projectRoot: dir, tabCap: 5 });
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('is not_covered, names the selector, and runs no checks when the selector never matches', async () => {
    const result = await check(ordersPage(''), '#orders');

    expect(result.verdict).toBe('not_covered');
    expect(result.drafts).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.state).toBe('not-covered');
    expect(result.gaps[0]?.reason).toContain('#orders');
  });

  it('checks the page when the declared selector matches', async () => {
    const result = await check(ordersPage(MOUNT_NOW), '#orders');

    expect(result.gaps).toEqual([]);
    expect(result.verdict).toBe('regression');
    expect(result.failures.map((failure) => failure.rule)).toContain('image-alt');
  });

  it('waits for a selector that mounts after the page first settled, as the CLI does', async () => {
    const result = await check(LATE_PAGE, { selector: '#orders' });

    expect(result.gaps).toEqual([]);
    expect(result.failures.map((failure) => failure.elementPath)).toContain('#late');
  });

  it('is not_covered and runs no checks when the screen declares a response checkPage cannot see', async () => {
    // checkPage sees only the requests sent after it adopted the page, and this page sent none, so
    // the declared response cannot be shown to have been answered.
    const result = await check(ordersPage(MOUNT_NOW), { selector: '#orders', response: '/api/orders' });

    expect(result.verdict).toBe('not_covered');
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.reason).toContain('/api/orders');
  });
});

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('checkPage holds a labeled page to its screen address', { timeout: 60_000 }, () => {
  let browser: Browser;
  let server: Server;
  let port: number;
  let dir: string;

  // Every path answers with the same accessible page, so only the address can tell the screens apart.
  // The sign-in path also shows a password field, as a sign-in page does.
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(path.startsWith('/login') || path.startsWith('/account') ? SIGN_IN_HTML : headingPage('Clusters'));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    port = address.port;
    // The config names another port, as a project whose tests run on their own base URL does.
    dir = await mkdtemp(join(tmpdir(), 'usabl-checkpage-landing-'));
    const config = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [
        { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['src/clusters.tsx'] },
        { id: 'hash-clusters', url: 'http://127.0.0.1:5173/#/clusters', files: ['src/hash.tsx'] },
        { id: 'account', url: 'http://127.0.0.1:5173/account', files: ['src/account.tsx'] },
      ],
      guardedPaths: [],
    };
    await writeFile(join(dir, 'usabl.config.json'), JSON.stringify(config, null, 2));
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(dir, { recursive: true, force: true });
  });

  async function checkAt(url: string, options: Parameters<typeof checkPage>[1]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await checkPage(page, { projectRoot: dir, tabCap: 10, ...options });
    } finally {
      await context.close();
    }
  }

  const ordinary: Array<[string, () => string, string]> = [
    ['on its own base URL and port', () => `http://127.0.0.1:${port}/clusters`, 'clusters'],
    ['on localhost where the config says 127.0.0.1', () => `http://localhost:${port}/clusters`, 'clusters'],
    ['with a trailing slash the config does not have', () => `http://127.0.0.1:${port}/clusters/`, 'clusters'],
    ['in a hash-routed app', () => `http://localhost:${port}/#/clusters`, 'hash-clusters'],
    ['in a hash-routed app whose route holds a query and a trailing slash', () => `http://localhost:${port}/#/clusters/?page=2`, 'hash-clusters'],
  ];
  for (const [name, urlOf, screenId] of ordinary) {
    it(`is verified ${name}`, async () => {
      const result = await checkAt(urlOf(), { screenId });
      expect(result.gaps).toEqual([]);
      expect(result.verdict).toBe('verified');
    });
  }

  it('is not_covered, names both addresses, and runs no checks when the session expired and the page landed on a sign-in path', async () => {
    const result = await checkAt(`http://127.0.0.1:${port}/login?next=%2Fclusters`, { screenId: 'clusters' });

    expect(result.verdict).toBe('not_covered');
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ ref: 'landing:clusters', state: 'not-covered' });
    expect(result.gaps[0]?.reason).toContain('/clusters');
    expect(result.gaps[0]?.reason).toContain('/login');
    // The query can carry a return address or a token, so it is not shown.
    expect(result.gaps[0]?.reason).not.toContain('next=');
  });

  it('is not_covered when a hash-routed app landed on another route', async () => {
    const result = await checkAt(`http://localhost:${port}/#/login`, { screenId: 'hash-clusters' });
    expect(result.verdict).toBe('not_covered');
    expect(result.gaps.map((gap) => gap.ref)).toEqual(['landing:hash-clusters']);
  });

  it('does not check the address of an unlabeled page, which claims no screen', async () => {
    const result = await checkAt(`http://127.0.0.1:${port}/elsewhere`, {});
    expect(result.gaps).toEqual([]);
    expect(result.verdict).toBe('verified');
  });

  it('holds the page to the address the caller passes', async () => {
    const met = await checkAt(`http://127.0.0.1:${port}/reports`, { screenId: 'reports', expectedUrl: '/reports' });
    expect(met.gaps).toEqual([]);
    expect(met.verdict).toBe('verified');

    const missed = await checkAt(`http://127.0.0.1:${port}/login`, { screenId: 'clusters', expectedUrl: 'http://localhost:9999/clusters' });
    expect(missed.verdict).toBe('not_covered');
    expect(missed.gaps.map((gap) => gap.ref)).toEqual(['landing:clusters']);
  });

  it('applies the CLI rule for a password field when the run asserts a session the CLI way', async () => {
    const before = process.env['USABL_STORAGE_STATE'];
    process.env['USABL_STORAGE_STATE'] = join(dir, 'state.json');
    try {
      const result = await checkAt(`http://127.0.0.1:${port}/account`, { screenId: 'account' });
      expect(result.verdict).toBe('not_covered');
      expect(result.drafts).toEqual([]);
      expect(result.gaps.map((gap) => gap.ref)).toEqual(['landing:account']);
      expect(result.gaps[0]?.reason).toContain('asks for a password');
    } finally {
      if (before === undefined) {
        delete process.env['USABL_STORAGE_STATE'];
      } else {
        process.env['USABL_STORAGE_STATE'] = before;
      }
    }
  });

  it('does not apply the session rules when the run asserts no session', async () => {
    const result = await checkAt(`http://127.0.0.1:${port}/account`, { screenId: 'account' });
    expect(result.gaps).toEqual([]);
  });
});
