/**
 * A screen this run did not reach signed in was not measured, and must say so.
 *
 * The defect this locks, measured on a real login-gated application with a committed evidence
 * floor. The scan session expired. usabl scanned whatever came back under the requested screen
 * ids, recorded no coverage gap at all, and reported all twenty-nine floored barriers as paid
 * down. The run came back red only because that page carried barriers of its own; a clean one
 * would have returned verified, with a receipt, and a claim that the debt was gone.
 *
 * What that application actually does, which is why the address is not enough. The browser never
 * leaves the requested URL. The single page application renders a blank shell for over five
 * seconds and then swaps a login form in at the same address, so a scan that settles mid
 * transition sees a partial page with no password field yet. The decisive signal is on the
 * network and it is there from the first moment: the page's own API calls to identity endpoints
 * answer 401. The same screen with a working session makes nine API calls, all 200, no 401.
 *
 * Three rules are held here, each with the case that must fire and the case that must not.
 */
import { describe, expect, it } from 'vitest';
import type { Draft, Page, Provider } from '../../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../../src/deps/fakes.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import {
  observeLanding,
  redirectedAwayGap,
  sanitizeUrlForDisplay,
  type LandingObservation,
} from '../../src/providers/redirected.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'users', url: 'http://app.test/users' };

function observation(over: Partial<LandingObservation> = {}): LandingObservation {
  return {
    requestedUrl: SCREEN.url,
    landedUrl: SCREEN.url,
    passwordFieldPresent: false,
    unauthorizedApiUrls: [],
    sessionConfigured: true,
    ...over,
  };
}

interface PageSpec {
  landedUrl?: string;
  passwordFields?: number;
  unauthorized?: string[];
}

function pageWith(spec: PageSpec = {}): Page {
  return makeFakePage({
    currentUrl: async () => spec.landedUrl ?? SCREEN.url,
    countEverywhere: async () => spec.passwordFields ?? 0,
    unauthorizedApiRequests: async () => spec.unauthorized ?? [],
    // A real focusable stop, so the separate body-only unseen detector has nothing to say about
    // any screen these tests scan.
    activePath: async () => 'html > body > main > button#save',
  });
}

function makeDraft(rule: string): Draft {
  return {
    rule,
    layer: 'fake',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: SCREEN.id,
    elementPath: 'input',
    elementName: 'Password',
    role: 'textbox',
    whatUserExperiences: 'A field has no accessible name',
    why: 'Assistive technology users hear an unlabeled control',
    fix: 'Add an accessible name to the field',
    evidence: {},
    confidence: 'fail',
  };
}

const loudProvider: Provider = {
  id: 'loud',
  layer: 'fake',
  capabilities: ['live'],
  run: async (): Promise<Draft[]> => [makeDraft('label')],
};

function runnerFor(
  page: Page,
  options: { sessionConfigured: boolean; screen?: { id: string; url: string }; providers?: Provider[] },
) {
  const screen = options.screen ?? SCREEN;
  return makeCheckRunner({
    browser: { open: async () => page, close: async () => {} },
    providers: options.providers ?? [loudProvider],
    config: testConfig({ surfaces: [{ id: screen.id, url: screen.url, files: [] }] }),
    allowedCapabilities: ['live'],
    stepRunner: makeStepRunner(),
    transcriptTabCap: 3,
    sessionConfigured: options.sessionConfigured,
  });
}

describe('rule A: the page\'s own data requests were refused as unauthenticated', () => {
  it('fires on a 401 even though the address never changed and no password field rendered yet', () => {
    // The real application, exactly. Same URL, blank shell, no password input yet, and three
    // identity calls already refused. Rules B and C are both blind here.
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({
        landedUrl: SCREEN.url,
        passwordFieldPresent: false,
        unauthorizedApiUrls: [
          'http://app.test/api/v2/me',
          'http://app.test/api/v2/config',
          'http://app.test/api/v2/organizations',
        ],
      }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('401');
    expect(gap?.reason).toContain('3 of the page');
    expect(gap?.reason).toContain('http://app.test/api/v2/me');
    expect(gap?.reason).toContain('did not measure users');
  });

  it('does not fire when no session was configured, because a signed-out visitor meets 401s', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, unauthorizedApiUrls: ['http://app.test/api/me'] }),
      ),
    ).toBeNull();
  });

  it('does not fire when nothing was refused', () => {
    expect(redirectedAwayGap(SCREEN.id, observation({ unauthorizedApiUrls: [] }))).toBeNull();
  });
});

describe('rule B: a password field anywhere, with a session configured', () => {
  it('fires at the requested address, which rule C alone would miss', () => {
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({ landedUrl: SCREEN.url, passwordFieldPresent: true }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.reason).toContain('asks for a password');
    expect(gap?.reason).toContain('did not measure users');
  });

  it('does not fire without a configured session, so a deliberate signed-out scan still runs', () => {
    // No assertion was made that this run is signed in, so meeting a login form is not evidence
    // that anything failed. Rule C still covers the wrong-page case below.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, landedUrl: SCREEN.url, passwordFieldPresent: true }),
      ),
    ).toBeNull();
  });
});

