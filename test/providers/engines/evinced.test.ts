/**
 * The Evinced provider against a fake SDK built to the documented contract. The issue shape is
 * only partly documented, so the messy-input cases matter as much as the clean ones.
 *
 * Evinced findings are preview in this release. The mapping still knows how to promote a type, so
 * the disclosures that guard a promoted type are tested here, at the mapping, for when a live run on
 * a licensed SDK names the stable types. The provider itself never promotes.
 */
import { describe, expect, it } from 'vitest';
import type { Page, ProviderContext, ProviderRunResult } from '../../../src/contracts/index.js';
import { makeFakePage } from '../../../src/deps/fakes.js';
import { registerPlaywrightPage } from '../../../src/providers/engines/shared.js';
import { runProviders } from '../../../src/providers/index.js';
import {
  evincedAnalyzeOptions,
  evincedCapabilities,
  makeEvincedProvider,
  mapEvincedIssues,
  type EvincedProviderOptions,
} from '../../../src/providers/engines/evinced.js';
import { applicabilityOf, draftsOf, gapsOf, testConfig } from '../../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };
const AXE_IDS: ReadonlySet<string> = new Set(['image-alt', 'button-name']);

// Fake credential values. The tests assert they never appear in anything the provider produces.
const SERVICE_ID = 'svc-5f1e0c-fake-service-id';
const AUTH_TOKEN = 'tok-9c3b7a-fake-offline-token';
const API_KEY = 'key-2d8e4f-fake-online-secret';
const OFFLINE_ENV = { EVINCED_SERVICE_ID: SERVICE_ID, EVINCED_AUTH_TOKEN: AUTH_TOKEN };
const ONLINE_ENV = { EVINCED_SERVICE_ID: SERVICE_ID, EVINCED_API_KEY: API_KEY };

const WRONG_ROLE = {
  type: { id: 'WRONG_SEMANTIC_ROLE', name: 'Wrong Semantic Role' },
  severity: { id: 'CRITICAL', name: 'Critical' },
  elements: [{ selector: 'div.toolbar > span.btn' }, { selector: 'div.footer > span.btn' }],
  summary: 'This element acts as a button but is not announced as one.',
  description: 'A screen reader user hears plain text and cannot tell this control does anything.',
  knowledgeBaseLink: 'https://knowledge.evinced.com/system-validations/wrong-semantic-role',
};
const NOT_FOCUSABLE = {
  type: { id: 'NOT_FOCUSABLE', name: 'Not Focusable' },
  severity: { name: 'Serious' },
  elements: [{ selector: '#menu-toggle' }],
};

function livePage(): Page {
  const page = makeFakePage();
  registerPlaywrightPage(page, { fake: 'playwright page' });
  return page;
}

function ctxFor(page: Page = livePage(), config = testConfig()): ProviderContext {
  return { page, screen: SCREEN, config };
}

interface Calls {
  upload: unknown[];
  offline: unknown[];
  online: unknown[];
  constructed: unknown[];
  analyze: unknown[];
}

function newCalls(): Calls {
  return { upload: [], offline: [], online: [], constructed: [], analyze: [] };
}

function fakeEvincedModule(
  issues: unknown,
  calls: Calls,
  overrides: { analyze?: () => Promise<unknown>; upload?: boolean; credentials?: () => Promise<void> } = {},
) {
  return async () => ({
    ...(overrides.upload === false
      ? {}
      : { setUploadToPlatformConfig: (config: unknown) => void calls.upload.push(config) }),
    setOfflineCredentials: (credentials: unknown) => {
      calls.offline.push(credentials);
      return overrides.credentials?.();
    },
    setCredentials: async (credentials: unknown) => {
      calls.online.push(credentials);
      return overrides.credentials?.();
    },
    EvincedSDK: class {
      constructor(page: unknown) {
        calls.constructed.push(page);
      }
      async evAnalyze(options: unknown) {
        calls.analyze.push(options);
        return overrides.analyze === undefined ? issues : overrides.analyze();
      }
    },
  });
}

const INSTALLED = async () => ({ state: 'installed' as const, version: '3.9.0', missingDependencies: [] });

