/**
 * `localFiles` lists git-ignored files the app reads, so the receipt can bind them. It names exact
 * paths from the repository root. The loader refuses anything else plainly, before any run.
 */
import { describe, expect, it } from 'vitest';
import { parseUsablConfig } from '../../src/intake/config.js';
import { MAX_LOCAL_FILES, MAX_LOCAL_FILE_PATH_LENGTH } from '../../src/intake/local-files.js';

const BASE = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

function parse(localFiles: unknown): ReturnType<typeof parseUsablConfig> {
  return parseUsablConfig(JSON.stringify({ ...BASE, localFiles }));
}

describe('parseUsablConfig localFiles', () => {
  it('is absent when the config does not name it', () => {
    expect(parseUsablConfig(JSON.stringify(BASE)).localFiles).toBeUndefined();
  });

  it('reads exact paths from the repository root', () => {
    expect(parse(['public/generated.js', 'apps/web/.env.shared']).localFiles).toEqual([
      'public/generated.js',
      'apps/web/.env.shared',
    ]);
    expect(parse([]).localFiles).toEqual([]);
  });

  it('refuses a value that is not a list of strings', () => {
    expect(() => parse('public/generated.js')).toThrow('localFiles must be a string array');
    expect(() => parse([1])).toThrow('localFiles must be a string array');
  });

  const refused: Array<[string, string, string]> = [
    ['an empty path', '', 'is empty'],
    ['white space at an end', ' public/a.js', 'white space'],
    ['a leading slash', '/etc/hosts', 'starts with /'],
    ['a climb out of the root', '../secrets.env', '. or .. segment'],
    ['a climb in the middle', 'public/../../x', '. or .. segment'],
    ['a dot segment', './public/a.js', '. or .. segment'],
    ['an empty segment', 'public//a.js', 'empty segment'],
    ['a trailing slash', 'public/', 'empty segment'],
    ['a backslash', 'public\\a.js', 'backslash'],
    ['a drive letter', 'C:/a.js', 'drive'],
    ['a glob', 'public/*.js', 'glob'],
    ['a brace group', 'public/{a,b}.js', 'glob'],
    ['a control character', 'public/a\u0007.js', 'control character'],
  ];
  for (const [name, entry, words] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => parse([entry])).toThrow(words);
      expect(() => parse([entry])).toThrow('localFiles entry');
    });
  }

  it('refuses a path that is too long', () => {
    expect(() => parse(['a'.repeat(MAX_LOCAL_FILE_PATH_LENGTH + 1)])).toThrow(String(MAX_LOCAL_FILE_PATH_LENGTH));
    expect(parse(['a'.repeat(MAX_LOCAL_FILE_PATH_LENGTH)]).localFiles).toHaveLength(1);
  });

  it('refuses more paths than it binds', () => {
    const many = Array.from({ length: MAX_LOCAL_FILES + 1 }, (_, index) => `public/${String(index)}.js`);
    expect(() => parse(many)).toThrow(String(MAX_LOCAL_FILES));
    expect(parse(many.slice(0, MAX_LOCAL_FILES)).localFiles).toHaveLength(MAX_LOCAL_FILES);
  });
});
