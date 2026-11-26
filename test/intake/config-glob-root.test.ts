/**
 * A brace group can make a glob name a path from the root of the machine: `{,src}/**` expands to
 * `/**`, which Node's fs.glob walks across the whole disk, so a stop could outlast the host's
 * limit. The file system adapter does not run such a pattern, so config load refuses it in every
 * policy glob list, and the other expansions are never dropped without a word.
 */
import { describe, expect, it } from 'vitest';
import { parseUsablConfig } from '../../src/intake/config.js';

const BASE = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const configWith = (extra: Record<string, unknown>): string => JSON.stringify({ ...BASE, ...extra });

describe('a policy glob with a brace expansion from the machine root', () => {
  for (const glob of ['{,src}/**', '{/,src/}**/*.tsx', '{,}']) {
    it(`refuses ${glob} in uiFileGlobs and discovery.wideBlastGlobs`, () => {
      expect(() => parseUsablConfig(configWith({ uiFileGlobs: [glob] }))).toThrow(/uiFileGlobs pattern .* brace expansion/u);
      expect(() => parseUsablConfig(configWith({ discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [glob] } }))).toThrow(
        /discovery\.wideBlastGlobs pattern .* brace expansion/u,
      );
    });
  }

  // Node's walk would start above the repository or at the root of a drive.
  for (const glob of ['../shared/**', '{..,src}/**', 'src/**/../../x/*.tsx', 'C:/**', 'c:']) {
    it(`refuses ${glob}, whose walk starts outside the repository`, () => {
      expect(() => parseUsablConfig(configWith({ uiFileGlobs: [glob] }))).toThrow(/uiFileGlobs pattern .* outside the repository/u);
    });
  }

  it('accepts a .. that Node folds away inside the repository', () => {
    expect(parseUsablConfig(configWith({ uiFileGlobs: ['src/../lib/**'] })).uiFileGlobs).toEqual(['src/../lib/**']);
  });

  it('accepts a brace group whose every expansion starts inside the repository', () => {
    const globs = ['src/{,lib/}**/*.tsx', '{src,lib}/**', 'src/{a,b}/x{,}'];
    expect(parseUsablConfig(configWith({ uiFileGlobs: globs })).uiFileGlobs).toEqual(globs);
  });
});