// Every test names its own loader and environment, and nothing on disk is ever consulted.
function provider(
  config: Parameters<typeof makeEvincedProvider>[0],
  load: () => Promise<unknown>,
  env: Record<string, string | undefined> = OFFLINE_ENV,
  extra: EvincedProviderOptions = {},
) {
  return makeEvincedProvider(config, {
    load,
    env,
    axeRuleIds: async () => AXE_IDS,
    fileExists: async () => false,
    probe: INSTALLED,
    ...extra,
  });
}

describe('mapEvincedIssues', () => {
  it('maps one preview draft per element with the Evinced layer and a prefixed rule', () => {
    const { drafts, gaps, notes } = mapEvincedIssues([WRONG_ROLE, NOT_FOCUSABLE], SCREEN.id);

    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toEqual({
      rule: 'evinced:WRONG_SEMANTIC_ROLE',
      layer: 'evinced',
      severity: 'critical',
      evidenceClass: 'preview',
      screenId: SCREEN.id,
      elementPath: 'div.toolbar > span.btn',
      elementName: null,
      role: null,
      whatUserExperiences: 'This element acts as a button but is not announced as one.',
      why: 'A screen reader user hears plain text and cannot tell this control does anything.',
      fix: "Follow Evinced's guidance for Wrong Semantic Role: https://knowledge.evinced.com/system-validations/wrong-semantic-role",
      evidence: { extra: { evincedSeverity: 'Critical' } },
      confidence: 'fail',
    });
    expect(drafts[1]?.elementPath).toBe('div.footer > span.btn');
    expect(drafts[2]).toMatchObject({
      rule: 'evinced:NOT_FOCUSABLE',
      severity: 'serious',
      whatUserExperiences: 'Not Focusable',
      why: 'Evinced reports this element as Not Focusable.',
      fix: "Evinced gave no fix text for this issue. Look up Not Focusable in Evinced's knowledge base.",
    });
    expect(gaps).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('makes a promoted type deterministic and leaves every other type preview', () => {
    const { drafts } = mapEvincedIssues([WRONG_ROLE, NOT_FOCUSABLE], SCREEN.id, new Set(['WRONG_SEMANTIC_ROLE']));
    expect(drafts.map((draft) => [draft.rule, draft.evidenceClass])).toEqual([
      ['evinced:WRONG_SEMANTIC_ROLE', 'deterministic'],
      ['evinced:WRONG_SEMANTIC_ROLE', 'deterministic'],
      ['evinced:NOT_FOCUSABLE', 'preview'],
    ]);
  });

  it('keeps an unknown severity as preview even when its type is promoted', () => {
    const needsReview = { ...NOT_FOCUSABLE, severity: { id: 'NEEDS_REVIEW', name: 'Needs Review' } };
    const bestPractice = { ...WRONG_ROLE, severity: { name: 'Best Practice' } };
    const { drafts, gaps } = mapEvincedIssues(
      [needsReview, bestPractice],
      SCREEN.id,
      new Set(['NOT_FOCUSABLE', 'WRONG_SEMANTIC_ROLE']),
    );
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => draft.evidenceClass === 'preview')).toBe(true);
    expect(drafts.every((draft) => draft.severity === 'moderate')).toBe(true);
    expect(drafts[0]?.evidence.extra).toEqual({ evincedSeverity: 'Needs Review' });
    // Their severity was read: Evinced itself did not call them a failure at a known impact.
    expect(gaps).toEqual([]);
  });

  it('reads a plain string severity, and a promoted one gates', () => {
    const plain = { ...WRONG_ROLE, severity: 'Critical' };
    const result = mapEvincedIssues([plain], SCREEN.id, new Set(['WRONG_SEMANTIC_ROLE']));
    expect(result.drafts.map((draft) => [draft.severity, draft.evidenceClass])).toEqual([
      ['critical', 'deterministic'],
      ['critical', 'deterministic'],
    ]);
    expect(result.gaps).toEqual([]);
  });

  it('discloses promoted issues whose severity it cannot read as a gap, and still shows them', () => {
    const noSeverity = { type: WRONG_ROLE.type, elements: [{ selector: '#a' }] };
    const emptySeverity = { type: WRONG_ROLE.type, severity: {}, elements: [{ selector: '#b' }] };
    const result = mapEvincedIssues([noSeverity, emptySeverity], SCREEN.id, new Set(['WRONG_SEMANTIC_ROLE']));
    expect(result.drafts.map((draft) => [draft.elementPath, draft.evidenceClass])).toEqual([
      ['#a', 'preview'],
      ['#b', 'preview'],
    ]);
    expect(result.gaps).toEqual([
      {
        ref: 'provider:evinced',
        state: 'not-covered',
        reason:
          '2 promoted Evinced issue(s) with an unreadable severity were shown but could not block, because usabl cannot tell what impact Evinced gave them.',
      },
    ]);
  });

  it('reads messy issues without throwing, and notes what it could not show', () => {
    const messy: unknown[] = [
      null,
      'not an issue',
      42,
      {},
      { type: 'WRONG_SEMANTIC_ROLE', elements: [{ selector: 'a' }] },
      { type: { id: '' }, elements: [{ selector: 'a' }] },
      { type: { id: 'NO_ELEMENTS' }, severity: { name: 'Critical' } },
      { type: { id: 'ELEMENTS_NOT_ARRAY' }, severity: { name: 'Critical' }, elements: { selector: 'a' } },
      {
        type: { id: 'MIXED_ELEMENTS' },
        elements: [null, 'b', { selector: 7 }, { selector: '' }, { selector: '#ok', domSnippet: '<i>' }],
      },
      { type: { id: 'NO_SEVERITY' }, elements: [{ selector: '#x' }] },
      { type: { id: 'SEVERITY_NOT_OBJECT' }, severity: 'Critical', elements: [{ selector: '#y' }] },
    ];

    const { drafts, gaps, notes } = mapEvincedIssues(messy, SCREEN.id);

    expect(drafts.map((draft) => [draft.rule, draft.elementPath, draft.severity, draft.evidenceClass])).toEqual([
      ['evinced:MIXED_ELEMENTS', '#ok', 'moderate', 'preview'],
      ['evinced:NO_SEVERITY', '#x', 'moderate', 'preview'],
      ['evinced:SEVERITY_NOT_OBJECT', '#y', 'critical', 'preview'],
    ]);
    expect(drafts[0]?.whatUserExperiences).toBe('MIXED_ELEMENTS');
    // Nothing here could gate, so nothing is a gap. What could not be shown is still disclosed:
    // six issues with no readable type, two with no element list, and four unreadable elements.
    expect(gaps).toEqual([]);
    expect(notes).toEqual([
      {
        ref: 'provider:evinced',
        reason:
          'Evinced reported 6 issue(s) with no type usabl could read and 6 element(s) with no selector usabl could use, so they are not shown. Its findings are preview, so this does not change the verdict.',
      },
    ]);
  });

  it('counts every promoted element it could not read as a gap, even when others were read', () => {
    const partly = {
      type: { id: 'WRONG_SEMANTIC_ROLE' },
      severity: { name: 'Critical' },
      elements: [{ selector: '#ok' }, { domSnippet: '<span>' }, null],
    };
    const result = mapEvincedIssues([partly], SCREEN.id, new Set(['WRONG_SEMANTIC_ROLE']));
    expect(result.drafts.map((draft) => [draft.elementPath, draft.evidenceClass])).toEqual([['#ok', 'deterministic']]);
    expect(result.gaps.map((gap) => gap.reason)).toEqual([
      '2 promoted Evinced element(s) could not be read: Evinced gave no element selector usabl could use, so they could not be checked against the gate.',
    ]);
  });

  it('counts a promoted issue with an empty or missing element list as one unreadable element', () => {
    for (const elements of [[], 'x', undefined]) {
      const issue = { type: { id: 'WRONG_SEMANTIC_ROLE' }, severity: { name: 'Critical' }, elements };
      const result = mapEvincedIssues([issue], SCREEN.id, new Set(['WRONG_SEMANTIC_ROLE']));
      expect(result.drafts).toEqual([]);
      expect(result.gaps.map((gap) => gap.reason)).toEqual([
        '1 promoted Evinced element(s) could not be read: Evinced gave no element selector usabl could use, so they could not be checked against the gate.',
      ]);
    }
  });
});

