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
      expect(result.gaps.map((g) => g.ref)).toContain('requirements');
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
