/**
 * How the file system adapter reads a glob: which patterns it lists wide and filters, which it
 * hands to Node unchanged, and which are past the bound and not run.
 */
import { describe, expect, it } from 'vitest';
import { FS_GLOB_BOUND, fsGlobBoundProblem, nodeGlobReading } from '../../src/deps/fs-glob-reading.js';

describe('the bound on syntax the filter does not read', () => {
  it('names nothing for a pattern the filter reads, at any wildcard count', () => {
    expect(fsGlobBoundProblem(`src/${'*a'.repeat(12)}*b`)).toBeNull();
    expect(fsGlobBoundProblem(`packages/${'*?'.repeat(500)}/package.json`)).toBeNull();
    expect(fsGlobBoundProblem('src/{a,b}/**/*.{ts,tsx}')).toBeNull();
    expect(fsGlobBoundProblem('${a,b}/x')).toBeNull();
  });

  it('names nothing for a character class with at most one run of * in each part', () => {
    expect(fsGlobBoundProblem('src/[a]*.ts')).toBeNull();
    expect(fsGlobBoundProblem('src/[a]*a/[b]*b/**/[c]?')).toBeNull();
  });

  it('names an extglob group', () => {
    for (const pattern of ['src/+(a|aa)b', 'src/@(a)', 'src/!(a)', 'src/*(a)', 'src/?(a)']) {
      expect(fsGlobBoundProblem(pattern), pattern).toContain('extglob');
    }
  });

  it('names a part with other syntax and more than one run of *', () => {
    expect(fsGlobBoundProblem('src/[a]*a*')).toContain('run of *');
    expect(fsGlobBoundProblem('src/{[a]*,b*c*}')).toContain('run of *');
  });

  it('names a pattern past the length bound', () => {
    expect(fsGlobBoundProblem(`src/[a]${'x'.repeat(FS_GLOB_BOUND.length)}`)).toContain('longer than');
    expect(fsGlobBoundProblem('x'.repeat(64 * 1024 + 1))).toContain('Node refuses');
  });

  it('names a pattern or an expansion that is empty or starts from the machine root', () => {
    for (const pattern of ['', '/x/*', '//x', '\\x', '{,zz}/**', '{/,a}/**', '{,}', '{,/}x/[a]']) {
      expect(fsGlobBoundProblem(pattern), JSON.stringify(pattern)).toContain('root');
    }
    expect(fsGlobBoundProblem('a/{,zz}/**')).toBeNull();
    expect(fsGlobBoundProblem('{,a}b/**')).toBeNull();
  });

  it('names a pattern whose walk starts above its folder or at a drive', () => {
    for (const pattern of ['../x/*', '..\\outside\\*', './../x', '{..,a}/*', 'src/**/../../x']) {
      expect(fsGlobBoundProblem(pattern), pattern).not.toBeNull();
    }
    // Only Windows reads a first name that ends with `:` as a drive.
    for (const pattern of ['C:/**', 'C:\\**', 'c:', 'd:/x/[a]', '{C:,a}/x']) {
      expect(fsGlobBoundProblem(pattern, 'win32'), pattern).not.toBeNull();
      expect(fsGlobBoundProblem(pattern, 'linux'), pattern).toBeNull();
      expect(fsGlobBoundProblem(pattern, 'darwin'), pattern).toBeNull();
    }
    expect(fsGlobBoundProblem('src/../x/*')).toBeNull();
    expect(fsGlobBoundProblem('src/**/../x')).toBeNull();
    expect(fsGlobBoundProblem('src/a:b/*')).toBeNull();
  });

  it('names braces it cannot count', () => {
    expect(fsGlobBoundProblem('src/{a,{b,c}}/x')).toContain('brace');
    expect(fsGlobBoundProblem('src/{1..3}/x')).toContain('brace');
    expect(fsGlobBoundProblem('src/{a,b}}')).toContain('brace');
    // With no closed group Node expands nothing, so every brace is text the filter reads.
    expect(fsGlobBoundProblem('src/{a,b')).toBeNull();
    expect(fsGlobBoundProblem(`src/${'{a,b}'.repeat(9)}`)).toContain('more than 256');
  });
});

