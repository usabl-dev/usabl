import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { checkGuard, expandGuardedSet } from '../../src/trust/guard.js';

// These tests use the real filesystem adapter so a guarded *directory* prefix
// (like `.github/workflows`) resolves to a real directory on disk. The in-memory
// fake fs has no directories, which is exactly why this class of bug slipped past
// the fake-only guard tests: real glob returns the directory itself, and real
// readFile throws EISDIR on it.

const WORKFLOW_PATH = '.github/workflows/usabl-gate.yml';
const WORKFLOW_BODY = 'name: usabl-gate\n';
const CONFIG_BODY = '{"guardedPaths":[".github/workflows"]}';

const configFixture: UsablConfig = {
  appBaseUrl: 'https://app.example.test',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: ['src/**/*.tsx'] },
  surfaces: [],
  guardedPaths: ['.github/workflows'],
};

describe('trust guard with a real directory guarded path', () => {
  let workspacePath = '';
  let deps: Deps;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'usabl-guard-dir-'));
    await mkdir(join(workspacePath, '.github', 'workflows'), { recursive: true });
    await writeFile(join(workspacePath, WORKFLOW_PATH), WORKFLOW_BODY, 'utf8');
    await writeFile(join(workspacePath, 'usabl.config.json'), CONFIG_BODY, 'utf8');

    // Real fs against the temp workspace, fake git carrying the committed bytes so
    // working tree and HEAD agree (the clean, no-divergence case).
    deps = {
      ...makeFakeDeps({
        headContents: {
          'usabl.config.json': CONFIG_BODY,
          [WORKFLOW_PATH]: WORKFLOW_BODY,
        },
      }),
      fs: makeFsGlob({ cwd: workspacePath }),
    };
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('expandGuardedSet lists files under the directory, never the directory itself', async () => {
    await expect(expandGuardedSet(deps, ['.github/workflows'])).resolves.toEqual([WORKFLOW_PATH]);
  });

  it('checkGuard is clean for an unchanged guarded directory and does not crash on EISDIR', async () => {
    await expect(checkGuard(deps, configFixture)).resolves.toEqual([]);
  });

  it('checkGuard reports a working-tree edit under the guarded directory', async () => {
    await writeFile(join(workspacePath, WORKFLOW_PATH), 'name: tampered\n', 'utf8');

    await expect(checkGuard(deps, configFixture)).resolves.toEqual([WORKFLOW_PATH]);
  });
});
