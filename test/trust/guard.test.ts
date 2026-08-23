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
      'usabl.routes.json',
    ]);
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

  it('checkGuard short-circuits on a tampered working-tree config before trusting config contents', async () => {
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
      'usabl.config.json',
    ]);
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
