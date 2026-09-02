import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/contracts/index.js';
import {
  analyzeIdentityStability,
  identityKeysForDrafts,
  type StabilityRound,
} from '../../src/measure/identity-stability.js';

function draftFor(
  screenId: string,
  rule: string,
  options: { name?: string; role?: string; elementPath?: string } = {},
): Draft {
  return {
    rule,
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath: options.elementPath ?? 'body > main:nth-child(1) > button:nth-child(2)',
    elementName: options.name ?? null,
    role: options.role ?? 'button',
    whatUserExperiences: 'Screen reader users hear nothing for this control.',
    why: 'The control has no accessible name.',
    fix: 'Give the control a visible label or aria-label.',
    evidence:
      options.name === undefined
        ? {}
        : { name: { value: options.name, source: 'ax-tree', fromTree: true } },
    confidence: 'fail',
  };
}

function roundOf(screenId: string, keys: string[]): StabilityRound {
  return [{ screenId, keys }];
}

describe('analyzeIdentityStability', () => {
  it('reports a screen as stable when every round produced the same key set', () => {
    const rounds = [
      roundOf('home', ['name:home|image-alt|name:logo', 'name:home|link-name|name:docs']),
      roundOf('home', ['name:home|link-name|name:docs', 'name:home|image-alt|name:logo']),
      roundOf('home', ['name:home|image-alt|name:logo', 'name:home|link-name|name:docs']),
    ];

    const report = analyzeIdentityStability(rounds);

    expect(report.rounds).toBe(3);
    expect(report.allScreensStable).toBe(true);
    expect(report.screens).toEqual([
      {
        screenId: 'home',
        keyCountPerRound: [2, 2, 2],
        unionSize: 2,
        unstableKeys: [],
        driftRate: 0,
        stability: 'stable',
        gaps: [],
      },
    ]);
    expect(report.note).toBe('measurement-only: no verdict minted, no receipt written, nothing gated');
  });

  it('reports a key seen in some rounds but not all as unstable, per screen', () => {
    const rounds: StabilityRound[] = [
      [
        { screenId: 'home', keys: ['a', 'b', 'c', 'd'] },
        { screenId: 'settings', keys: ['s1'] },
      ],
      [
        { screenId: 'home', keys: ['a', 'b', 'c'] },
        { screenId: 'settings', keys: ['s1'] },
      ],
    ];

    const report = analyzeIdentityStability(rounds);

    expect(report.allScreensStable).toBe(false);
    expect(report.screens.map((screen) => screen.screenId)).toEqual(['home', 'settings']);
    expect(report.screens[0]).toEqual({
      screenId: 'home',
      keyCountPerRound: [4, 3],
      unionSize: 4,
      unstableKeys: ['d'],
      driftRate: 0.25,
      stability: 'unstable',
      gaps: [],
    });
    expect(report.screens[1]?.stability).toBe('stable');
  });

  it('divides unstable keys by the union size and keeps the ratio readable', () => {
    const rounds = [roundOf('home', ['a', 'b', 'c']), roundOf('home', ['a', 'b'])];

    const report = analyzeIdentityStability(rounds);

    expect(report.screens[0]?.unionSize).toBe(3);
    expect(report.screens[0]?.unstableKeys).toEqual(['c']);
    expect(report.screens[0]?.driftRate).toBe(0.3333);
  });

  it('reports a drift rate of zero when a screen produced no keys at all', () => {
    const rounds = [roundOf('home', []), roundOf('home', [])];

    const report = analyzeIdentityStability(rounds);

    expect(report.screens[0]?.driftRate).toBe(0);
    expect(report.screens[0]?.stability).toBe('stable');
  });

  it('discloses a failed round instead of counting the screen as stable', () => {
    const rounds: StabilityRound[] = [
      [{ screenId: 'home', keys: ['a', 'b'] }],
      [{ screenId: 'home', keys: [], gap: 'screen failed to open: 302 redirect to login' }],
      [{ screenId: 'home', keys: ['a', 'b'] }],
    ];

    const report = analyzeIdentityStability(rounds);

    expect(report.allScreensStable).toBe(false);
    expect(report.screens[0]?.stability).toBe('inconclusive');
    expect(report.screens[0]?.keyCountPerRound).toEqual([2, null, 2]);
    expect(report.screens[0]?.unstableKeys).toEqual([]);
    expect(report.screens[0]?.gaps).toEqual(['round 2: screen failed to open: 302 redirect to login']);
  });

  it('still reports drift when one round failed and the others disagree', () => {
    const rounds: StabilityRound[] = [
      [{ screenId: 'home', keys: ['a', 'b'] }],
      [{ screenId: 'home', keys: [], gap: 'scan failed: timeout' }],
      [{ screenId: 'home', keys: ['a'] }],
    ];

    const report = analyzeIdentityStability(rounds);

    expect(report.screens[0]?.stability).toBe('unstable');
    expect(report.screens[0]?.unstableKeys).toEqual(['b']);
    expect(report.screens[0]?.gaps).toEqual(['round 2: scan failed: timeout']);
  });

  it('discloses a screen that a round never reported at all', () => {
    const rounds: StabilityRound[] = [
      [
        { screenId: 'home', keys: ['a'] },
        { screenId: 'settings', keys: ['s1'] },
      ],
      [{ screenId: 'home', keys: ['a'] }],
    ];

    const report = analyzeIdentityStability(rounds);

    expect(report.screens[1]).toEqual({
      screenId: 'settings',
      keyCountPerRound: [1, null],
      unionSize: 1,
      unstableKeys: [],
      driftRate: 0,
      stability: 'inconclusive',
      gaps: ['round 2: screen was not reported'],
    });
  });

  it('calls a single round inconclusive because one round cannot show drift', () => {
    const report = analyzeIdentityStability([roundOf('home', ['a', 'b'])]);

    expect(report.rounds).toBe(1);
    expect(report.allScreensStable).toBe(false);
    expect(report.screens[0]).toEqual({
      screenId: 'home',
      keyCountPerRound: [2],
      unionSize: 2,
      unstableKeys: [],
      driftRate: 0,
      stability: 'inconclusive',
      gaps: ['one round cannot show drift; run at least two'],
    });
  });

  it('returns an empty report for zero rounds', () => {
    const report = analyzeIdentityStability([]);

    expect(report.rounds).toBe(0);
    expect(report.screens).toEqual([]);
    expect(report.allScreensStable).toBe(false);
  });
});

describe('identityKeysForDrafts', () => {
  it('prefixes each key with its identity basis so a basis change is visible', () => {
    const keys = identityKeysForDrafts([
      draftFor('home', 'image-alt', { name: 'Company logo' }),
      draftFor('home', 'color-contrast', { role: 'link', elementPath: 'body > a:nth-child(3)' }),
    ]);

    expect(keys).toEqual(['name:home|image-alt|name:company-logo', 'structural:home|color-contrast|struct:link:body>a']);
  });

  it('keeps identity-weak rules countable by numbering them per screen and rule', () => {
    const keys = identityKeysForDrafts([
      draftFor('home', 'button-name'),
      draftFor('home', 'button-name'),
      draftFor('home', 'pf-icon-button-name'),
    ]);

    expect(keys).toEqual(['count:home|button-name#1', 'count:home|button-name#2', 'count:home|pf-icon-button-name#1']);
  });

  it('collapses duplicate keys so a key set stays a set', () => {
    const draft = draftFor('home', 'image-alt', { name: 'Company logo' });

    expect(identityKeysForDrafts([draft, draft])).toEqual(['name:home|image-alt|name:company-logo']);
  });
});
