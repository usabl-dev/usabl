/**
 * The keyboard walk budget of one screen is operator config: a long table page needs more Tab
 * stops and more time than the engine default, and a walk that runs out is a coverage gap. The
 * budget sits in keyboardWalk.perSurface, keyed by screen id, as noiseBudget.perSurface is. Each
 * value has an upper bound, and a value out of range is refused when the config is read, before a
 * run opens a browser.
 */
import { describe, expect, it } from 'vitest';
import { parseUsablConfig } from '../../src/intake/config.js';
import { MAX_WALK_TAB_CAP, MAX_WALK_WALL_CLOCK_MS, parseWalkBudget } from '../../src/intake/keyboard-walk-config.js';

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

describe('parseWalkBudget, shared with the checkPage options', () => {
  it('checks a value with the same bounds and names the label it was given', () => {
    expect(parseWalkBudget({ tabCap: 10, wallClockMs: 1000 }, 'checkPage() options')).toEqual({ tabCap: 10, wallClockMs: 1000 });
    expect(() => parseWalkBudget({ tabCap: 5000 }, 'checkPage() options')).toThrow('checkPage() options.tabCap must be a whole number of Tab stops from 1 to 2000');
  });
});
