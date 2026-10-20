import { describe, expect, it } from 'vitest';
import type { RequirementBundle } from '../../src/contracts/index.js';
import { KEYBOARD_WALL_CLOCK_MS, makeCoreProviders, makeScanProviders } from '../../src/providers/core-stack.js';

describe('makeCoreProviders', () => {
  it('wires the same core provider ids that buildDeps starts from', () => {
    // Intake providers append after this list in makeScanProviders. A silent rewrite of checkPage that
    // dropped docs-rulepack or the keyboard walk would reintroduce surface/engine drift.
    expect(makeCoreProviders().map((provider) => provider.id)).toEqual([
      'axe-core',
      'pf-rulepack',
      'docs-rulepack',
      'keyboard-walk',
    ]);
  });

  it('omits the keyboard walk when the caller opts out', () => {
    expect(makeCoreProviders({ keyboardWalk: false }).map((provider) => provider.id)).toEqual([
      'axe-core',
      'pf-rulepack',
      'docs-rulepack',
    ]);
  });

  it('exports the shared keyboard wall-clock budget', () => {
    expect(KEYBOARD_WALL_CLOCK_MS).toBe(15_000);
  });
});

describe('makeScanProviders', () => {
  const bundle: RequirementBundle = {
    version: 1,
    requirements: [
      {
        id: 'clusters-heading',
        kind: 'content',
        surface: 'clusters',
        description: 'heading',
        assertion: { type: 'content', selector: 'h1', expectedText: 'Clusters' },
        approved: true,
      },
      {
        id: 'alt-manifest',
        kind: 'doc',
        surface: 'clusters',
        description: 'manifest',
        assertion: { type: 'doc', artifact: 'alt-text-manifest' },
        approved: true,
      },
    ],
  };

  it('appends one provider per runtime requirement after the core stack', () => {
    // buildDeps and checkPage both build their list here, so this is the list each of them runs.
    expect(makeScanProviders(bundle).map((provider) => provider.id)).toEqual([
      'axe-core',
      'pf-rulepack',
      'docs-rulepack',
      'keyboard-walk',
      'intake:clusters-heading',
    ]);
  });

  it('builds only the core stack when the requirements could not be loaded', () => {
    expect(makeScanProviders(null, { keyboardWalk: false }).map((provider) => provider.id)).toEqual([
      'axe-core',
      'pf-rulepack',
      'docs-rulepack',
    ]);
  });
});
