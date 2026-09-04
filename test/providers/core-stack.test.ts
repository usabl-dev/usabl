import { describe, expect, it } from 'vitest';
import { KEYBOARD_WALL_CLOCK_MS, makeCoreProviders } from '../../src/providers/core-stack.js';

describe('makeCoreProviders', () => {
  it('wires the same core provider ids that buildDeps starts from', () => {
    // Intake providers append after this list in buildDeps. A silent rewrite of checkPage that
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