describe('the listing', () => {
  const listed = (pattern: string, nocase = false): string[] => {
    const reading = nodeGlobReading(pattern, { nocase });
    return reading.kind === 'filtered' ? reading.listings.map((listing) => listing.patterns.join(' + ')) : [reading.kind];
  };

  it('widens every part with more than one run of * and keeps every other part', () => {
    expect(listed(`src/${'*a'.repeat(12)}*b`)).toEqual(['src/*']);
    expect(listed('src/**/.a*a*/x?.tsx')).toEqual(['src/**/.*/x?.tsx']);
    expect(listed('./src//a/./b/../*a*.ts')).toEqual(['./src/a/*']);
    expect(listed('a\\*a*.ts')).toEqual(['a/*']);
  });

  it('expands braces the way Node does and joins sets that can share one call', () => {
    expect(listed('src/{a,b}/*a*.{ts,tsx}')).toEqual(['src/a/* + src/b/*']);
    expect(listed('x{,a}/*a*b')).toEqual(['x/* + xa/*']);
    expect(listed('{x}/k*a*b')).toEqual(['{x}/*']);
    expect(listed('${a,b}/*a*b')).toEqual(['${a,b}/*']);
    expect(listed('{,a}/x')).toEqual(['past-bound']);
  });

  // Node skips a pattern that reaches a folder with a rest it has seen there, so two sets whose
  // listed rests are the same but whose written rests differ are listed in separate calls.
  it('lists sets in separate calls when Node could skip one of them', () => {
    expect(listed('{a/*p*q,*/*r*s}')).toEqual(['a/*', '*/*']);
    expect(listed('{a/*p*q,c/*r*s}')).toEqual(['a/* + c/*']);
  });

  it('hands Node the written pattern when no part can backtrack', () => {
    for (const pattern of ['src/**', 'src/{a,b}/*.{ts,tsx}', '{x}/k', '${a,b}', 'x{,a}', 'src*/**/*.tsx', 'x/{a/**,**/a}/y']) {
      expect(listed(pattern), pattern).toEqual(['unchanged']);
      expect(listed(pattern, true), pattern).toEqual(['unchanged']);
    }
  });

  // On macOS and Windows the volume answers a fixed name without regard to case, so Node's walk
  // finds `SRC` through `src`. The listing keeps every fixed part as written, and the filter
  // compares without case.
  it('keeps fixed parts on a platform that ignores case and matches them without case', () => {
    expect(listed('src/*a*b', true)).toEqual(['src/*']);
    expect(listed('.github/x1/*a*b', true)).toEqual(['.github/x1/*']);
    const folded = nodeGlobReading('src/*a*b', { nocase: true });
    const test = folded.kind === 'filtered' ? folded.listings[0]?.matches : undefined;
    expect(test?.('SRC/zAzB')).toBe(true);
    expect(test?.('src2/zazb')).toBe(false);
  });

  it('keeps a part with at most one run of *, which Node cannot backtrack on', () => {
    expect(listed('apps-*/a?b*/*a*b')).toEqual(['apps-*/a?b*/*']);
  });

  it('merges brace expansions the way Node does', () => {
    expect(listed('x/{a/**,**/a}/*b*c')).toEqual(['x/**/a/**/*']);
  });

  it('lists names Node folds together on a platform that ignores case', () => {
    const reading = nodeGlobReading('x/?σ*a*', { nocase: true });
    const test = reading.kind === 'filtered' ? reading.listings[0]?.matches : undefined;
    // ß has no one-letter upper case, and σ and ς meet only in upper case, as in Node's test.
    expect(test?.('x/ßςxa')).toBe(true);
    expect(test?.('x/İσaa')).toBe(true);
  });

  it('hands other syntax to Node unchanged', () => {
    expect(listed('src/[ab].ts')).toEqual(['unchanged']);
    expect(listed('src/+(a)')).toEqual(['past-bound']);
  });
});
