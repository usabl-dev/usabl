import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { sha256 } from '../../src/primitives/canonical.js';
import {
  buildGuardedSet,
  checkGuard,
  computeSessionPins,
  diffSessionPins,
  expandGuardedSet,
  MAX_BRACE_EXPANSIONS,
  readGuardedEntry,
  readWideNotice,
} from '../../src/trust/guard.js';

const configFixture: UsablConfig = {
  appBaseUrl: 'https://app.example.test',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: ['src/**/*.tsx'] },
  surfaces: [],
  requirements: 'requirements/',
  guardedPaths: ['usabl.config.json', 'src/gate'],
};

describe('trust guard', () => {
  it('buildGuardedSet keeps unconditional policy files even when guardedPaths is empty', () => {
    expect(buildGuardedSet({ ...configFixture, guardedPaths: [] })).toEqual([
      '.usabl-evidence.json',
      '.usabl-waivers.json',
      'requirements/',
      'usabl.config.json',
      'usabl.docs.json',
      'usabl.routes.json',
    ]);
  });

  it('buildGuardedSet always guards the docs manifest', () => {
    expect(buildGuardedSet({ ...configFixture, guardedPaths: [] })).toContain('usabl.docs.json');
  });

  it('expandGuardedSet expands directory entries from HEAD and the working tree', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"ok":true}',
        'src/gate/index.ts': 'safe',
        'src/gate/new-module.ts': 'new file',
      },
      headContents: {
        'usabl.config.json': '{"ok":true}',
        'src/gate/index.ts': 'safe',
      },
    });

    await expect(expandGuardedSet(deps, ['usabl.config.json', 'src/gate'])).resolves.toEqual([
      'src/gate/index.ts',
      'src/gate/new-module.ts',
      'usabl.config.json',
    ]);
  });

  it('checkGuard returns clean when guarded bytes match HEAD', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'safe',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'safe',
      },
    });

    await expect(checkGuard(deps, configFixture)).resolves.toEqual([]);
  });

  it('checkGuard lists every dirty guarded file even when config also diverged', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"guardedPaths":[]}',
        'src/gate/index.ts': 'backdoored',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'safe',
      },
    });

    await expect(checkGuard(deps, { ...configFixture, guardedPaths: [] })).resolves.toEqual([
      'src/gate/index.ts',
      'usabl.config.json',
    ]);
  });

  it('checkGuard rejects a committed config change against the trusted base', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"guardedPaths":[]}',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":[]}',
      },
      refContents: {
        'origin/main': {
          'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        },
      },
    });

    await expect(checkGuard(deps, { ...configFixture, guardedPaths: [] }, 'origin/main')).resolves.toEqual([
      'usabl.config.json',
    ]);
  });

  it('checkGuard builds guarded paths from verified config bytes, not caller memory', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'backdoored',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'safe',
      },
    });

    await expect(checkGuard(deps, { ...configFixture, guardedPaths: [] })).resolves.toEqual([
      'src/gate/index.ts',
    ]);
  });

  it('checkGuard treats non-object config bytes as config divergence', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '[]',
      },
      headContents: {
        'usabl.config.json': '[]',
      },
    });

    await expect(checkGuard(deps, configFixture)).resolves.toEqual(['usabl.config.json']);
  });

  it('checkGuard reports a modified file under a guarded directory', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'backdoored',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'safe',
      },
    });

    await expect(checkGuard(deps, configFixture)).resolves.toEqual(['src/gate/index.ts']);
  });

  it('checkGuard reports a new file under a guarded directory', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'safe',
        'src/gate/backdoor.ts': 'new behavior',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'safe',
      },
    });

    await expect(checkGuard(deps, configFixture)).resolves.toEqual(['src/gate/backdoor.ts']);
  });

  it('computeSessionPins uses committed bytes and diffSessionPins reports changed or appeared paths', async () => {
    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'working copy',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":["src/gate"]}',
        'src/gate/index.ts': 'committed',
      },
    });

    const previous = await computeSessionPins(deps, configFixture);
    const next = {
      ...previous,
      'src/gate/index.ts': sha256('changed'),
      'src/gate/new-module.ts': sha256('new'),
    };

    expect(previous['src/gate/index.ts']).toBe(sha256('committed'));
    expect(previous['.usabl-evidence.json']).toBe(sha256(''));
    expect(diffSessionPins(previous, next)).toEqual(['src/gate/index.ts', 'src/gate/new-module.ts']);
  });
});