describe('makeEvincedProvider', () => {
  it('declares live and secrets, and network only in online mode', () => {
    expect(evincedCapabilities({ enabled: true })).toEqual(['live', 'secrets']);
    expect(evincedCapabilities({ enabled: true, mode: 'offline' })).toEqual(['live', 'secrets']);
    expect(evincedCapabilities({ enabled: true, mode: 'online' })).toEqual(['live', 'secrets', 'network']);
  });

  it('runs offline: upload off, offline credentials, axe rules off, preview findings, no applicability', async () => {
    const calls = newCalls();
    const output = await provider({ enabled: true }, fakeEvincedModule([WRONG_ROLE], calls)).run(ctxFor());

    expect(calls.upload).toEqual([{ enableUploadToPlatform: false }]);
    expect(calls.offline).toEqual([{ serviceId: SERVICE_ID, token: AUTH_TOKEN }]);
    expect(calls.online).toEqual([]);
    expect(calls.constructed).toEqual([{ fake: 'playwright page' }]);
    expect(calls.analyze).toEqual([
      {
        switchOn: true,
        analysis: { AXE_CONFIG: { rules: { 'button-name': { enabled: false }, 'image-alt': { enabled: false } } } },
      },
    ]);
    expect(draftsOf(output).map((draft) => draft.evidenceClass)).toEqual(['preview', 'preview']);
    // Evinced reports no passes, so it claims nothing about which rules ran clean.
    expect(applicabilityOf(output)).toEqual([]);
    expect(gapsOf(output)).toEqual([]);
  });

  it('never promotes a type in this release, whatever its severity', async () => {
    const output = await provider({ enabled: true }, fakeEvincedModule([WRONG_ROLE, NOT_FOCUSABLE], newCalls())).run(
      ctxFor(),
    );
    expect(draftsOf(output).every((draft) => draft.evidenceClass === 'preview')).toBe(true);
  });

  it('runs online with the API key credentials', async () => {
    const calls = newCalls();
    await provider({ enabled: true, mode: 'online' }, fakeEvincedModule([], calls), ONLINE_ENV).run(ctxFor());
    expect(calls.online).toEqual([{ serviceId: SERVICE_ID, secret: API_KEY }]);
    expect(calls.offline).toEqual([]);
  });

  it('still runs when the SDK has no upload switch to call', async () => {
    const calls = newCalls();
    const output = await provider({ enabled: true }, fakeEvincedModule([NOT_FOCUSABLE], calls, { upload: false })).run(
      ctxFor(),
    );
    expect(draftsOf(output)).toHaveLength(1);
  });

  it('disables every rule of the installed axe-core by default', async () => {
    const calls = newCalls();
    const real = makeEvincedProvider(
      { enabled: true },
      { load: fakeEvincedModule([], calls), env: OFFLINE_ENV, fileExists: async () => false, probe: INSTALLED },
    );
    await real.run(ctxFor());
    const rules = (calls.analyze[0] as { analysis: { AXE_CONFIG: { rules: Record<string, unknown> } } }).analysis
      .AXE_CONFIG.rules;
    expect(Object.keys(rules).length).toBeGreaterThan(50);
    expect(rules['color-contrast']).toEqual({ enabled: false });
  });

  it('builds the analyze options in a stable order', () => {
    expect(evincedAnalyzeOptions(new Set(['b', 'a']))).toEqual({
      switchOn: true,
      analysis: { AXE_CONFIG: { rules: { a: { enabled: false }, b: { enabled: false } } } },
    });
  });

  it('never writes the environment it reads', async () => {
    const env = Object.freeze({ ...OFFLINE_ENV });
    const output = await provider({ enabled: true }, fakeEvincedModule([NOT_FOCUSABLE], newCalls()), env).run(ctxFor());
    expect(draftsOf(output)).toHaveLength(1);
  });
});

