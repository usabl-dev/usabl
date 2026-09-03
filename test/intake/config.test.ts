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

  it('refuses a non-string reachedWhen', () => {
    expect(() =>
      parseUsablConfig(
        configJson({
          surfaces: [{ id: 'overview', url: 'http://127.0.0.1:5173/overview', files: ['src/Overview.tsx'], reachedWhen: 42 }],
        }),
      ),
    ).toThrow(/reachedWhen/);
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
