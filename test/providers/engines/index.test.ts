import { describe, expect, it } from 'vitest';
import { grantCapabilities } from '../../../src/deps/build.js';
import { makeCoreProviders } from '../../../src/providers/core-stack.js';
import { engineCapabilities, makeEngineProviders, readEngineVersions } from '../../../src/providers/engines/index.js';
import type { InstalledPackage } from '../../../src/providers/engines/shared.js';

describe('makeEngineProviders', () => {
  it('adds nothing when engines are absent or turned off', () => {
    expect(makeEngineProviders(undefined)).toEqual([]);
    expect(makeEngineProviders({})).toEqual([]);
    expect(makeEngineProviders({ deque: { enabled: false }, evinced: { enabled: false, mode: 'online' } })).toEqual([]);
    const today = makeCoreProviders().map((provider) => provider.id);
    const withOff = [...makeCoreProviders(), ...makeEngineProviders({ deque: { enabled: false } })];
    expect(withOff.map((provider) => provider.id)).toEqual(today);
  });

  it('adds one provider per turned-on engine, Deque first', () => {
    expect(
      makeEngineProviders({ evinced: { enabled: true }, deque: { enabled: true } }).map((provider) => provider.id),
    ).toEqual(['deque', 'evinced']);
    expect(makeEngineProviders({ evinced: { enabled: true } }).map((provider) => provider.id)).toEqual(['evinced']);
  });
});

describe('engineCapabilities and grantCapabilities', () => {
  it('collects what the turned-on engines declare', () => {
    expect(engineCapabilities(undefined)).toEqual([]);
    expect(engineCapabilities({ deque: { enabled: true } })).toEqual(['live']);
    expect(engineCapabilities({ deque: { enabled: true }, evinced: { enabled: true } })).toEqual(['live', 'secrets']);
    expect(
      engineCapabilities({ deque: { enabled: true, trackUsage: true }, evinced: { enabled: false, mode: 'online' } }),
    ).toEqual(['live', 'network']);
  });

  it('extends a live grant and leaves a static-only grant empty', () => {
    expect(grantCapabilities(['live'], ['live', 'secrets', 'network'])).toEqual(['live', 'secrets', 'network']);
    expect(grantCapabilities(['live'], [])).toEqual(['live']);
    expect(grantCapabilities([], ['live', 'secrets', 'network'])).toEqual([]);
  });
});

describe('readEngineVersions', () => {
  it('is undefined when no engine is on, so receipts keep their earlier shape', async () => {
    expect(await readEngineVersions(undefined)).toBeUndefined();
    expect(await readEngineVersions({ deque: { enabled: false } })).toBeUndefined();
  });

  it('reads the installed package version of each turned-on engine', async () => {
    const versions: Record<string, string> = {
      '@axe-devtools/playwright': '4.11.2',
      '@evinced/js-playwright-sdk': '3.9.0',
    };
    const probe = async (name: string): Promise<InstalledPackage> => {
      const version = versions[name];
      return version === undefined ? { state: 'not-installed' } : { state: 'installed', version, missingDependencies: [] };
    };
    expect(await readEngineVersions({ deque: { enabled: true }, evinced: { enabled: true } }, probe)).toEqual({
      deque: '4.11.2',
      evinced: '3.9.0',
    });
    expect(await readEngineVersions({ evinced: { enabled: true } }, async () => ({ state: 'not-installed' }))).toEqual({
      evinced: 'not-installed',
    });
  });

  it('reads the real tree, where neither vendor package is installed', async () => {
    expect(await readEngineVersions({ deque: { enabled: true }, evinced: { enabled: true } })).toEqual({
      deque: 'not-installed',
      evinced: 'not-installed',
    });
  });
});
