import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../../src/deps/fs-glob-reading.js';

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and keeps the rest of the name', () => {
    expect(trimTrailingSlashes('packages/ui///')).toBe('packages/ui');
    expect(trimTrailingSlashes('packages/ui')).toBe('packages/ui');
    expect(trimTrailingSlashes('a//b/')).toBe('a//b');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('reads a long run of slashes that is not at the end in linear time', () => {
    const name = `a${'/'.repeat(200_000)}b`;
    const started = performance.now();
    expect(trimTrailingSlashes(name)).toBe(name);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
