import { describe, expect, it } from 'vitest';
import {
  createLiveResolver,
  effectiveLiveValue,
  type LiveAttributes,
  type LiveResolver,
} from '../../src/providers/rulepack/live-value.js';

// The announcement capture carries createLiveResolver into the browser as its own source. That
// only works while the function closes over nothing, so its source alone has to build a resolver
// that answers exactly as the module does.
function resolverFromSource(): LiveResolver {
  return new Function(`return (${createLiveResolver.toString()})();`)() as LiveResolver;
}

const node = (ariaLive: string | null, role: string | null = null): LiveAttributes => ({ ariaLive, role });

const CHAINS: Array<[string, LiveAttributes[]]> = [
  ['empty chain', []],
  ['polite', [node('polite')]],
  ['assertive', [node('assertive')]],
  ['off', [node('off')]],
  ['uppercase token', [node('POLITE')]],
  ['unknown token', [node('banana')]],
  ['empty aria-live on status', [node('', 'status')]],
  ['alert role', [node(null, 'alert')]],
  ['log role', [node(null, 'log')]],
  ['uppercase status role', [node(null, 'STATUS')]],
  ['unknown first role token', [node(null, 'banana timer'), node('polite')]],
  ['off wrapper in polite region', [node(null), node('off'), node('polite')]],
  ['polite in off wrapper', [node('polite'), node('off')]],
  ['explicit off beats status role', [node('off', 'status'), node('polite')]],
];

describe('createLiveResolver', () => {
  it('builds a working resolver from its own source alone', () => {
    const fromSource = resolverFromSource();
    for (const [, chain] of CHAINS) {
      expect(fromSource.effectiveLiveValue(chain)).toBe(effectiveLiveValue(chain));
    }
  });

  it('names the nearest element that sets a value', () => {
    const resolver = createLiveResolver();
    expect(resolver.nearestLiveSetter([])).toBe(-1);
    expect(resolver.nearestLiveSetter([node(null), node(''), node(null, 'button')])).toBe(-1);
    expect(resolver.nearestLiveSetter([node(null), node('off'), node('polite')])).toBe(1);
    expect(resolver.nearestLiveSetter([node(null, 'timer'), node('polite')])).toBe(0);
  });

  it('resolves each chain the way WAI-ARIA defines it', () => {
    const resolved = Object.fromEntries(CHAINS.map(([name, chain]) => [name, effectiveLiveValue(chain)]));
    expect(resolved).toEqual({
      'empty chain': 'off',
      polite: 'polite',
      assertive: 'assertive',
      off: 'off',
      'uppercase token': 'off',
      'unknown token': 'off',
      'empty aria-live on status': 'polite',
      'alert role': 'assertive',
      'log role': 'polite',
      'uppercase status role': 'polite',
      'unknown first role token': 'off',
      'off wrapper in polite region': 'off',
      'polite in off wrapper': 'polite',
      'explicit off beats status role': 'off',
    });
  });
});
