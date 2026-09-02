/**
 * How long an application takes to render is a property of the application, not of the engine,
 * so the readiness budget is operator config. A bad value has to be refused while parsing, which
 * is before the run builds deps or opens a browser.
 */
import { describe, expect, it } from 'vitest';
import { parseUsablConfig } from '../../src/intake/config.js';

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
