import { describe, expect, it } from 'vitest';
import { compileCodeownersPattern } from '../../src/primitives/match-codeowners.js';

function matches(pattern: string, path: string): boolean {
  const compiled = compileCodeownersPattern(pattern);
  if (!compiled.ok) {
    throw new Error(`${pattern} was refused: ${compiled.reason}`);
  }
  return compiled.match(path);
}

describe('compileCodeownersPattern', () => {
  it('matches a leading-slash directory against git paths beneath it', () => {
    expect(matches('/src/gate/', 'src/gate/index.ts')).toBe(true);
    expect(matches('/src/gate/', 'src/gate/nested/deep.ts')).toBe(true);
  });

  it('matches a leading-slash file against that exact git path', () => {
    expect(matches('/src/run.ts', 'src/run.ts')).toBe(true);
    expect(matches('/usabl.config.json', 'usabl.config.json')).toBe(true);
  });

  it('anchors a leading slash at the repository root', () => {
    expect(matches('/src/gate/', 'vendor/src/gate/index.ts')).toBe(false);
    expect(matches('/src/run.ts', 'vendor/src/run.ts')).toBe(false);
  });

  it('does not let a directory pattern spill into a sibling with the same prefix', () => {
    expect(matches('/src/gate/', 'src/gateway/index.ts')).toBe(false);
  });

  it('owns everything under a path even without a trailing slash', () => {
    expect(matches('/src/gate', 'src/gate/index.ts')).toBe(true);
  });

  it('treats a slash-free pattern as any-depth, the way gitignore does', () => {
    expect(matches('.usabl-evidence.json', '.usabl-evidence.json')).toBe(true);
    expect(matches('.usabl-evidence.json', 'state/.usabl-evidence.json')).toBe(true);
    expect(matches('*', 'src/gate/index.ts')).toBe(true);
  });

  it('keeps a single star inside one path segment', () => {
    expect(matches('/src/*.ts', 'src/run.ts')).toBe(true);
    expect(matches('/src/*.ts', 'src/gate/index.ts')).toBe(false);
  });

  it('refuses patterns it cannot interpret rather than matching nothing', () => {
    for (const pattern of ['src/**/*.ts', '!src/gate/', 'src/[ab].ts', 'src/a\\ b.ts', '/', 'src//gate']) {
      const compiled = compileCodeownersPattern(pattern);
      expect(compiled.ok, pattern).toBe(false);
    }
  });
});