describe('a guardedPaths entry with an empty brace expansion', () => {
  // `{,}` expands to two empty paths, which the guard reads as the whole tree. The entry does not
  // say so, so the guard reads it wide, and the policy check and doctor name it.
  it('reads an expansion that names the repository root wide', () => {
    for (const entry of ['{,}', '{,}/', '.{,}']) {
      const readings = readGuardedEntry(entry);
      expect(readings.length, entry).toBeGreaterThan(0);
      for (const reading of readings) {
        expect(reading, entry).toEqual({ text: entry, path: '', glob: false, readWide: expect.any(String) });
      }
      expect(readWideNotice(readings[0]!), entry).toContain('as the whole repository');
    }
  });

  it('reads only the empty expansion wide when the others name a path', () => {
    expect(readGuardedEntry('{,policy}')).toEqual([
      { text: '{,policy}', path: '', glob: false, readWide: expect.any(String) },
      { text: '{,policy}', path: 'policy', glob: true, readWide: null },
    ]);
    expect(readGuardedEntry('policy/{rules.json,}').every((reading) => reading.readWide === null)).toBe(true);
  });
});

/**
 * Each brace expansion is one reading, and the local guard lists the working tree once per reading.
 * An entry with 16 brace groups has 65,536 readings and took about 31 seconds, so a Stop hook could
 * time out and the assistant then lets the stop through. Past a fixed count the guard reads the
 * entry wide instead, and never drops an expansion.
 */
describe('a guardedPaths entry with many brace expansions', () => {
  const CAP = 256;
  const alternatives = (count: number): string => Array.from({ length: count }, (_, i) => `f${i}`).join(',');

  it('caps the expansions of one entry at 256', () => {
    expect(MAX_BRACE_EXPANSIONS).toBe(CAP);
  });

  it('reads an entry at the cap one expansion at a time', () => {
    const readings = readGuardedEntry(`policy/{${alternatives(CAP)}}.json`);
    expect(readings).toHaveLength(CAP);
    expect(readings.every((reading) => reading.readWide === null)).toBe(true);
    expect(readings[0]).toEqual({ text: `policy/{${alternatives(CAP)}}.json`, path: 'policy/f0.json', glob: true, readWide: null });
  });

  it('reads an entry one past the cap as the folder above its first brace group, and names it', () => {
    const entry = `policy/sub/x{${alternatives(CAP + 1)}}.json`;
    const readings = readGuardedEntry(entry);
    expect(readings).toEqual([{ text: entry, path: 'policy/sub', glob: false, readWide: expect.any(String) }]);
    const notice = readWideNotice(readings[0]!);
    expect(notice).toContain('as the folder policy/sub/');
    expect(notice).toContain('more than 256');
  });

  it('reads an entry far past the cap wide without building its expansions', () => {
    const entry = 'policy/' + '{a,b}'.repeat(64) + '.json';
    expect(readGuardedEntry(entry)).toEqual([{ text: entry, path: 'policy', glob: false, readWide: expect.any(String) }]);
  });

  it('reads a bad brace far past the cap wide without building its expansions', () => {
    for (const entry of ['policy/' + '{a,b}'.repeat(64) + '{c', 'policy/' + '{a,b}'.repeat(64) + '{c,{d,e}}']) {
      expect(readGuardedEntry(entry), entry).toEqual([
        { text: entry, path: 'policy', glob: false, readWide: expect.any(String) },
      ]);
    }
  });

  it('reads the whole tree past the cap when no folder holds every expansion', () => {
    const groups = '{a,b}'.repeat(9);
    const entries = [
      groups,
      `x${groups}/y.json`,
      `/policy/${groups}`,
      `policy/*/../${groups}`,
      `policy/${groups}/../../x.json`,
      `policy/{.,a}{.,b}${groups}`,
      `policy/x/.{,a}.${groups}`,
      `policy/x/..{,a}${groups}`,
    ];
    for (const entry of entries) {
      expect(readGuardedEntry(entry), entry).toEqual([{ text: entry, path: '', glob: false, readWide: expect.any(String) }]);
    }
  });
});
