/**
 * The design input end to end in real Chromium. `usabl import figma` reads the mock Figma file from
 * the mock API and writes the draft requirements file. The drafted requirements are then checked
 * on a page built to the design, on a page that breaks it, and on a page where only one control is
 * too small. Approved, the broken page gives exactly four findings that gate: three failures and
 * one needs review. Unapproved, the same four are preview and the gate verdict does not move.
 * checkPage runs the same checks when it reads the project from a folder.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { BrowserDriver, Coverage, Draft, RequirementBundle, UsablConfig } from '../../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../../src/deps/real.js';
import { gate } from '../../../src/gate/index.js';
import { runImportCommand } from '../../../src/import/figma/cli.js';
import { mapRequirementsToProviders } from '../../../src/intake/map-to-providers.js';
import { normalize } from '../../../src/intake/normalize.js';
import { runProviders } from '../../../src/providers/index.js';
import { checkPage } from '../../../src/surfaces/playwright-helper.js';
import { testConfig } from '../../helpers.js';
import { REAL_PROCESS_BUDGET_MS } from '../../support/timing.js';
import { MOCK_TOKEN, startMockFigma } from './mock-server.js';

const PAGES = ['users-screen.html', 'users-screen-broken.html', 'users-screen-small-target.html'] as const;

const RULES = {
  heading: 'intake:figma-users-heading-1',
  name: 'intake:figma-users-name-1',
  focusOrder: 'intake:figma-users-focus-order-1',
  targetSize: 'intake:figma-users-target-size-1',
};

const covered: Coverage = {
  changedFiles: ['src/Users.tsx'],
  affected: [{ screenId: 'users', url: 'http://127.0.0.1/users', provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};

function gateOn(drafts: Draft[]) {
  return gate({
    coverage: covered,
    guardDivergedPaths: [],
    drafts,
    floor: { version: 2, entries: [] },
    waivers: [],
    now: '2026-01-01T00:00:00.000Z',
    cleanlyScannedScreens: new Set(['users']),
  });
}

const isDesignRule = (draft: Draft): boolean => Object.values(RULES).includes(draft.rule);

// What a reviewer does: set approved: true on each requirement line. The guidance comment is left.
const approve = (yaml: string): string => yaml.replace(/^ {4}approved: false$/gmu, '    approved: true');

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('design input from Figma, end to end', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  let driver: BrowserDriver;
  let browser: Browser;
  let server: Server;
  let baseUrl: string;
  let project: string;
  let draftYaml: string;
  let drafted: RequirementBundle;
  let approved: RequirementBundle;

  beforeAll(async () => {
    // The import, exactly as a person runs it, against the mock Figma API.
    const mock = await startMockFigma();
    project = await mkdtemp(join(tmpdir(), 'usabl-figma-e2e-'));
    await mkdir(join(project, 'requirements'));
    const out = join(project, 'requirements', 'figma.yaml');
    try {
      const outcome = await runImportCommand(
        ['figma', 'MOCKKEY', '--frame', 'Users=users', '--out', out, '--min-target', '24'],
        { FIGMA_TOKEN: MOCK_TOKEN, FIGMA_API_BASE: mock.base },
      );
      expect(outcome.exitCode).toBe(0);
    } finally {
      await mock.close();
    }
    draftYaml = await readFile(out, 'utf8');
    const loaded = normalize(draftYaml);
    if (!loaded.ok) {
      throw new Error(`the drafted file does not load: ${loaded.reason}`);
    }
    drafted = loaded.bundle;
    approved = { ...drafted, requirements: drafted.requirements.map((requirement) => ({ ...requirement, approved: true })) };

    const pages = new Map<string, string>();
    for (const name of PAGES) {
      pages.set(`/${name}`, await readFile(fileURLToPath(new URL(`../../../fixtures/live/${name}`, import.meta.url)), 'utf8'));
    }
    server = createServer((req, res) => {
      const body = pages.get(req.url ?? '');
      res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body ?? 'not found');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    driver = makeRealBrowserDriver();
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await driver?.close();
    await browser?.close();
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    await rm(project, { recursive: true, force: true });
  });

  async function scan(page: (typeof PAGES)[number], bundle: RequirementBundle) {
    const opened = await driver.open(`${baseUrl}/${page}`);
    try {
      await opened.gotoReady();
      return await runProviders(
        mapRequirementsToProviders(bundle),
        { page: opened, screen: { id: 'users', url: `${baseUrl}/${page}` }, config: testConfig() },
        ['live'],
      );
    } finally {
      await opened.close();
    }
  }

  it('drafts five unapproved requirements from the mock design', () => {
    expect(drafted.requirements.map((requirement) => [requirement.kind, requirement.approved])).toEqual([
      ['heading', false],
      ['landmark', false],
      ['name', false],
      ['target-size', false],
      ['focus-order', false],
    ]);
  });

  it('finds nothing on the page built to the design', async () => {
    const result = await scan('users-screen.html', approved);
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toEqual([]);
    expect(gateOn(result.drafts).verdict).toBe('verified');
  });

  it('gives exactly four findings that gate on the broken page, once approved', async () => {
    const result = await scan('users-screen-broken.html', approved);
    expect(result.gaps).toEqual([]);
    expect(result.drafts.map((draft) => [draft.rule, draft.evidenceClass, draft.confidence]).sort()).toEqual(
      [
        [RULES.focusOrder, 'deterministic', 'fail'],
        [RULES.heading, 'deterministic', 'fail'],
        [RULES.name, 'deterministic', 'fail'],
        // No button is named Refresh, so its size cannot be measured. That is unknown, not a pass.
        [RULES.targetSize, 'deterministic', 'unverified'],
      ].sort(),
    );
    const heading = result.drafts.find((draft) => draft.rule === RULES.heading);
    expect(heading?.whatUserExperiences).toContain('is level 2. The design says level 1.');
    expect(gateOn(result.drafts).verdict).toBe('regression');
  });

  it('shows the same four as preview while unapproved, and the gate verdict does not move', async () => {
    const result = await scan('users-screen-broken.html', drafted);
    expect(result.gaps).toEqual([]);
    expect(result.drafts.map((draft) => draft.rule).sort()).toEqual(Object.values(RULES).sort());
    expect(result.drafts.every((draft) => draft.evidenceClass === 'preview')).toBe(true);
    expect(gateOn(result.drafts).verdict).toBe('verified');
  });

  it('measures the size on a page where only the Refresh button is too small', async () => {
    const result = await scan('users-screen-small-target.html', approved);
    expect(result.gaps).toEqual([]);
    expect(result.drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([[RULES.targetSize, 'fail']]);
    expect(result.drafts[0]?.whatUserExperiences).toContain('is 16 by 16 CSS pixels');
  });

  describe('checkPage reading the project from a folder', () => {
    // checkPage holds a labeled page to its surface's configured address, so each case writes the
    // users surface at the page it opens. A page at another address would be a landing gap.
    async function writeProject(page: (typeof PAGES)[number], yaml: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'usabl-figma-checkpage-'));
      const config: UsablConfig = {
        appBaseUrl: baseUrl,
        uiFileGlobs: ['src/**'],
        discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
        surfaces: [{ id: 'users', url: `${baseUrl}/${page}`, files: ['src/Users.tsx'] }],
        requirements: 'requirements',
        guardedPaths: [],
      };
      await writeFile(join(dir, 'usabl.config.json'), JSON.stringify(config, null, 2));
      await mkdir(join(dir, 'requirements'));
      await writeFile(join(dir, 'requirements', 'figma.yaml'), yaml);
      return dir;
    }

    async function check(page: (typeof PAGES)[number], yaml: string) {
      const dir = await writeProject(page, yaml);
      const context = await browser.newContext();
      try {
        const pwPage = await context.newPage();
        await pwPage.goto(`${baseUrl}/${page}`, { waitUntil: 'domcontentloaded' });
        const result = await checkPage(pwPage, { screenId: 'users', projectRoot: dir, tabCap: 20 });
        // The page is the one the case means to check, not a landing gap.
        expect(result.gaps.filter((gap) => gap.ref.startsWith('landing:'))).toEqual([]);
        return result;
      } finally {
        await context.close();
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('blocks on the approved design checks', async () => {
      const result = await check('users-screen-broken.html', approve(draftYaml));
      expect(result.verdict).toBe('regression');
      expect(result.failures.filter(isDesignRule).map((draft) => draft.rule).sort()).toEqual(
        [RULES.focusOrder, RULES.heading, RULES.name].sort(),
      );
      expect(result.needsReview.filter(isDesignRule).map((draft) => draft.rule)).toEqual([RULES.targetSize]);
      expect(result.gaps.filter((gap) => gap.ref.includes('figma-'))).toEqual([]);
    });

    it('lists the unapproved design checks as advisory only', async () => {
      const result = await check('users-screen-broken.html', draftYaml);
      expect(result.failures.filter(isDesignRule)).toEqual([]);
      expect(result.needsReview.filter(isDesignRule)).toEqual([]);
      expect((result.advisory ?? []).filter(isDesignRule).map((draft) => draft.rule).sort()).toEqual(Object.values(RULES).sort());
    });

    it('finds no design check failure on the page built to the design', async () => {
      const result = await check('users-screen.html', approve(draftYaml));
      expect(result.drafts.filter(isDesignRule)).toEqual([]);
      expect(result.gaps.filter((gap) => gap.ref.includes('figma-'))).toEqual([]);
    });
  });
});
