/**
 * The whole chain, from a page that is not the signed-in screen to the verdict and the pay-down
 * count, with the real check runner and the real rules in the path.
 *
 * The false claim this locks. On a real login-gated application whose scan session had expired,
 * every screen request answered with the application's sign-in experience. usabl scanned that
 * under the requested screen's id, disclosed nothing, and reported all twenty-nine barriers on
 * the committed evidence floor as paid down. The verdict was red only because that page happened
 * to carry barriers of its own. A clean one would have produced verified, with a receipt, and a
 * claim that the accepted debt was gone. That is the false green this product exists to prevent,
 * so the pay-down claim is proved here rather than assumed from the gate's unit tests.
 *
 * Every run below shares one config, one floor, one set of changed files, and one provider. The
 * only thing that varies is what the page reports about itself. The signed-in run confirms the
 * barrier is paid down. The others confirm nothing at all.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import type { Deps, Draft, Page, Provider, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';

const SCREEN_URL = 'http://app.test/users';

const config: UsablConfig = {
  appBaseUrl: 'http://app.test',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'users', url: SCREEN_URL, files: ['fixtures/app/src/UsersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

// Version 2 so the name-basis entry carries a real observed count and the run does not raise the
// stale-floor coverage gap, which would make every case here not_covered for an unrelated reason.
const FLOOR = JSON.stringify({
  version: 2,
  entries: [
    {
      screenId: 'users',
      layer: 'axe',
      rule: 'color-contrast',
      elementKey: 'users|color-contrast|name:save',
      identityBasis: 'name',
      count: 1,
    },
  ],
});

const POLICY_FILES = { 'usabl.config.json': '{}', '.usabl-evidence.json': FLOOR };

// A barrier on the login page, so the redirected run has something it could wrongly report as a
// finding about the users screen. In the real incident this was a missing level one heading.
const loginPageDraft: Draft = {
  rule: 'page-has-heading-one',
  layer: 'axe',
  severity: 'moderate',
  evidenceClass: 'deterministic',
  screenId: 'users',
  elementPath: 'html',
  elementName: null,
  role: null,
  whatUserExperiences: 'The page has no level one heading',
  why: 'Screen reader users cannot tell what the page is',
  fix: 'Add a level one heading that names the page',
  evidence: {},
  confidence: 'fail',
};

const noisyProvider: Provider = {
  id: 'noisy',
  layer: 'axe',
  capabilities: ['live'],
  run: async (): Promise<Draft[]> => [loginPageDraft],
};

interface PageSpec {
  landedUrl?: string;
  hasPassword?: boolean;
  unauthorized?: string[];
}

function pageWith(spec: PageSpec = {}): Page {
  return makeFakePage({
    currentUrl: async () => spec.landedUrl ?? SCREEN_URL,
    countEverywhere: async () => (spec.hasPassword === true ? 1 : 0),
    unauthorizedApiRequests: async () => spec.unauthorized ?? [],
    // A real focusable stop, so the body-only unseen detector has nothing to say. Without it every
    // case here would be unseen for that separate reason and would prove nothing about sessions.
    activePath: async () => 'html > body > main > button#save',
  });
}

/**
 * Fake git and filesystem, real check runner, fake browser standing on a chosen page. The rules
 * under test are the real ones, so this run exercises the same code the CLI does.
 */
function depsFor(spec: PageSpec, options: { sessionConfigured: boolean; providers?: Provider[] }): Deps {
  const base = makeFakeDeps({
    files: POLICY_FILES,
    headContents: POLICY_FILES,
    writeTree: 'tree-session',
    changed: [{ code: 'M', path: 'fixtures/app/src/UsersPage.tsx' }],
  });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: { open: async () => pageWith(spec), close: async () => {} },
      providers: options.providers ?? [noisyProvider],
      config,
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 3,
      sessionConfigured: options.sessionConfigured,
    }),
  };
}