describe('rule C: redirected to a page that asks for a password', () => {
  it('fires with no session configured, because it is still the wrong page', () => {
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({
        sessionConfigured: false,
        landedUrl: 'http://app.test/login?next=%2Fusers',
        passwordFieldPresent: true,
      }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.reason).toContain('redirected away');
    expect(gap?.reason).toContain('http://app.test/login');
  });

  it('does not fire on a different address with no password field', () => {
    // An ordinary redirect that still lands on a real screen: a canonical path, a locale prefix,
    // a marketing parameter. Nothing here says the screen was missed.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, landedUrl: 'http://app.test/en/users' }),
      ),
    ).toBeNull();
  });

  it('does not fire on the same address even when a password field is on it', () => {
    // The sign-in screen an operator listed as a surface on purpose, scanned with no session.
    expect(
      redirectedAwayGap('sign-in', {
        requestedUrl: 'http://app.test/login',
        landedUrl: 'http://app.test/login',
        passwordFieldPresent: true,
        unauthorizedApiUrls: [],
        sessionConfigured: false,
      }),
    ).toBeNull();
  });

  it('treats a trailing slash, a default port, and host case as the same screen', () => {
    for (const landed of ['http://app.test/users/', 'http://app.test:80/users', 'http://APP.TEST/users']) {
      expect(
        redirectedAwayGap(
          SCREEN.id,
          observation({ sessionConfigured: false, landedUrl: landed, passwordFieldPresent: true }),
        ),
      ).toBeNull();
    }
  });

  it('ignores an added query string, because a login redirect and a real login screen both add one', () => {
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({
          sessionConfigured: false,
          landedUrl: 'http://app.test/users?tab=active',
          passwordFieldPresent: true,
        }),
      ),
    ).toBeNull();
  });

  it('compares the fragment, so a hash router redirected to its login route is caught', () => {
    expect(
      redirectedAwayGap('users', {
        requestedUrl: 'http://app.test/#/users',
        landedUrl: 'http://app.test/#/login',
        passwordFieldPresent: true,
        unauthorizedApiUrls: [],
        sessionConfigured: false,
      }),
    ).not.toBeNull();
  });

  it('makes no claim when the page could not report where it is', () => {
    // Absence of evidence. Raising a gap here would drop a real screen's findings over a browser
    // read that failed, so the honest answer is no claim.
    expect(
      redirectedAwayGap(
        SCREEN.id,
        observation({ sessionConfigured: false, landedUrl: null, passwordFieldPresent: true }),
      ),
    ).toBeNull();
  });
});

describe('no address in a gap reason ever carries a credential', () => {
  // Three parts of a URL can hold one and all three are removed: the userinfo carries HTTP basic
  // credentials, the query carries return addresses and authorization codes, the fragment carries
  // a live access token in the OAuth implicit flow. Both the requested and the landing address are
  // sanitized, because an operator can put a preview token in a configured surface URL too.
  const SECRETS = ['s3cr3t-basic', 'SUPERSECRETCODE', 'SUPERSECRETTOKEN', 'REQUESTEDSECRET'];

  function expectNoSecrets(text: string | undefined): void {
    expect(text).toBeDefined();
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('@app.test');
    expect(text).not.toContain('code=');
    expect(text).not.toContain('access_token');
  }

  const dirtyRequested = 'http://admin:s3cr3t-basic@app.test/users?preview=REQUESTEDSECRET#t=REQUESTEDSECRET';
  const dirtyLanding =
    'https://user:s3cr3t-basic@sso.example.com/authorize?code=SUPERSECRETCODE#access_token=SUPERSECRETTOKEN';

  it('strips userinfo, query, and fragment from both addresses under rule C', () => {
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      landedUrl: dirtyLanding,
      passwordFieldPresent: true,
      unauthorizedApiUrls: [],
      sessionConfigured: false,
    });
    expect(gap?.reason).toContain('http://app.test/users');
    expect(gap?.reason).toContain('https://sso.example.com/authorize');
    expectNoSecrets(gap?.reason);
  });

  it('strips userinfo, query, and fragment from the requested address and the refused one under rule A', () => {
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      landedUrl: dirtyRequested,
      passwordFieldPresent: false,
      unauthorizedApiUrls: ['https://svc:s3cr3t-basic@app.test/api/me?token=SUPERSECRETTOKEN#x=SUPERSECRETCODE'],
      sessionConfigured: true,
    });
    expect(gap?.reason).toContain('https://app.test/api/me');
    expectNoSecrets(gap?.reason);
  });

  it('strips userinfo, query, and fragment from the requested address under rule B', () => {
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      landedUrl: dirtyRequested,
      passwordFieldPresent: true,
      unauthorizedApiUrls: [],
      sessionConfigured: true,
    });
    expect(gap?.reason).toContain('http://app.test/users');
    expectNoSecrets(gap?.reason);
  });

  it('leaves gap.ref as the configured surface URL, which the overlay matches on exactly', () => {
    // Not sanitized on purpose. Every gap in a result refs the operator's own configured value,
    // and the overlay attributes a gap to a screen by comparing this to the scan target, so a
    // rewritten ref would silently orphan the gap. The reason above is where the safe form goes.
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: dirtyRequested,
      landedUrl: dirtyLanding,
      passwordFieldPresent: true,
      unauthorizedApiUrls: [],
      sessionConfigured: false,
    });
    expect(gap?.ref).toBe(dirtyRequested);
  });

  it('sanitizeUrlForDisplay keeps scheme, host, port, and path and drops everything else', () => {
    expect(sanitizeUrlForDisplay('https://u:p@host.test:8443/a/b?q=1#f')).toBe('https://host.test:8443/a/b');
    expect(sanitizeUrlForDisplay('http://host.test')).toBe('http://host.test/');
    expect(sanitizeUrlForDisplay('not a url')).toBe('an address usabl could not parse');
  });
});

