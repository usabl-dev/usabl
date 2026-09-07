/**
 * A screen the browser was redirected away from was not measured, and must say so.
 *
 * The defect this locks, measured on a real login-gated application with a committed evidence
 * floor. The scan session expired. Every screen request answered with the application's own login
 * page. usabl scanned that login page once per screen, filed the results under the screen ids it
 * had asked for, recorded no coverage gap at all, and reported all twenty-nine floored barriers as
 * paid down. The run came back red only because that login page carried barriers of its own; a
 * clean one would have returned verified, with a receipt, and a claim that the debt was gone.
 *
 * Two halves are held here. The rule itself, which is pure and needs no browser, and the check
 * runner wiring, which is what decides whether a screen contributes findings at all.
 */
import { describe, expect, it } from 'vitest';
import type { Draft, Page, Provider } from '../../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../../src/deps/fakes.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { observeLanding, redirectedAwayGap, type LandingObservation } from '../../src/providers/redirected.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'users', url: 'http://app.test/users' };

function observation(over: Partial<LandingObservation> = {}): LandingObservation {
  return {
    requestedUrl: SCREEN.url,
    landedUrl: SCREEN.url,
    passwordFieldPresent: false,
    ...over,
  };
}

/**
 * A page that reports one address and answers the password probe. queryAll answers every selector
 * the same way, which is what the real check runner's other selector reads have to tolerate too.
 */
function pageAt(landedUrl: string, hasPassword: boolean): Page {
  return makeFakePage({
    currentUrl: async () => landedUrl,
    queryAll: async () => (hasPassword ? [{ selector: 'form > input:nth-child(2)' }] : []),
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

function runnerFor(page: Page, providers: Provider[] = []) {
  return makeCheckRunner({
    browser: { open: async () => page, close: async () => {} },
    providers,
    config: testConfig({ surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [] }] }),
    allowedCapabilities: ['live'],
    stepRunner: makeStepRunner(),
    transcriptTabCap: 3,
  });
}

describe('redirectedAwayGap: the rule', () => {
  it('fires when the browser landed elsewhere and that page asks for a password', () => {
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({ landedUrl: 'http://app.test/login?next=%2Fusers', passwordFieldPresent: true }),
    );
    expect(gap).not.toBeNull();
    expect(gap?.state).toBe('not-covered');
    expect(gap?.ref).toBe(SCREEN.url);
  });

  it('does not fire on a different address with no password field', () => {
    // An ordinary redirect that still lands on a real screen: a canonical path, a locale prefix,
    // a marketing parameter. Nothing here says the screen was missed, so it is scanned normally.
    expect(
      redirectedAwayGap(SCREEN.id, observation({ landedUrl: 'http://app.test/en/users' })),
    ).toBeNull();
  });

  it('does not fire on the same address even when a password field is on it', () => {
    // The sign-in screen an operator listed as a surface on purpose. It is a real screen with a
    // real password field, and it must be measured like any other.
    expect(
      redirectedAwayGap('sign-in', {
        requestedUrl: 'http://app.test/login',
        landedUrl: 'http://app.test/login',
        passwordFieldPresent: true,
      }),
    ).toBeNull();
  });

  it('treats a trailing slash, a default port, and host case as the same screen', () => {
    for (const landed of [
      'http://app.test/users/',
      'http://app.test:80/users',
      'http://APP.TEST/users',
    ]) {
      expect(
        redirectedAwayGap(SCREEN.id, observation({ landedUrl: landed, passwordFieldPresent: true })),
      ).toBeNull();
    }
  });

  it('ignores an added query string, because a login redirect and a real login screen both add one', () => {
    expect(
      redirectedAwayGap(SCREEN.id, {
        requestedUrl: 'http://app.test/users',
        landedUrl: 'http://app.test/users?tab=active',
        passwordFieldPresent: true,
      }),
    ).toBeNull();
  });

  it('compares the fragment, so a hash router redirected to its login route is caught', () => {
    const gap = redirectedAwayGap('users', {
      requestedUrl: 'http://app.test/#/users',
      landedUrl: 'http://app.test/#/login',
      passwordFieldPresent: true,
    });
    expect(gap).not.toBeNull();
  });

  it('fires on a cross-origin redirect to an identity provider that asks for a password', () => {
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({ landedUrl: 'https://sso.example.com/auth', passwordFieldPresent: true }),
    );
    expect(gap?.reason).toContain('https://sso.example.com/auth');
  });

  it('makes no claim when the page could not report where it is', () => {
    // Absence of evidence. Raising a gap here would drop a real screen's findings over a browser
    // read that failed, so the honest answer is no claim.
    expect(
      redirectedAwayGap(SCREEN.id, observation({ landedUrl: null, passwordFieldPresent: true })),
    ).toBeNull();
  });

  it('never puts the landing query string or fragment in the reason, because either can carry a token', () => {
    const gap = redirectedAwayGap(SCREEN.id, {
      requestedUrl: 'http://app.test/users',
      landedUrl: 'https://sso.example.com/authorize?code=SUPERSECRETCODE&state=abc#access_token=SUPERSECRETTOKEN',
      passwordFieldPresent: true,
    });
    expect(gap?.reason).toContain('https://sso.example.com/authorize');
    expect(gap?.reason).not.toContain('SUPERSECRETCODE');
    expect(gap?.reason).not.toContain('SUPERSECRETTOKEN');
    expect(gap?.reason).not.toContain('code=');
    expect(gap?.reason).not.toContain('access_token');
  });

  it('names where the browser landed and says the screen was not measured', () => {
    const gap = redirectedAwayGap(
      SCREEN.id,
      observation({ landedUrl: 'http://app.test/login', passwordFieldPresent: true }),
    );
    expect(gap?.reason).toContain('redirected away');
    expect(gap?.reason).toContain('http://app.test/login');
    expect(gap?.reason).toContain('did not measure users');
    expect(gap?.reason).toContain('USABL_STORAGE_STATE');
  });
});

