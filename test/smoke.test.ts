import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs vitest and TypeScript', () => {
    const doubled: number = [1, 2, 3].reduce((a, b) => a + b, 0);
    expect(doubled).toBe(6);
  });
});
