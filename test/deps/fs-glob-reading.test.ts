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
    return reading.kind === 'filtered' ? reading.listings.map((listing) => listing.pattern) : [reading.kind];
  };

  it('widens every part with a wildcard and keeps every fixed part', () => {
    expect(listed(`src/${'*a'.repeat(12)}*b`)).toEqual(['src/*']);
    expect(listed('src/**/.a*/x?.tsx')).toEqual(['src/**/.*/*']);
    expect(listed('./src//a/./b/../*.ts')).toEqual(['./src/a/*']);
    expect(listed('a\\*.ts')).toEqual(['a/*']);
  });

  it('expands braces the way Node does and lists each wide pattern once', () => {
    expect(listed('src/{a,b}/*.{ts,tsx}')).toEqual(['src/a/*', 'src/b/*']);
    expect(listed('{x}/k')).toEqual(['{x}/k']);
    expect(listed('${a,b}')).toEqual(['${a,b}']);
    expect(listed('{,a}/x')).toEqual(['past-bound']);
    expect(listed('x{,a}')).toEqual(['x', 'xa']);
  });

  it('also widens fixed parts with a letter on a platform that ignores case', () => {
    expect(listed('src/**', true)).toEqual(['src/**', '*/**']);
    expect(listed('.github/x1/9', true)).toEqual(['.github/x1/9', '.*/*/9']);
  });

  it('keeps a wide listing whole where a dot part follows a wildcard', () => {
    const reading = nodeGlobReading(`src/**/../${'*a'.repeat(3)}`, { nocase: false });
    expect(reading.kind === 'filtered' ? reading.listings : []).toEqual([{ pattern: 'src/**/../*', base: '', matches: null }]);
  });

  it('hands other syntax to Node unchanged', () => {
    expect(listed('src/[ab].ts')).toEqual(['unchanged']);
    expect(listed('src/+(a)')).toEqual(['past-bound']);
  });
});
