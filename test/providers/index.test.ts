import { describe, expect, it, vi } from 'vitest';
import type { Draft, Provider, ProviderContext } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runProviders } from '../../src/providers/index.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

const draft: Draft = {
  rule: 'button-name',
  layer: 'fake',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: SCREEN.id,
  elementPath: 'button:nth-of-type(1)',
  elementName: 'Save',
  role: 'button',
  whatUserExperiences: 'button has no accessible name',
  why: 'screen readers announce button with no label',
  fix: 'add an accessible name',
  evidence: {},
  confidence: 'fail',
};

async function makeContext(): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  return {
    page: await deps.browser.open(SCREEN.url),
    screen: SCREEN,
    config: testConfig(),
  };
}

describe('runProviders', () => {
  it('records capability-denied and does not call a denied provider', async () => {
    const run = vi.fn(async (): Promise<Draft[]> => [draft]);
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run,
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, []);

    expect(run).not.toHaveBeenCalled();
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      ref: 'provider:fake-live',
      state: 'capability-denied',
    });
    expect(result.gaps[0]?.reason).toContain('live');
  });

  it('runs an allowed provider and returns its drafts', async () => {
    const run = vi.fn(async (): Promise<Draft[]> => [draft]);
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run,
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(ctx);
    expect(result.drafts).toEqual([draft]);
    expect(result.gaps).toEqual([]);
  });

  it('records not-covered when a provider throws', async () => {
    const run = vi.fn(async (): Promise<Draft[]> => {
      throw new Error('runner exploded');
    });
    const provider: Provider = {
      id: 'thrower',
      layer: 'fake',
      capabilities: ['live'],
      run,
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(run).toHaveBeenCalledOnce();
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      ref: 'provider:thrower',
      state: 'not-covered',
    });
    expect(result.gaps[0]?.reason).toContain('runner exploded');
  });
});
