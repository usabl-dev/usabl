/**
 * How long an application takes to render is a property of the application, not of the engine,
 * so the readiness budget is operator config. A bad value has to be refused while parsing, which
 * is before the run builds deps or opens a browser.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/cli.js';
import { configUrlWarnings, parseSignalTimeoutMs, parseUsablConfig } from '../../src/intake/config.js';
import { UNTRUSTED_FRAME_END } from '../../src/surfaces/scrub.js';
import { describeSurfaceIdProblem } from '../../src/intake/surface-ids.js';
import { screenIdFromUrl } from '../../src/coverage/router-parse.js';

const BASE = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'overview', url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

function configJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BASE, ...extra });
}

describe('parseUsablConfig readyTimeoutMs', () => {
  it('reads the operator budget', () => {
    expect(parseUsablConfig(configJson({ readyTimeoutMs: 90_000 })).readyTimeoutMs).toBe(90_000);
  });

  it('leaves the budget unset when the operator does not name one', () => {
    expect(parseUsablConfig(configJson()).readyTimeoutMs).toBeUndefined();
  });

  it('refuses a budget that is not a positive whole number of milliseconds', () => {
    for (const bad of [0, -1, 1.5, '30000', null, Number.NaN]) {
      expect(() => parseUsablConfig(configJson({ readyTimeoutMs: bad }))).toThrow(/readyTimeoutMs/);
    }
  });
});

describe('parseUsablConfig signalTimeoutMs', () => {
  it('reads the operator cap', () => {
    expect(parseUsablConfig(configJson({ signalTimeoutMs: 30_000 })).signalTimeoutMs).toBe(30_000);
  });

  it('leaves the cap unset when the operator does not name one', () => {
    expect(parseUsablConfig(configJson()).signalTimeoutMs).toBeUndefined();
  });

  it('refuses a cap that is not a positive whole number of milliseconds', () => {
    for (const bad of [0, -1, 1.5, '15000', null, Number.NaN]) {
      expect(() => parseUsablConfig(configJson({ signalTimeoutMs: bad }))).toThrow(/signalTimeoutMs/);
    }
  });
});

describe('parseSignalTimeoutMs', () => {
  // Called directly, because a JSON round trip turns NaN and Infinity into null and never tests them.
  it('refuses NaN, Infinity, an unsafe integer, and anything above ten minutes', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 600_001]) {
      expect(() => parseSignalTimeoutMs(bad)).toThrow(/signalTimeoutMs/);
    }
  });

  it('names the field and the limit and never echoes the value', () => {
    expect(() => parseSignalTimeoutMs(600_001)).toThrow(/at most 600000/);
    try {
      parseSignalTimeoutMs(600_001);
    } catch (err) {
      expect(String(err)).not.toContain('600001');
    }
  });

  it('accepts the limit itself', () => {
    expect(parseSignalTimeoutMs(600_000)).toBe(600_000);
  });

  it('refuses a huge number in the raw config text', () => {
    const text = configJson().replace(/}\s*$/, ', "signalTimeoutMs": 1e100}');
    expect(() => parseUsablConfig(text)).toThrow(/signalTimeoutMs/);
    const longer = configJson().replace(/}\s*$/, ', "signalTimeoutMs": 123456789012345678901234567890}');
    expect(() => parseUsablConfig(longer)).toThrow(/signalTimeoutMs/);
  });
});

describe('parseUsablConfig surface reachedWhen', () => {
  it('reads an optional reachedWhen selector on a surface', () => {
    const config = parseUsablConfig(
      configJson({
        surfaces: [
          { id: 'overview', url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'], reachedWhen: 'main#root' },
        ],
      }),
    );
    expect(config.surfaces[0]?.reachedWhen).toBe('main#root');
  });

  it('leaves reachedWhen unset when the surface omits it', () => {
    expect(parseUsablConfig(configJson()).surfaces[0]?.reachedWhen).toBeUndefined();
  });

  it('refuses an empty or whitespace-only reachedWhen', () => {
    for (const bad of ['', '   ']) {
      expect(() =>
        parseUsablConfig(
          configJson({
            surfaces: [{ id: 'overview', url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'], reachedWhen: bad }],
          }),
        ),
      ).toThrow(/reachedWhen/);
    }
  });

  it('refuses a reachedWhen that is neither a string nor an object', () => {
    for (const bad of [42, true, null, ['main#root']]) {
      expect(() =>
        parseUsablConfig(
          configJson({
            surfaces: [{ id: 'overview', url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'], reachedWhen: bad }],
          }),
        ),
      ).toThrow(/reachedWhen/);
    }
  });
});

describe('parseUsablConfig surface reachedWhen object form', () => {
  const withSignal = (reachedWhen: unknown): string =>
    configJson({
      surfaces: [{ id: 'orders', url: 'http://127.0.0.1:5173/orders', files: ['src/Orders.tsx'], reachedWhen }],
    });

  it('reads a selector and a response together', () => {
    const config = parseUsablConfig(withSignal({ selector: 'table#orders', response: '/api/orders' }));
    expect(config.surfaces[0]?.reachedWhen).toEqual({ selector: 'table#orders', response: '/api/orders' });
  });

  it('reads a response on its own', () => {
    const config = parseUsablConfig(withSignal({ response: '/api/orders' }));
    expect(config.surfaces[0]?.reachedWhen).toEqual({ response: '/api/orders' });
  });

  it('reads a selector on its own', () => {
    const config = parseUsablConfig(withSignal({ selector: 'table#orders' }));
    expect(config.surfaces[0]?.reachedWhen).toEqual({ selector: 'table#orders' });
  });

  it('refuses an object that declares neither a selector nor a response', () => {
    expect(() => parseUsablConfig(withSignal({}))).toThrow(/reachedWhen/);
  });

  it('refuses a key it does not know, so a misspelled signal is not silently dropped', () => {
    expect(() => parseUsablConfig(withSignal({ selector: 'table#orders', respone: '/api/orders' }))).toThrow(
      /respone/,
    );
  });

  it('refuses an empty selector inside the object', () => {
    expect(() => parseUsablConfig(withSignal({ selector: '  ' }))).toThrow(/reachedWhen\.selector/);
  });

  it('refuses a response that is not a path on the application', () => {
    for (const bad of ['', 'api/orders', '//cdn.example/api', 'http://127.0.0.1:5173/api/orders', '/api/orders?x=1', '/api/orders#top', '/api/my orders', 42]) {
      expect(() => parseUsablConfig(withSignal({ response: bad }))).toThrow(/reachedWhen\.response/);
    }
  });

  it('refuses the bare root path, because every request on the host would satisfy it', () => {
    expect(() => parseUsablConfig(withSignal({ response: '/' }))).toThrow(/reachedWhen\.response/);
  });

  // Each of these is written one way and compared another. URL parsing resolves dot segments, reads
  // a backslash as a slash, and strips a trailing control character, so most of them come out as
  // "/", which every data request on the host satisfies. The message never repeats the value.
  const rootInDisguise: Array<[string, string]> = [
    ['a dot-dot segment that climbs back to the root', '/api/..'],
    ['a single dot segment', '/.'],
    ['percent-encoded dot-dot segments', '/%2e%2e/'],
    ['percent-encoded dot-dot segments in upper and mixed case', '/api/%2E%2e/'],
    ['a dot segment next to an encoded one', '/api/.%2E'],
    ['a dot segment in the middle of a path', '/api/./users'],
    ['a backslash, which the URL parser reads as a slash', '/\\x'],
    ['a backslash later in the path', '/api\\users'],
    ['a control character the URL parser strips', '/\u0001'],
  ];
  for (const [name, bad] of rootInDisguise) {
    it(`refuses ${name}, and does not repeat the value`, () => {
      let message = '';
      try {
        parseUsablConfig(withSignal({ response: bad }));
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/reachedWhen\.response/);
      expect(message).not.toContain(bad);
    });
  }

  it('still reads a segment that only starts with a dot', () => {
    const config = parseUsablConfig(withSignal({ response: '/api/.well-known/users' }));
    expect(config.surfaces[0]?.reachedWhen).toEqual({ response: '/api/.well-known/users' });
  });
});

describe('parseUsablConfig surface id', () => {
  const surface = (id: string, path: string) => ({
    id,
    url: `http://127.0.0.1:5173${path}`,
    files: [`src${path}.tsx`],
  });

  it('loads a config whose surface ids are all distinct', () => {
    const config = parseUsablConfig(
      configJson({ surfaces: [surface('profile', '/profile'), surface('billing', '/billing')] }),
    );
    expect(config.surfaces.map((entry) => entry.id)).toEqual(['profile', 'billing']);
  });

  it('refuses an empty id', () => {
    expect(() => parseUsablConfig(configJson({ surfaces: [surface('', '/overview')] }))).toThrow(
      /surfaces\[0\]\.id must be a non-empty string/,
    );
  });

  it('refuses a whitespace-only id for the whitespace it holds', () => {
    // The grammar is the only rule, so an id of spaces is refused the same way as an id with a
    // space in it: by the position and code point of the first one.
    expect(() => parseUsablConfig(configJson({ surfaces: [surface('   ', '/overview')] }))).toThrow(
      /surfaces\[0\]\.id contains a character that is not allowed, at position 1: U\+0020/,
    );
    expect(() => parseUsablConfig(configJson({ surfaces: [surface('\t', '/overview')] }))).toThrow(
      /at position 1: U\+0009/,
    );
  });

  it('refuses two surfaces that share one id and names both entries', () => {
    let message = '';
    try {
      parseUsablConfig(
        configJson({ surfaces: [surface('settings', '/settings/profile'), surface('settings', '/settings/billing')] }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('surfaces[1].id');
    expect(message).toContain('surfaces[0].id');
    expect(message).toContain('settings');
    expect(message).toMatch(/unique/);
  });

  it('still refuses a non-string id', () => {
    expect(() =>
      parseUsablConfig(
        configJson({ surfaces: [{ id: 42, url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'] }] }),
      ),
    ).toThrow(/surfaces\[0\]\.id must be a string/);
  });

  // Ids are compared exactly, so an id has to be something a reader can tell apart from another
  // id. Whitespace, invisible characters, and characters that reorder their neighbours all break
  // that, and they break it whether or not the two ids happen to be different map keys. The rule
  // is one rule, so every one of these is refused the same way.
  const indistinguishable: Array<[string, string]> = [
    ['ascii space', 'U+0020'],
    ['no-break space', 'U+00A0'],
    ['ideographic space', 'U+3000'],
    ['zero width space', 'U+200B'],
    ['right to left mark', 'U+200F'],
    ['right to left override', 'U+202E'],
    ['zero width joiner', 'U+200D'],
    ['combining grapheme joiner', 'U+034F'],
    ['variation selector', 'U+FE0F'],
    ['variation selector supplement', 'U+E0100'],
    ['hangul choseong filler', 'U+115F'],
    ['hangul filler', 'U+3164'],
  ];

  const charFor = (point: string) => String.fromCodePoint(Number.parseInt(point.slice(2), 16));

  it.each(indistinguishable)('refuses an id containing a %s and names the code point', (_label, point) => {
    let message = '';
    try {
      parseUsablConfig(configJson({ surfaces: [surface(`settings${charFor(point)}`, '/settings')] }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('surfaces[0].id');
    expect(message).toContain(point);
    expect(message).toMatch(/not allowed/);
  });

  it.each(indistinguishable)(
    'refuses a pair of ids that a reader cannot tell apart, separated by a %s',
    (_label, point) => {
      expect(() =>
        parseUsablConfig(
          configJson({
            surfaces: [
              surface('settings', '/settings/profile'),
              surface(`settings${charFor(point)}`, '/settings/billing'),
            ],
          }),
        ),
      ).toThrow(/surfaces\[1\]\.id/);
    },
  );

  it('refuses an id containing the empty braille pattern, which renders as blank but is not ignorable', () => {
    // U+2800 is an assigned symbol, not a format character and not default-ignorable, so no
    // Unicode property refuses it. The shared grammar lists it by hand. The message names the
    // position and the code point rather than printing a blank cell back.
    let message = '';
    try {
      parseUsablConfig(configJson({ surfaces: [surface('settings\u2800', '/settings')] }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('surfaces[0].id');
    expect(message).toContain('at position 9');
    expect(message).toContain('U+2800');
    expect(message).not.toContain('\u2800');
  });

  it('accepts the id discovery derives from a parameter route', () => {
    // Ask the generator for the id rather than hard-coding it, so this stays true if
    // screenIdFromUrl changes. The grammar has to leave route punctuation alone, or usabl init
    // would write a config that usabl then refuses to read.
    const id = screenIdFromUrl('/users/:id');
    const config = parseUsablConfig(configJson({ surfaces: [surface(id, '/users')] }));
    expect(config.surfaces[0]?.id).toBe(id);
    expect(describeSurfaceIdProblem(id)).toBeNull();
  });

  it('refuses an id that is not in Unicode NFC form', () => {
    // Canonically equivalent spellings render identically but compare unequal, so one spelling
    // would silently become two screens.
    const decomposed = 'cafe\u0301';
    expect(decomposed).not.toBe(decomposed.normalize('NFC'));
    expect(() => parseUsablConfig(configJson({ surfaces: [surface(decomposed, '/cafe')] }))).toThrow(
      /NFC form/,
    );
  });

  it('accepts the composed spelling of the same id', () => {
    const composed = 'cafe\u0301'.normalize('NFC');
    expect(parseUsablConfig(configJson({ surfaces: [surface(composed, '/cafe')] })).surfaces[0]?.id).toBe(
      composed,
    );
  });

  it.each([
    ['reserved but default-ignorable', 'U+2065', true],
    ['reserved and not default-ignorable', 'U+0378', false],
  ])('is honest about unassigned code points: %s is rejected=%s', (_label, point, rejected) => {
    // The comment does not claim unassigned code points are uniformly accepted, because they are
    // not: the reserved ranges Unicode marks default-ignorable are caught by that property.
    const id = `screen${charFor(point)}`;
    expect(describeSurfaceIdProblem(id) !== null).toBe(rejected);
  });

  it('keeps cross-script confusables as distinct ids, which the grammar does not claim to stop', () => {
    // Latin "a" and Cyrillic "a" look alike and are both accepted. They stay two surfaces rather
    // than folding into one, so neither is hidden behind the other and each is scanned when a
    // change affects it. The comment and the docs say that rather than claiming a property the
    // code does not deliver.
    const config = parseUsablConfig(
      configJson({ surfaces: [surface('varia', '/a'), surface('vari\u0430', '/b')] }),
    );
    expect(config.surfaces).toHaveLength(2);
  });
});

describe('surface id rules and usabl init agree', () => {
  // A tool that generates configs it then refuses to read is a defect whichever rule is right.
  // These are the route paths where screenIdFromUrl produces an id the parser rejects. init must
  // skip them with a note rather than write them.
  it.each([
    ['a raw space in the path', '/user settings'],
    ['a joining character in the path', '/family/\u{1F468}\u200D\u{1F469}'],
  ])('reports %s as an id problem so init can skip the route', (_label, path) => {
    expect(describeSurfaceIdProblem(screenIdFromUrl(path))).not.toBeNull();
  });

  it('reports no problem for an ordinary route path', () => {
    expect(describeSurfaceIdProblem(screenIdFromUrl('/clusters'))).toBeNull();
  });
});

describe('parseUsablConfig surface overridesDiscoveredRoute', () => {
  it('reads the declaration', () => {
    const config = parseUsablConfig(
      configJson({
        surfaces: [
          { id: 'clusters', url: 'http://127.0.0.1:5173/clusters?v=1', files: [], overridesDiscoveredRoute: true },
        ],
      }),
    );
    expect(config.surfaces[0]?.overridesDiscoveredRoute).toBe(true);
  });

  it('leaves it unset when the surface omits it', () => {
    expect(parseUsablConfig(configJson()).surfaces[0]?.overridesDiscoveredRoute).toBeUndefined();
  });

  it('refuses a non-boolean declaration', () => {
    expect(() =>
      parseUsablConfig(
        configJson({
          surfaces: [
            { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: [], overridesDiscoveredRoute: 'yes' },
          ],
        }),
      ),
    ).toThrow(/overridesDiscoveredRoute must be true or false/);
  });
});

describe('parseUsablConfig surface id error text', () => {
  // Config parsing happens before a Result exists, so nothing here goes through scrubResult.
  // The message lands on stderr and, through the stop hook, in front of a model. A branch config
  // is not trusted before the guard has checked it, so an id out of one is untrusted text.
  function messageFor(surfaces: unknown): string {
    try {
      parseUsablConfig(JSON.stringify({ ...BASE, surfaces }));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected the config to be refused');
  }

  const ESC = '\u001b';

  it('does not let a terminal escape sequence in an id reach the message', () => {
    // An operating system command sequence retitles the terminal window. It must not survive.
    const message = messageFor([
      { id: `settings${ESC}]0;OWNED\u0007`, url: 'http://127.0.0.1:5173/settings', files: ['src/Settings.tsx'] },
    ]);
    expect(message).not.toContain(ESC);
    expect(message).not.toContain('OWNED');
    expect(message).toContain('U+001B');
  });

  it('does not let a forged untrusted-text frame marker in an id reach the message', () => {
    // A model reading the stop hook is told everything inside the frame is data. An id that closes
    // the frame would relabel whatever follows it as trusted. Two things stop it: the marker
    // contains spaces, so the grammar refuses the id before anything is repeated back, and the
    // message names a code point instead of echoing the id. Assert the outcome, not the mechanism.
    const message = messageFor([
      { id: `settings${UNTRUSTED_FRAME_END}`, url: 'http://127.0.0.1:5173/settings', files: ['src/Settings.tsx'] },
    ]);
    expect(message).not.toContain(UNTRUSTED_FRAME_END);
    expect(message).not.toContain('UNTRUSTED');
  });

  it('does not let a payload in malformed JSON reach the message', () => {
    // A JSON.parse failure quotes the offending input back, so it is on the same egress as every
    // other message here.
    let message = '';
    try {
      parseUsablConfig(`{"appBaseUrl": zz${ESC}]0;OWNED\u0007${UNTRUSTED_FRAME_END}zz}`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('not valid JSON');
    expect(message).not.toContain(ESC);
    expect(message).not.toContain('OWNED');
    expect(message).not.toContain(UNTRUSTED_FRAME_END);
  });

  it('caps how much of a very long id it repeats back', () => {
    const long = 'a'.repeat(5000);
    const message = messageFor([
      { id: long, url: 'http://127.0.0.1:5173/a', files: ['src/A.tsx'] },
      { id: long, url: 'http://127.0.0.1:5173/b', files: ['src/B.tsx'] },
    ]);
    expect(message).toContain('(truncated)');
    expect(message.length).toBeLessThan(1000);
  });
});

describe('parseUsablConfig glob syntax', () => {
  it('loads a config using only stars and brace groups', () => {
    const config = parseUsablConfig(
      configJson({
        uiFileGlobs: ['src/**/*.{ts,tsx}'],
        discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: ['src/**/*.css'] },
        guardedPaths: ['usabl.config.json', 'src/policy'],
      }),
    );
    expect(config.uiFileGlobs).toEqual(['src/**/*.{ts,tsx}']);
  });

  it('rejects a uiFileGlobs pattern with an unsupported character', () => {
    for (const bad of ['src/**/*.[jt]s', 'src/(a|b).ts', 'src/**/*.ts?']) {
      expect(() => parseUsablConfig(configJson({ uiFileGlobs: [bad] })), bad).toThrow(/uiFileGlobs/);
    }
  });

  it('names the offending pattern and the unsupported character', () => {
    let message = '';
    try {
      parseUsablConfig(configJson({ uiFileGlobs: ['src/**/*.[jt]s'] }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('src/**/*.[jt]s');
    expect(message).toContain('[');
    expect(message).toMatch(/\{a,b\}/);
  });

  it('rejects an unsupported character in discovery.wideBlastGlobs', () => {
    expect(() =>
      parseUsablConfig(
        configJson({ discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: ['src/**/*.[jt]s'] } }),
      ),
    ).toThrow(/wideBlastGlobs/);
  });

  it('rejects an unsupported character in guardedPaths', () => {
    expect(() =>
      parseUsablConfig(configJson({ guardedPaths: ['usabl.config.json', 'src/(a|b)'] })),
    ).toThrow(/guardedPaths/);
  });

  it('rejects a nested brace form and names the brace syntax', () => {
    let message = '';
    try {
      parseUsablConfig(configJson({ uiFileGlobs: ['src/{a,{b,c}}.ts'] }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('src/{a,{b,c}}.ts');
    expect(message).toMatch(/brace/);
  });

  it('loads a config with a comma-less brace, which is a literal pattern', () => {
    // A comma-less {tsx} is not a group. Node glob treats it as literal text and matchGlob
    // now agrees, so it is a valid pattern and must load, not be refused.
    const config = parseUsablConfig(configJson({ uiFileGlobs: ['src/App.{tsx}'] }));
    expect(config.uiFileGlobs).toEqual(['src/App.{tsx}']);
  });
});

describe('parseUsablConfig noiseBudget', () => {
  it('reads default and per-surface calibration', () => {
    const config = parseUsablConfig(
      configJson({
        noiseBudget: {
          default: 5,
          perSurface: { clusters: 8 },
        },
      }),
    );
    expect(config.noiseBudget).toEqual({ default: 5, perSurface: { clusters: 8 } });
  });

  it('leaves noiseBudget unset when omitted', () => {
    expect(parseUsablConfig(configJson()).noiseBudget).toBeUndefined();
  });

  it('refuses invalid noiseBudget values', () => {
    expect(() => parseUsablConfig(configJson({ noiseBudget: { default: 0 } }))).toThrow(
      /noiseBudget\.default/,
    );
  });

  function perSurfaceRefusal(key: string): string {
    try {
      parseUsablConfig(configJson({ noiseBudget: { perSurface: { [key]: 8 } } }));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return '';
  }

  // Every key is written with escapes so the refused character never sits in this source as text.
  const zeroWidthSpace = '\u200B';
  const combiningAcute = '\u0301';

  it.each([
    ['a space', 'user settings', 'contains a character that is not allowed, at position 5: U+0020'],
    ['a zero width space', `clusters${zeroWidthSpace}`, 'at position 9: U+200B'],
    ['a spelling that is not in NFC form', `cafe${combiningAcute}`, 'must be written in Unicode NFC form'],
  ])('refuses a perSurface key the id grammar refuses: %s', (_label, key, expectedReason) => {
    // A perSurface key is a screen id, compared exactly against one, so a key the grammar refuses
    // can never match a screen. Accepting it would leave the operator with the default budget on
    // that screen and no reason why. The message points at the field and the key position, and
    // never prints the key back.
    const message = perSurfaceRefusal(key);
    expect(message).toContain('noiseBudget.perSurface key 1');
    expect(message).toContain(expectedReason);
    expect(message).toContain('can never match one');
    expect(message).not.toContain(key);
  });

  it('never prints a refused perSurface key back, not even one character of it', () => {
    // Every character the grammar refuses is invisible or reorders the text around it, so the
    // message names it by position and code point instead.
    expect(perSurfaceRefusal(`clusters${zeroWidthSpace}`)).not.toContain(zeroWidthSpace);
    expect(perSurfaceRefusal('clusters\u202E')).not.toContain('\u202E');
  });

  it('names the position of the refused key, not the count of keys before it', () => {
    let message = '';
    try {
      parseUsablConfig(
        configJson({ noiseBudget: { perSurface: { clusters: 8, 'user settings': 8 } } }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('noiseBudget.perSurface key 2');
  });

  it('says what the key count counts, because a whole-number key is read before the rest', () => {
    // The bad key is written first in the file, but a key that is a whole number is read back
    // first, so the count says 2. The message states what it counts rather than implying an order
    // in the file that it cannot promise.
    let message = '';
    try {
      parseUsablConfig(
        configJson({ noiseBudget: { perSurface: { 'user settings': 8, 42: 5 } } }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('noiseBudget.perSurface key 2');
    expect(message).toContain('the order the keys are read back');
    expect(message).toContain('not always the order they appear in the file');
  });

  it('accepts perSurface keys the id grammar accepts, including a parameter route id', () => {
    const config = parseUsablConfig(
      configJson({ noiseBudget: { perSurface: { 'user-settings': 8, 'users-:id': 3 } } }),
    );
    expect(config.noiseBudget?.perSurface).toEqual({ 'user-settings': 8, 'users-:id': 3 });
  });
});

describe('parseUsablConfig unknown key message', () => {
  it('does not repeat a key name shaped like a GitHub token', () => {
    // A misspelled key is repeated back so the operator can find it. A key that is a token, pasted
    // into the wrong place, must not be printed in full.
    const POISON = 'SECRETPOISON';
    const tokenKey = ['gh', 'p_', POISON.repeat(3)].join('');
    let message = '';
    try {
      parseUsablConfig(
        configJson({
          surfaces: [{ id: 'overview', url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'], reachedWhen: { [tokenKey]: 'main' } }],
        }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('unknown key');
    expect(message).not.toContain(POISON);
  });
});

describe('parseUsablConfig configured URL credentials', () => {
  // A surface URL is carried as written in the Result: gap refs, screen urls, and affected urls
  // all carry it, and the overlay and the stop hook print them. A credential written into one
  // would reach their readers, so the loader refuses it and never repeats the value.
  const SECRET = 'SECRETPOISON';

  function refusalFor(extra: Record<string, unknown>): string {
    try {
      parseUsablConfig(configJson(extra));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected the config to be refused');
  }

  it('refuses a surface url with a user name and password, naming the field and not the value', () => {
    const message = refusalFor({
      surfaces: [{ id: 'overview', url: `https://user:${SECRET}@host/x`, files: ['src/Overview.tsx'] }],
    });
    expect(message).toContain('surfaces[0].url');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('user:');
    expect(message).not.toContain('host/x');
  });

  it('refuses a surface url with a user name alone', () => {
    const message = refusalFor({
      surfaces: [{ id: 'overview', url: `https://${SECRET}@host/x`, files: ['src/Overview.tsx'] }],
    });
    expect(message).toContain('surfaces[0].url');
    expect(message).not.toContain(SECRET);
  });

  it('refuses userinfo in the spellings URL parsing accepts', () => {
    // A backslash reads as a slash, and tabs and line breaks are dropped, so each of these still
    // carries a password once the browser parses it.
    for (const url of [
      `https:\\\\user:${SECRET}@host/x`,
      `https://us\ter:${SECRET}@host/x`,
      `HTTPS://user:${SECRET}@host/x`,
    ]) {
      const message = refusalFor({ surfaces: [{ id: 'overview', url, files: ['src/Overview.tsx'] }] });
      expect(message, url).toContain('surfaces[0].url');
      expect(message, url).not.toContain(SECRET);
    }
  });

  it('refuses userinfo in a url that URL parsing rejects', () => {
    const message = refusalFor({
      surfaces: [{ id: 'overview', url: `https://user:${SECRET}@[bad/x`, files: ['src/Overview.tsx'] }],
    });
    expect(message).toContain('surfaces[0].url');
    expect(message).not.toContain(SECRET);
  });

  it('names the index of the surface that carries the credential', () => {
    const message = refusalFor({
      surfaces: [
        { id: 'overview', url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'] },
        { id: 'settings', url: `https://user:${SECRET}@host/settings`, files: ['src/Settings.tsx'] },
      ],
    });
    expect(message).toContain('surfaces[1].url');
    expect(message).not.toContain(SECRET);
  });

  it('refuses an appBaseUrl with userinfo, because every discovered route url is built from it', () => {
    const message = refusalFor({ appBaseUrl: `http://user:${SECRET}@127.0.0.1:5173` });
    expect(message).toContain('appBaseUrl');
    expect(message).not.toContain(SECRET);
  });

  it('still reads an @ that sits in the path, the query, or the fragment', () => {
    const urls = [
      'http://127.0.0.1:5173/users/@alice',
      'http://127.0.0.1:5173/search?q=a@b',
      'http://127.0.0.1:5173/#/users/@alice',
    ];
    for (const url of urls) {
      const config = parseUsablConfig(configJson({ surfaces: [{ id: 'overview', url, files: ['src/Overview.tsx'] }] }));
      expect(config.surfaces[0]?.url, url).toBe(url);
    }
  });

  it('keeps a surface url exactly as written, so the overlay can match a gap to its screen', () => {
    // The overlay attributes a gap to a screen by comparing the url the Result carries with the
    // url it was configured with, query and fragment included. Rewriting the url here would
    // orphan the gap.
    const url = 'http://127.0.0.1:5173/report?view=a#top';
    const config = parseUsablConfig(configJson({ surfaces: [{ id: 'overview', url, files: ['src/Overview.tsx'] }] }));
    expect(config.surfaces[0]?.url).toBe(url);
  });
});

describe('configUrlWarnings', () => {
  const SECRET = 'SECRETPOISON';

  it('warns about a query string in a surface url, naming the field and not the value', () => {
    const config = parseUsablConfig(
      configJson({ surfaces: [{ id: 'overview', url: `http://127.0.0.1:5173/x?token=${SECRET}`, files: ['src/Overview.tsx'] }] }),
    );
    const warnings = configUrlWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('surfaces[0].url');
    expect(warnings[0]).toContain('query');
    expect(warnings.join('\n')).not.toContain(SECRET);
    expect(warnings.join('\n')).not.toContain('token=');
  });

  it('warns about a fragment in a surface url', () => {
    const config = parseUsablConfig(
      configJson({ surfaces: [{ id: 'overview', url: `http://127.0.0.1:5173/x#access_token=${SECRET}`, files: ['src/Overview.tsx'] }] }),
    );
    const warnings = configUrlWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('surfaces[0].url');
    expect(warnings.join('\n')).not.toContain(SECRET);
  });

  it('warns about a query string in appBaseUrl', () => {
    const config = parseUsablConfig(configJson({ appBaseUrl: `http://127.0.0.1:5173/?preview=${SECRET}` }));
    const warnings = configUrlWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('appBaseUrl');
    expect(warnings.join('\n')).not.toContain(SECRET);
  });

  it('says nothing about a plain url', () => {
    expect(configUrlWarnings(parseUsablConfig(configJson()))).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('passes each configured url warning to the warning sink, and still returns the config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usabl-config-'));
    const path = join(dir, 'usabl.config.json');
    await writeFile(
      path,
      configJson({ surfaces: [{ id: 'overview', url: 'http://127.0.0.1:5173/x?view=a', files: ['src/Overview.tsx'] }] }),
      'utf8',
    );
    const warnings: string[] = [];
    const config = await loadConfig(path, (line) => warnings.push(line));
    expect(config.surfaces[0]?.url).toBe('http://127.0.0.1:5173/x?view=a');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('surfaces[0].url');
  });

  it('warns once per process for each url, so a dev server reloading its config does not repeat it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usabl-config-'));
    const path = join(dir, 'usabl.config.json');
    const write = (url: string) =>
      writeFile(path, configJson({ surfaces: [{ id: 'overview', url, files: ['src/Overview.tsx'] }] }), 'utf8');
    const warnings: string[] = [];

    await write('http://127.0.0.1:5173/x?view=once');
    await loadConfig(path, (line) => warnings.push(line));
    await loadConfig(path, (line) => warnings.push(line));
    expect(warnings).toHaveLength(1);

    // A different url is a different warning.
    await write('http://127.0.0.1:5173/x?view=twice');
    await loadConfig(path, (line) => warnings.push(line));
    await loadConfig(path, (line) => warnings.push(line));
    expect(warnings).toHaveLength(2);
  });
});

describe('parseUsablConfig userinfo without a scheme and two slashes', () => {
  // URL parsing reads "admin:" in "admin:secret@host" as a scheme, so it finds no password, and a
  // shape check that needs "//" misses it too. The value is still printed as written.
  const SECRET = 'SECRETPOISON';

  function load(url: string): unknown {
    return parseUsablConfig(configJson({ surfaces: [{ id: 'overview', url, files: ['src/Overview.tsx'] }] }));
  }

  for (const url of [`admin:${SECRET}@localhost:3000/x`, `u:${SECRET}@h`, `http:u:${SECRET}@h`, `//u${SECRET}@h`]) {
    it(`refuses ${url.replace(SECRET, '<secret>')}`, () => {
      let message = '';
      try {
        load(url);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('surfaces[0].url');
      expect(message).not.toContain(SECRET);
    });
  }

  for (const url of ['http://h/@x', 'http://h/x?q=a@b', 'http://h/#/@me']) {
    it(`accepts ${url}`, () => {
      expect(() => load(url)).not.toThrow();
    });
  }
});
