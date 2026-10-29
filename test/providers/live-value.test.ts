import { describe, expect, it } from 'vitest';
import {
  createLiveResolver,
  effectiveLiveValue,
  type HiddenAttributes,
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

describe('hiddenInChain', () => {
  const shown = (ariaHidden: string | null = null): HiddenAttributes => ({ ariaHidden, inert: false, hidden: false });

  // Chromium 151 leaves an element out of the accessibility tree for every non-empty aria-hidden
  // value except "false" and "undefined" in any ASCII case. A value with spaces around "false"
  // still hides. The rule has to hide at least as much as the browser does.
  it('hides content the way Chromium reads aria-hidden', () => {
    const resolver = createLiveResolver();
    const hiddenBy = (value: string): boolean => resolver.hiddenInChain([shown(value)]);
    expect(['true', 'TRUE', 'banana', '0', ' ', ' false', 'false '].map(hiddenBy)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(['', 'false', 'FALSE', 'undefined', 'UNDEFINED'].map(hiddenBy)).toEqual([false, false, false, false, false]);
  });

  it('hides content when any element in the chain hides its subtree', () => {
    const resolver = createLiveResolver();
    expect(resolver.hiddenInChain([])).toBe(false);
    expect(resolver.hiddenInChain([shown(), shown('false'), shown()])).toBe(false);
    expect(resolver.hiddenInChain([shown(), shown('true')])).toBe(true);
    // aria-hidden="false" does not bring back content an ancestor hides.
    expect(resolver.hiddenInChain([shown('false'), shown('true')])).toBe(true);
    expect(resolver.hiddenInChain([shown(), { ariaHidden: null, inert: true, hidden: false }])).toBe(true);
    expect(resolver.hiddenInChain([{ ariaHidden: null, inert: false, hidden: true }, shown()])).toBe(true);
  });

  it('answers the same from its own source alone', () => {
    const fromSource = resolverFromSource();
    for (const chain of [[], [shown('true')], [shown('false')], [shown(), { ariaHidden: null, inert: true, hidden: false }]]) {
      expect(fromSource.hiddenInChain(chain)).toBe(createLiveResolver().hiddenInChain(chain));
    }
  });
});