const PREVIEW_SUFFIX = 'Its findings are preview, so this does not change the verdict.';

// While Evinced findings are preview, an Evinced that could not run is one note and adds no gap: a
// disclosure that cannot change the verdict must not block a pull request.
function failureOf(result: ProviderRunResult): string {
  expect(result.gaps).toEqual([]);
  expect(result.drafts).toEqual([]);
  expect(result.notes.map((note) => note.ref)).toEqual(['provider:evinced']);
  return result.notes[0]?.reason ?? '';
}

describe('Evinced failures become notes with a fix while its findings are preview', () => {
  async function runOne(
    p: ReturnType<typeof makeEvincedProvider>,
    allowed: Parameters<typeof runProviders>[2] = ['live', 'secrets', 'network'],
    page: Page = livePage(),
  ) {
    return runProviders([p], ctxFor(page), allowed);
  }

  it('says the package is not installed and how to get out', async () => {
    const notFound = Object.assign(new Error("Cannot find package '@evinced/js-playwright-sdk'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const p = provider({ enabled: true }, async () => Promise.reject(notFound), OFFLINE_ENV, {
      probe: async () => ({ state: 'not-installed' }),
    });
    expect(failureOf(await runOne(p))).toBe(
      `provider evinced did not run: Evinced is turned on in usabl.config.json but @evinced/js-playwright-sdk is not installed. Install it from Evinced's registry (Automation for Web license), or set engines.evinced.enabled to false. ${PREVIEW_SUFFIX}`,
    );
  });

  it('reports the real dynamic import of the absent package as not installed', async () => {
    const p = makeEvincedProvider({ enabled: true }, { env: OFFLINE_ENV, fileExists: async () => false });
    const reason = failureOf(await runOne(p));
    expect(reason).toContain('@evinced/js-playwright-sdk is not installed');
  });

  it('names the missing credential variables, never their values', async () => {
    const calls = newCalls();
    const offline = await runOne(provider({ enabled: true }, fakeEvincedModule([], calls), { EVINCED_SERVICE_ID: SERVICE_ID }));
    expect(failureOf(offline)).toBe(
      `provider evinced did not run: Evinced is turned on in usabl.config.json in offline mode, but EVINCED_AUTH_TOKEN is not set. Set EVINCED_SERVICE_ID and EVINCED_AUTH_TOKEN, or set engines.evinced.enabled to false. ${PREVIEW_SUFFIX}`,
    );
    const online = await runOne(provider({ enabled: true, mode: 'online' }, fakeEvincedModule([], calls), { EVINCED_API_KEY: '  ' }));
    expect(failureOf(online)).toBe(
      `provider evinced did not run: Evinced is turned on in usabl.config.json in online mode, but EVINCED_SERVICE_ID and EVINCED_API_KEY are not set. Set EVINCED_SERVICE_ID and EVINCED_API_KEY, or set engines.evinced.enabled to false. ${PREVIEW_SUFFIX}`,
    );
    expect(calls.constructed).toEqual([]);
  });

  it('refuses a module without the SDK or the credential function', async () => {
    const noSdk = await runOne(provider({ enabled: true }, async () => ({ setOfflineCredentials: () => {} })));
    expect(failureOf(noSdk)).toContain('does not export EvincedSDK');
    const noCredentials = await runOne(provider({ enabled: true, mode: 'online' }, async () => ({ EvincedSDK: class {} }), ONLINE_ENV));
    expect(failureOf(noCredentials)).toContain('does not export setCredentials');
  });

  it('refuses a page with no Playwright page behind it', async () => {
    const result = await runOne(provider({ enabled: true }, fakeEvincedModule([], newCalls())), undefined, makeFakePage());
    expect(failureOf(result)).toContain('Evinced needs a live browser page');
  });

  it('never reads a non-list return as a clean page', async () => {
    for (const issues of [null, { issues: [] }, 'none']) {
      const result = await runOne(provider({ enabled: true }, fakeEvincedModule(issues, newCalls())));
      expect(result.drafts).toEqual([]);
      expect(failureOf(result)).toContain('not a list of issues');
    }
  });

  it('makes the same failure a coverage gap once a type is promoted, since it could then hide a gating finding', async () => {
    const p = provider(
      { enabled: true },
      fakeEvincedModule([], newCalls(), { analyze: () => new Promise(() => {}) }),
      OFFLINE_ENV,
      { timeoutMs: 50, promote: new Set(['WRONG_SEMANTIC_ROLE']) },
    );
    const result = await runOne(p);
    expect(result.notes).toEqual([]);
    expect(result.gaps).toEqual([
      {
        ref: 'provider:evinced',
        state: 'not-covered',
        reason:
          'provider evinced failed: Evinced did not finish analysis within 50 ms, so it checked nothing on this screen. Check its license server and the page, or set engines.evinced.enabled to false.',
      },
    ]);
  });

  it('promotes a type only when a caller passes one, which the config cannot', async () => {
    const p = provider({ enabled: true }, fakeEvincedModule([WRONG_ROLE], newCalls()), OFFLINE_ENV, {
      promote: new Set(['WRONG_SEMANTIC_ROLE']),
    });
    expect(draftsOf(await p.run(ctxFor())).map((draft) => draft.evidenceClass)).toEqual(['deterministic', 'deterministic']);
  });

  it('is a capability-denied gap when secrets or network were not granted', async () => {
    const offline = await runOne(provider({ enabled: true }, fakeEvincedModule([], newCalls())), ['live']);
    expect(offline.gaps).toEqual([
      { ref: 'provider:evinced', state: 'capability-denied', reason: 'provider evinced denied capability: secrets' },
    ]);
    const online = await runOne(
      provider({ enabled: true, mode: 'online' }, fakeEvincedModule([], newCalls()), ONLINE_ENV),
      ['live', 'secrets'],
    );
    expect(online.gaps).toEqual([
      { ref: 'provider:evinced', state: 'capability-denied', reason: 'provider evinced denied capability: network' },
    ]);
  });

  it('turns a hung license server into a named note within the timeout', async () => {
    const calls = newCalls();
    const p = provider(
      { enabled: true, mode: 'online' },
      fakeEvincedModule([], calls, { credentials: () => new Promise(() => {}) }),
      ONLINE_ENV,
      { timeoutMs: 50 },
    );
    const started = Date.now();
    const reason = failureOf(await runOne(p));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(reason).toBe(
      `provider evinced did not run: Evinced did not finish setting its credentials within 50 ms, so it checked nothing on this screen. Check its license server and the page, or set engines.evinced.enabled to false. ${PREVIEW_SUFFIX}`,
    );
    expect(calls.analyze).toEqual([]);
  });

  it('turns a hung analysis into a named note within the timeout', async () => {
    const p = provider(
      { enabled: true },
      fakeEvincedModule([], newCalls(), { analyze: () => new Promise(() => {}) }),
      OFFLINE_ENV,
      { timeoutMs: 50 },
    );
    const reason = failureOf(await runOne(p));
    expect(reason).toContain('Evinced did not finish analysis within 50 ms');
  });
});