describe('observeLanding: reading the facts off a live page', () => {
  it('reads the address, the password count, and the refused requests', async () => {
    await expect(
      observeLanding(
        pageWith({ landedUrl: 'http://app.test/login', passwordFields: 1, unauthorized: ['http://app.test/api/me'] }),
        SCREEN.url,
        true,
      ),
    ).resolves.toEqual({
      requestedUrl: SCREEN.url,
      landedUrl: 'http://app.test/login',
      passwordFieldPresent: true,
      unauthorizedApiUrls: ['http://app.test/api/me'],
      sessionConfigured: true,
    });
  });

  it('reads every failing probe as no claim, never as a not-reached screen', async () => {
    const broken = makeFakePage({
      currentUrl: async () => {
        throw new Error('page is gone');
      },
      countEverywhere: async () => {
        throw new Error('invalid selector');
      },
      unauthorizedApiRequests: async () => {
        throw new Error('no record');
      },
    });
    await expect(observeLanding(broken, SCREEN.url, true)).resolves.toEqual({
      requestedUrl: SCREEN.url,
      landedUrl: null,
      passwordFieldPresent: false,
      unauthorizedApiUrls: [],
      sessionConfigured: true,
    });
  });

  it('reads an empty address as no claim', async () => {
    const blank = await makeFakeDeps().browser.open('');
    await expect(observeLanding(blank, SCREEN.url, true)).resolves.toMatchObject({ landedUrl: null });
  });
});

describe('the check runner refuses to measure a screen it did not reach signed in', () => {
  it('discloses a 401 gap, contributes no drafts, and records no keyboard walk', async () => {
    const scan = await runnerFor(pageWith({ unauthorized: ['http://app.test/api/v2/me'] }), {
      sessionConfigured: true,
    }).scan(SCREEN);

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({ ref: SCREEN.url, state: 'not-covered' });
    expect(scan.gaps[0]?.reason).toContain('401');
    expect(scan.drafts).toEqual([]);
    // The four-stop keyboard transcript from a login page was the loudest wrong number in the
    // real run. It is never collected now, so nothing downstream can read it as this screen's
    // focus order.
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
    expect(scan.reachedSelectorPresent).toBeNull();
  });

  it('discloses a password-field gap at the requested address when a session was configured', async () => {
    const scan = await runnerFor(pageWith({ passwordFields: 1 }), { sessionConfigured: true }).scan(SCREEN);

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]?.reason).toContain('asks for a password');
    expect(scan.drafts).toEqual([]);
  });

  it('scans the same page normally when no session was configured', async () => {
    // The signed-out scan an operator asked for. The same page, the same 401s, the same password
    // field, and no assertion that any of it should have been different.
    const scan = await runnerFor(
      pageWith({ passwordFields: 1, unauthorized: ['http://app.test/api/v2/me'] }),
      { sessionConfigured: false },
    ).scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
    expect(scan.stops.length).toBeGreaterThan(0);
  });

  it('scans a screen normally when a signed-in load is clean', async () => {
    const scan = await runnerFor(pageWith({ landedUrl: 'http://app.test/users/' }), {
      sessionConfigured: true,
    }).scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
    expect(scan.stops.length).toBeGreaterThan(0);
  });

  it('defaults to no configured session when the caller does not say', async () => {
    // Absent means "nobody asserted this run is signed in", which is the honest reading for a
    // caller that never had a session. Rules A and B stay silent; rule C still applies.
    const runner = makeCheckRunner({
      browser: {
        open: async () => pageWith({ passwordFields: 1, unauthorized: ['http://app.test/api/me'] }),
        close: async () => {},
      },
      providers: [loudProvider],
      config: testConfig({ surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [] }] }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 3,
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
  });
});