describe('a screen this run did not reach signed in', () => {
  it('is a coverage gap that contributes no findings and pays down no floor entry', async () => {
    // The real application shape. The browser never left the requested address and no password
    // field had rendered yet; the only evidence is that the page's own API calls came back 401.
    const r = await run(
      depsFor({ landedUrl: SCREEN_URL, unauthorized: ['http://app.test/api/v2/me'] }, { sessionConfigured: true }),
      config,
    );

    // Disclosed, and the disclosure names a refused request.
    const gaps = r.coverage.gaps.filter((gap) => gap.reason.includes('401'));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.ref).toBe(SCREEN_URL);
    expect(gaps[0]?.state).toBe('not-covered');
    expect(gaps[0]?.reason).toContain('http://app.test/api/v2/me');

    // The sign-in page's own barrier is not reported as a barrier on the users screen.
    expect(r.findings.filter((f) => f.status === 'new')).toEqual([]);
    expect(r.findings.some((f) => f.rule === 'page-has-heading-one')).toBe(false);

    // The claim that broke trust. The floored barrier on users was not observed this run, but
    // nobody measured users, so nothing may be marked fixed and nothing may be counted paid down.
    expect(r.findings.filter((f) => f.status === 'fixed')).toEqual([]);
    expect(r.paidDownCount).toBe(0);

    // Not covered, never verified, and no receipt to carry the claim anywhere else.
    expect(r.verdict).toBe('not_covered');
    expect(r.accessibilityVerdict).toBe('not_covered');
    expect(r.exitCode).toBe(3);
    expect(r.receipt).toBeNull();
  });

  it('never reports verified with paid down entries, whatever the sign-in page contains', async () => {
    // The worst shape before this change: a page with no barrier of its own, so no new finding,
    // no gap, and therefore verified with a receipt and every floored barrier claimed resolved.
    const r = await run(
      depsFor(
        { landedUrl: SCREEN_URL, unauthorized: ['http://app.test/api/v2/me'] },
        { sessionConfigured: true, providers: [] },
      ),
      config,
    );

    expect(r.verdict).not.toBe('verified');
    expect(r.verdict).toBe('not_covered');
    expect(r.receipt).toBeNull();
    expect(r.paidDownCount).toBe(0);
  });

  it('is a gap when a password field is present at the requested address', async () => {
    const r = await run(depsFor({ hasPassword: true }, { sessionConfigured: true }), config);

    expect(r.coverage.gaps.some((gap) => gap.reason.includes('asks for a password'))).toBe(true);
    expect(r.paidDownCount).toBe(0);
    expect(r.verdict).toBe('not_covered');
  });

  it('is a gap when the browser was redirected to a sign-in page with no session configured', async () => {
    const r = await run(
      depsFor({ landedUrl: 'http://app.test/login?next=%2Fusers', hasPassword: true }, { sessionConfigured: false }),
      config,
    );

    const gaps = r.coverage.gaps.filter((gap) => gap.reason.includes('redirected away'));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('http://app.test/login');
    expect(gaps[0]?.reason).not.toContain('next=');
    expect(r.paidDownCount).toBe(0);
    expect(r.verdict).toBe('not_covered');
  });

  it('the same run with a working session does confirm the pay-down', async () => {
    // The control. Only what the page reports changes: same config, same floor, same provider.
    // This is what proves the gap is what stopped the pay-down claim, rather than some other
    // property of the fixture.
    const r = await run(depsFor({}, { sessionConfigured: true }), config);

    expect(r.coverage.gaps).toEqual([]);
    const fixed = r.findings.filter((f) => f.status === 'fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.screenId).toBe('users');
    expect(r.paidDownCount).toBe(1);
  });

  it('is scanned normally when a redirect lands on the screen that was asked for', async () => {
    // The false positive this must not have: an application that answers with a redirect to the
    // canonical address of the same screen. It was measured, so its findings stand.
    const r = await run(depsFor({ landedUrl: 'http://app.test/users/' }, { sessionConfigured: true }), config);

    expect(r.coverage.gaps).toEqual([]);
    expect(r.findings.some((f) => f.rule === 'page-has-heading-one')).toBe(true);
  });
});
