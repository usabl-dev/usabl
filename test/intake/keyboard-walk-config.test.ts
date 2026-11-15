/**
 * The keyboard walk budget of one screen is operator config: a long table page needs more Tab
 * stops and more time than the engine default, and a walk that runs out is a coverage gap. The
 * budget sits in keyboardWalk.perSurface, keyed by screen id, as noiseBudget.perSurface is. Each
 * value has an upper bound, and a value out of range is refused when the config is read, before a
 * run opens a browser.
 */
import { describe, expect, it } from 'vitest';
import { parseUsablConfig } from '../../src/intake/config.js';
import {
  MAX_UNREADABLE_REGIONS,
  MAX_WALK_TAB_CAP,
  MAX_WALK_WALL_CLOCK_MS,
  parseWalkBudget,
} from '../../src/intake/keyboard-walk-config.js';

const BASE = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'jobs', url: 'http://127.0.0.1:5173/jobs', files: ['src/Jobs.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

function configJson(keyboardWalk: unknown): string {
  return JSON.stringify({ ...BASE, keyboardWalk });
}

describe('keyboardWalk in usabl.config.json', () => {
  it('reads a stop cap and a time cap for one screen', () => {
    const config = parseUsablConfig(configJson({ perSurface: { jobs: { tabCap: 600, wallClockMs: 60_000 } } }));
    expect(config.keyboardWalk).toEqual({ perSurface: { jobs: { tabCap: 600, wallClockMs: 60_000 } } });
  });

  it('reads either cap on its own, and leaves the block unset when it is not there', () => {
    expect(parseUsablConfig(configJson({ perSurface: { jobs: { tabCap: 300 } } })).keyboardWalk).toEqual({ perSurface: { jobs: { tabCap: 300 } } });
    expect(parseUsablConfig(configJson({ perSurface: { jobs: { wallClockMs: 20_000 } } })).keyboardWalk).toEqual({
      perSurface: { jobs: { wallClockMs: 20_000 } },
    });
    expect(parseUsablConfig(JSON.stringify(BASE)).keyboardWalk).toBeUndefined();
  });

  it('accepts each cap at its upper bound', () => {
    const config = parseUsablConfig(configJson({ perSurface: { jobs: { tabCap: MAX_WALK_TAB_CAP, wallClockMs: MAX_WALK_WALL_CLOCK_MS } } }));
    expect(config.keyboardWalk?.perSurface?.['jobs']).toEqual({ tabCap: 2000, wallClockMs: 300_000 });
  });

  it('refuses a stop cap out of range, with a plain message that names the field and the bound', () => {
    for (const bad of [0, -1, 1.5, 2001, '600', null, 1e100]) {
      expect(() => parseUsablConfig(configJson({ perSurface: { jobs: { tabCap: bad } } }))).toThrow(
        'keyboardWalk.perSurface.jobs.tabCap must be a whole number of Tab stops from 1 to 2000',
      );
    }
  });

  it('refuses a time cap out of range, with a plain message that names the field and the bound', () => {
    for (const bad of [0, -5, 2.5, 300_001, '60000', true]) {
      expect(() => parseUsablConfig(configJson({ perSurface: { jobs: { wallClockMs: bad } } }))).toThrow(
        'keyboardWalk.perSurface.jobs.wallClockMs must be a whole number of milliseconds from 1 to 300000',
      );
    }
  });

  it('refuses a key it does not know, so a misspelled cap is not silently the default', () => {
    expect(() => parseUsablConfig(configJson({ perScreen: {} }))).toThrow('keyboardWalk has an unknown key');
    expect(() => parseUsablConfig(configJson({ perSurface: { jobs: { tabcap: 600 } } }))).toThrow(
      'keyboardWalk.perSurface.jobs has an unknown key',
    );
  });

  it('refuses a block, a map, or an entry that is not an object', () => {
    expect(() => parseUsablConfig(configJson([]))).toThrow('keyboardWalk must be an object');
    expect(() => parseUsablConfig(configJson({ perSurface: [] }))).toThrow('keyboardWalk.perSurface must be an object');
    expect(() => parseUsablConfig(configJson({ perSurface: { jobs: 600 } }))).toThrow('keyboardWalk.perSurface.jobs must be an object');
  });

  it('refuses a screen key the id grammar refuses, by position, never printing the key', () => {
    let message = '';
    try {
      parseUsablConfig(configJson({ perSurface: { 'jobs list': { tabCap: 600 } } }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('keyboardWalk.perSurface key 1 names a screen');
    expect(message).not.toContain('jobs list');
  });

  it('stores a key such as __proto__ as a screen of its own, never on the prototype', () => {
    const config = parseUsablConfig(`{"appBaseUrl":"http://127.0.0.1:5173","uiFileGlobs":["src/**"],"discovery":{"routerFile":"src/App.tsx","wideBlastGlobs":[]},"surfaces":[],"guardedPaths":["usabl.config.json"],"keyboardWalk":{"perSurface":{"__proto__":{"tabCap":5}}}}`);
    const perSurface = config.keyboardWalk?.perSurface ?? {};
    expect(Object.hasOwn(perSurface, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['tabCap']).toBeUndefined();
  });
});

// The regions one screen accepts the keyboard walk cannot read. Each entry names one region in the
// one form the walk compares, so a listing never reads as wider or narrower than what it matches.
describe('keyboardWalk.perSurface.<id>.unreadableRegions', () => {
  function regions(list: unknown) {
    return parseUsablConfig(configJson({ perSurface: { jobs: { unreadableRegions: list } } })).keyboardWalk?.perSurface?.['jobs'];
  }

  it('reads a frame by its origin and a closed shadow root by the tag of its host', () => {
    expect(regions([{ frameOrigin: 'https://chat.example.com' }, { shadowHost: 'chat-widget' }])).toEqual({
      unreadableRegions: [{ frameOrigin: 'https://chat.example.com' }, { shadowHost: 'chat-widget' }],
    });
  });

  it('writes an origin with a trailing slash or a default port the way the walk names it', () => {
    expect(regions([{ frameOrigin: 'https://chat.example.com/' }])?.unreadableRegions).toEqual([{ frameOrigin: 'https://chat.example.com' }]);
    expect(regions([{ frameOrigin: 'https://chat.example.com:443' }])?.unreadableRegions).toEqual([{ frameOrigin: 'https://chat.example.com' }]);
    expect(regions([{ frameOrigin: 'http://127.0.0.1:8080' }])?.unreadableRegions).toEqual([{ frameOrigin: 'http://127.0.0.1:8080' }]);
  });

  it('refuses an origin with a path, a query, or a fragment, or one that is not http or https', () => {
    for (const frameOrigin of [
      'https://chat.example.com/widget',
      'https://chat.example.com/?token=SECRETPOISON',
      'https://chat.example.com/#top',
      'chat.example.com',
      'ftp://chat.example.com',
      'data:text/html,hi',
      42,
    ]) {
      expect(() => regions([{ frameOrigin }])).toThrow('keyboardWalk.perSurface.jobs.unreadableRegions[0].frameOrigin must be a bare http or https origin');
    }
  });

  it('never prints an origin it refuses, so a token in it stays out of the message', () => {
    expect(() => regions([{ frameOrigin: 'https://chat.example.com/?token=SECRETPOISON' }])).not.toThrow('SECRETPOISON');
  });

  it('refuses a host tag that is not a lowercase tag name', () => {
    for (const shadowHost of ['Chat-Widget', 'chat widget', '', '1-widget', 'div>', 7]) {
      expect(() => regions([{ shadowHost }])).toThrow('keyboardWalk.perSurface.jobs.unreadableRegions[0].shadowHost must be the tag name');
    }
  });

  it('refuses an entry that names two regions, none, or one with a key it does not know', () => {
    expect(() => regions([{ frameOrigin: 'https://chat.example.com', shadowHost: 'chat-widget' }])).toThrow('unreadableRegions[0] must name one region');
    expect(() => regions([{}])).toThrow('unreadableRegions[0] must name one region');
    expect(() => regions(['https://chat.example.com'])).toThrow('unreadableRegions[0] must name one region');
    expect(() => regions([{ frameSrc: 'https://chat.example.com' }])).toThrow('unreadableRegions[0] has an unknown key');
  });

  it('refuses a value that is not a list, and a list longer than the bound', () => {
    expect(() => regions({ frameOrigin: 'https://chat.example.com' })).toThrow(
      `keyboardWalk.perSurface.jobs.unreadableRegions must be a list of at most ${MAX_UNREADABLE_REGIONS} regions`,
    );
    const many = Array.from({ length: MAX_UNREADABLE_REGIONS + 1 }, () => ({ shadowHost: 'chat-widget' }));
    expect(() => regions(many)).toThrow('must be a list of at most 20 regions');
    expect(regions(many.slice(0, MAX_UNREADABLE_REGIONS))?.unreadableRegions).toHaveLength(20);
  });

  it('sits beside the walk budget of the same screen', () => {
    const config = parseUsablConfig(configJson({ perSurface: { jobs: { tabCap: 600, unreadableRegions: [{ shadowHost: 'chat-widget' }] } } }));
    expect(config.keyboardWalk?.perSurface?.['jobs']).toEqual({ tabCap: 600, unreadableRegions: [{ shadowHost: 'chat-widget' }] });
  });
});

describe('parseWalkBudget, shared with the checkPage options', () => {
  it('checks a value with the same bounds and names the label it was given', () => {
    expect(parseWalkBudget({ tabCap: 10, wallClockMs: 1000 }, 'checkPage() options')).toEqual({ tabCap: 10, wallClockMs: 1000 });
    expect(() => parseWalkBudget({ tabCap: 5000 }, 'checkPage() options')).toThrow('checkPage() options.tabCap must be a whole number of Tab stops from 1 to 2000');
  });
});