describe('Evinced refuses to run while its global switch could be off', () => {
  function withFiles(present: readonly string[], options: { env?: Record<string, string | undefined> } = {}) {
    const calls = newCalls();
    const p = provider({ enabled: true }, fakeEvincedModule([NOT_FOCUSABLE], calls), options.env ?? OFFLINE_ENV, {
      fileExists: async (path) => present.some((name) => path.endsWith(name)),
    });
    return { p, calls };
  }

  it('refuses when EV_SWITCH_ON is set to anything but true', async () => {
    for (const value of ['false', '0', 'off', '']) {
      const { p, calls } = withFiles([], { env: { ...OFFLINE_ENV, EV_SWITCH_ON: value } });
      const result = await runProviders([p], ctxFor(), ['live', 'secrets']);
      expect(result.drafts).toEqual([]);
      expect(failureOf(result)).toContain('EV_SWITCH_ON');
      expect(failureOf(result)).toContain('unset EV_SWITCH_ON or set it to true');
      expect(calls.analyze).toEqual([]);
    }
  });

  it('runs when EV_SWITCH_ON is true', async () => {
    const { p } = withFiles([], { env: { ...OFFLINE_ENV, EV_SWITCH_ON: 'true' } });
    const result = await runProviders([p], ctxFor(), ['live', 'secrets']);
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toHaveLength(1);
  });

  it('refuses when an evConfig file is present and not guarded', async () => {
    for (const name of ['evConfig.json', 'evConfig.yaml', 'evConfig.yml']) {
      const { p, calls } = withFiles([name]);
      const result = await runProviders([p], ctxFor(), ['live', 'secrets']);
      expect(result.drafts).toEqual([]);
      expect(failureOf(result)).toContain(name);
      expect(failureOf(result)).toContain('remove it, or add it to guardedPaths so changing it needs owner approval');
      expect(calls.analyze).toEqual([]);
    }
  });

  it('runs when the evConfig file is listed in guardedPaths', async () => {
    const { p } = withFiles(['evConfig.json']);
    const ctx = ctxFor(livePage(), testConfig({ guardedPaths: ['usabl.config.json', 'evConfig.json'] }));
    const result = await runProviders([p], ctx, ['live', 'secrets']);
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toHaveLength(1);
  });
});