describe('observeLanding: reading the two facts off a live page', () => {
  it('reads the address and the password field', async () => {
    await expect(observeLanding(pageAt('http://app.test/login', true), SCREEN.url)).resolves.toEqual({
      requestedUrl: SCREEN.url,
      landedUrl: 'http://app.test/login',
      passwordFieldPresent: true,
    });
  });

  it('reads a failing address read and a throwing query as no claim, never as a redirect', async () => {
    const broken = makeFakePage({
      currentUrl: async () => {
        throw new Error('page is gone');
      },
      queryAll: async () => {
        throw new Error('invalid selector');
      },
    });
    await expect(observeLanding(broken, SCREEN.url)).resolves.toEqual({
      requestedUrl: SCREEN.url,
      landedUrl: null,
      passwordFieldPresent: false,
    });
  });

  it('reads an empty address as no claim', async () => {
    const blank = await makeFakeDeps().browser.open('');
    await expect(observeLanding(blank, SCREEN.url)).resolves.toMatchObject({ landedUrl: null });
  });
});

describe('the check runner refuses to measure a screen it was redirected away from', () => {
  const loudProvider: Provider = {
    id: 'loud',
    layer: 'fake',
    capabilities: ['live'],
    run: async (): Promise<Draft[]> => [makeDraft('label')],
  };

  it('discloses a gap, contributes no drafts, and records no keyboard walk', async () => {
    const scan = await runnerFor(pageAt('http://app.test/login', true), [loudProvider]).scan(SCREEN);

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({ ref: SCREEN.url, state: 'not-covered' });
    expect(scan.gaps[0]?.reason).toContain('redirected away');
    expect(scan.drafts).toEqual([]);
    // The four-stop keyboard transcript from a login page was the loudest wrong number in the
    // real run. It is never collected now, so nothing downstream can read it as this screen's
    // focus order.
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
    expect(scan.reachedSelectorPresent).toBeNull();
  });

  it('scans a screen normally when a redirect still lands on it', async () => {
    // The false positive this must not have. The application answered with a redirect, and the
    // redirect ended on the screen that was asked for, so there is nothing to disclose.
    const scan = await runnerFor(pageAt('http://app.test/users/', false), [loudProvider]).scan(SCREEN);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
    expect(scan.stops.length).toBeGreaterThan(0);
  });

  it('scans a login screen normally when the login screen is what was asked for', async () => {
    const signIn = { id: 'sign-in', url: 'http://app.test/login' };
    const runner = makeCheckRunner({
      browser: { open: async () => pageAt('http://app.test/login', true), close: async () => {} },
      providers: [loudProvider],
      config: testConfig({ surfaces: [{ id: signIn.id, url: signIn.url, files: [] }] }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 3,
    });

    const scan = await runner.scan(signIn);

    expect(scan.gaps).toEqual([]);
    expect(scan.drafts).toHaveLength(1);
  });
});
