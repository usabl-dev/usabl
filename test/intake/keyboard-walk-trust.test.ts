/**
 * The keyboard walk settings live in usabl.config.json, a guarded file, so a pull request cannot
 * set its own. They are no new policy input: under a trusted ref the walk reads them from the
 * trusted config the same way intake reads the rest of it, a trusted ref with no readable config
 * drops them, and the judge drops them from the head's copy. A pull request that edits them edits a
 * guarded file and needs approval.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GitReader, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { withoutRuntimeSettings } from '../../src/judge/prepare.js';
import { resolveIntakeConfig } from '../../src/intake/trusted-config.js';
import { run } from '../../src/run.js';
import { testConfig } from '../helpers.js';

function withWalk(config: UsablConfig, tabCap: number): UsablConfig {
  return { ...config, keyboardWalk: { perSurface: { clusters: { tabCap } } } };
}

function gitWith(contents: Record<string, string>): Pick<GitReader, 'show'> {
  return { show: vi.fn(async (_ref: string, path: string) => contents[path] ?? null) };
}

describe('the keyboard walk settings and the trusted ref', () => {
  it('are read from the trusted config, not from the pull request, under a trusted ref', async () => {
    const trusted = withWalk(testConfig(), 300);
    const head = withWalk(testConfig(), 2000);

    const resolved = await resolveIntakeConfig(gitWith({ 'usabl.config.json': JSON.stringify(trusted) }), head, 'origin/main');

    expect(resolved.keyboardWalk?.perSurface?.['clusters']).toEqual({ tabCap: 300 });
  });

  it('are left out when the trusted ref has no config, so the head cannot set its own', async () => {
    const head = withWalk(testConfig(), 2000);

    const missing = await resolveIntakeConfig(gitWith({}), head, 'origin/main');
    const unreadable = await resolveIntakeConfig(gitWith({ 'usabl.config.json': '{ not json' }), head, 'origin/main');

    expect(missing.keyboardWalk).toBeUndefined();
    expect(unreadable.keyboardWalk).toBeUndefined();
  });

  it('are read from the working tree when there is no trusted ref, as the rest of the config is', async () => {
    const working = withWalk(testConfig(), 300);

    expect((await resolveIntakeConfig(gitWith({}), working, undefined)).keyboardWalk).toEqual(working.keyboardWalk);
  });

  it('are taken out of the head copy the judge plans from when the trusted ref has no config', () => {
    expect(withoutRuntimeSettings(withWalk(testConfig(), 2000)).keyboardWalk).toBeUndefined();
  });

  it('make a pull request that edits them need approval, as any edit to the guarded config does', async () => {
    const before = JSON.stringify(testConfig());
    const after = JSON.stringify(withWalk(testConfig(), 2000));
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': after },
      headContents: { 'usabl.config.json': before },
      changed: [{ code: 'M', path: 'usabl.config.json' }],
    });

    const result = await run(deps, withWalk(testConfig(), 2000));

    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toEqual(['usabl.config.json']);
  });
});