describe('Evinced credentials never leave the provider', () => {
  const SECRETS = [SERVICE_ID, AUTH_TOKEN, API_KEY];
  const ALL_ENV = { ...OFFLINE_ENV, EVINCED_API_KEY: API_KEY };

  function expectNoSecret(serialized: string): void {
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret);
    }
  }

  it('redacts a credential the SDK quotes back in an error', async () => {
    const p = provider(
      { enabled: true },
      fakeEvincedModule([], newCalls(), {
        analyze: async () => {
          throw new Error(`license check failed for service ${SERVICE_ID} with token ${AUTH_TOKEN} (key ${API_KEY})`);
        },
      }),
      ALL_ENV,
    );
    const result = await runProviders([p], ctxFor(), ['live', 'secrets']);
    expect(failureOf(result)).toBe(
      `provider evinced did not run: Evinced analysis failed: license check failed for service [redacted] with token [redacted] (key [redacted]). ${PREVIEW_SUFFIX}`,
    );
    expectNoSecret(JSON.stringify(result));
  });

  it('redacts a credential echoed into issue text or a failed import', async () => {
    const echoed = {
      type: { id: `TYPE_${AUTH_TOKEN}`, name: `name ${SERVICE_ID}` },
      severity: { name: 'Critical' },
      elements: [{ selector: `#${API_KEY}` }],
      summary: `summary ${AUTH_TOKEN}`,
      description: `description ${API_KEY}`,
      knowledgeBaseLink: `https://example.test/?t=${AUTH_TOKEN}`,
    };
    const issues = await runProviders(
      [provider({ enabled: true }, fakeEvincedModule([echoed], newCalls()), ALL_ENV)],
      ctxFor(),
      ['live', 'secrets'],
    );
    expect(issues.drafts).toHaveLength(1);
    expectNoSecret(JSON.stringify(issues));

    const brokenImport = provider({ enabled: true }, async () => Promise.reject(new Error(`init read ${AUTH_TOKEN}`)), ALL_ENV);
    const loadResult = await runProviders([brokenImport], ctxFor(), ['live', 'secrets']);
    expect(failureOf(loadResult)).toContain('failed to load: init read [redacted]');
    expectNoSecret(JSON.stringify(loadResult));
  });

  it('keeps every credential out of a credential-missing message', async () => {
    const result = await runProviders(
      [provider({ enabled: true, mode: 'online' }, fakeEvincedModule([], newCalls()), { EVINCED_AUTH_TOKEN: AUTH_TOKEN })],
      ctxFor(),
      ['live', 'secrets', 'network'],
    );
    expect(failureOf(result)).toContain('EVINCED_SERVICE_ID and EVINCED_API_KEY are not set');
    expectNoSecret(JSON.stringify(result));
  });
});
