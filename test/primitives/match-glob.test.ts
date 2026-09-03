import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';

describe('matchGlob', () => {
  it('matches src/**/*.tsx against src/App.tsx', () => {
    expect(matchGlob('src/**/*.tsx', 'src/App.tsx')).toBe(true);
  });

  describe('brace expansion', () => {
    it('matches the issue examples', () => {
      expect(matchGlob('src/**/*.{ts,tsx}', 'src/run.ts')).toBe(true);
      expect(matchGlob('src/**/*.{ts,tsx}', 'src/App.tsx')).toBe(true);
    });

    it('matches deeper files under a brace group', () => {
      expect(matchGlob('src/**/*.{ts,tsx}', 'src/pages/Home.tsx')).toBe(true);
      expect(matchGlob('src/**/*.{ts,tsx}', 'src/lib/util.ts')).toBe(true);
    });

    it('does not match a file outside the brace alternatives', () => {
      expect(matchGlob('src/**/*.{ts,tsx}', 'src/style.css')).toBe(false);
      expect(matchGlob('src/**/*.{ts,tsx}', 'lib/run.ts')).toBe(false);
    });

    it('supports multiple brace groups as a cartesian product', () => {
      const pattern = '{src,app}/**/*.{ts,tsx}';
      expect(matchGlob(pattern, 'src/run.ts')).toBe(true);
      expect(matchGlob(pattern, 'app/App.tsx')).toBe(true);
      expect(matchGlob(pattern, 'lib/run.ts')).toBe(false);
      expect(matchGlob(pattern, 'src/run.js')).toBe(false);
    });

    it('treats a comma-less brace group as literal text, matching Node glob', () => {
      // Node and minimatch expand {...} only when the body has a comma. A comma-less
      // {tsx} is literal, so it matches a file that literally contains {tsx} and not one
      // where the braces are stripped.
      expect(matchGlob('src/App.{tsx}', 'src/App.{tsx}')).toBe(true);
      expect(matchGlob('src/App.{tsx}', 'src/App.tsx')).toBe(false);
      expect(matchGlob('src/{ts}/a.ts', 'src/{ts}/a.ts')).toBe(true);
      expect(matchGlob('src/{ts}/a.ts', 'src/ts/a.ts')).toBe(false);
    });

    it('treats an empty brace {} as literal text', () => {
      expect(matchGlob('src/App.{}', 'src/App.{}')).toBe(true);
      expect(matchGlob('src/App.{}', 'src/App.')).toBe(false);
    });

    it('expands a brace with a comma even when an alternative is empty', () => {
      // {,} has a comma, so it expands to two empty alternatives.
      expect(matchGlob('src/App.{,}tsx', 'src/App.tsx')).toBe(true);
      // {ts,} expands to "ts" or "".
      expect(matchGlob('src/util.{ts,}', 'src/util.ts')).toBe(true);
      expect(matchGlob('src/util.{ts,}', 'src/util.')).toBe(true);
      // {,ts} expands to "" or "ts".
      expect(matchGlob('src/util.{,ts}', 'src/util.ts')).toBe(true);
      expect(matchGlob('src/util.{,ts}', 'src/util.')).toBe(true);
    });
  });

  describe('existing star semantics are unchanged', () => {
    it('single star does not cross a slash', () => {
      expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
      expect(matchGlob('src/*.ts', 'src/nested/a.ts')).toBe(false);
    });

    it('double star crosses slashes', () => {
      expect(matchGlob('src/**/*.ts', 'src/a.ts')).toBe(true);
      expect(matchGlob('src/**/*.ts', 'src/deep/nested/a.ts')).toBe(true);
    });
  });

  describe('property style: {a,b} under src', () => {
    const exts = ['ts', 'tsx', 'js', 'jsx', 'css', 'json', 'md'];
    const dirs = ['src', 'src/pages', 'src/lib/util', 'lib', 'app'];
    it('is true exactly when the path ends in .a or .b under src', () => {
      const pattern = 'src/**/*.{ts,tsx}';
      for (const dir of dirs) {
        for (const ext of exts) {
          const file = `${dir}/name.${ext}`;
          const expected = dir.startsWith('src') && (ext === 'ts' || ext === 'tsx');
          expect(matchGlob(pattern, file), file).toBe(expected);
        }
      }
    });
  });
});
