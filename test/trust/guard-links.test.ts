/**
 * A guarded symbolic link is compared by its link text and by what it resolves to inside the
 * repository, followed through at most 8 links. Every consumer of a guarded file reads through the
 * link, so a pull request that edits only the target must not read as unchanged. A link that
 * resolves outside the repository, loops, or cannot be resolved compares as changed. These tests
 * use real git repositories and the real file reader in temporary folders.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { checkGuard, computeSessionPins, diffSessionPins, guardScopeAtRefs } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root: string, path: string, contents: string | Buffer): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents);
}

const LINK = 'policy/waivers.json';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['policy'],
};

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-links-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await write(root, 'usabl.config.json', JSON.stringify(config));
  await write(root, 'src/App.tsx', 'export {}\n');
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function realDeps(root: string): Deps {
  return { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
}

// The setups. Each builds the trusted commit, and `edit` makes the pull request's change, which
// never touches the guarded link itself.
interface Setup {
  label: string;
  build: (root: string) => Promise<void>;
  edit: (root: string) => Promise<void>;
}

const setups: Setup[] = [
  {
    label: 'a guarded link to an unguarded file, when the pull request edits the file',
    build: async (root) => {
      await write(root, 'data/waivers.json', '{"waivers":[]}');
      await mkdir(join(root, 'policy'), { recursive: true });
      await symlink('../data/waivers.json', join(root, LINK));
    },
    edit: async (root) => {
      await write(root, 'data/waivers.json', '{"waivers":["everything"]}');
    },
  },
  {
    label: 'a chain of two links, when the pull request edits the last target',
    build: async (root) => {
      await write(root, 'data/real.json', '{"waivers":[]}');
      await symlink('real.json', join(root, 'data/link.json'));
      await mkdir(join(root, 'policy'), { recursive: true });
      await symlink('../data/link.json', join(root, LINK));
    },
    edit: async (root) => {
      await write(root, 'data/real.json', '{"waivers":["everything"]}');
    },
  },
  {
    label: 'a link through a linked folder, when the pull request edits the file',
    build: async (root) => {
      await write(root, 'store/waivers.json', '{"waivers":[]}');
      await symlink('store', join(root, 'data'));
      await mkdir(join(root, 'policy'), { recursive: true });
      await symlink('../data/waivers.json', join(root, LINK));
    },
    edit: async (root) => {
      await write(root, 'store/waivers.json', '{"waivers":["everything"]}');
    },
  },
];

describe('a guarded symbolic link is compared by what it resolves to', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const setup of setups) {
    it(`${setup.label}: the local guard reports the link, before and after the commit`, async () => {
      root = await repo();
      await setup.build(root);
      const trusted = await commit(root, 'trusted');
      await setup.edit(root);
      await expect(checkGuard(realDeps(root), trusted)).resolves.toEqual([LINK]);
      await commit(root, 'head');
      await expect(checkGuard(realDeps(root), trusted)).resolves.toEqual([LINK]);
    });

    it(`${setup.label}: the CI policy check reports the link`, async () => {
      root = await repo();
      await setup.build(root);
      const trusted = await commit(root, 'trusted');
      await setup.edit(root);
      const head = await commit(root, 'head');
      expect((await guardScopeAtRefs(makeGitReader({ cwd: root }), trusted, head)).diverged).toEqual([LINK]);
    });

    it(`${setup.label}: the session pins report the link`, async () => {
      root = await repo();
      await setup.build(root);
      await commit(root, 'trusted');
      const deps = realDeps(root);
      const before = await computeSessionPins(deps, config);
      await setup.edit(root);
      await commit(root, 'head');
      expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([LINK]);
    });

    it(`${setup.label}: nothing is reported when nothing changed`, async () => {
      root = await repo();
      await setup.build(root);
      const trusted = await commit(root, 'trusted');
      const deps = realDeps(root);
      const before = await computeSessionPins(deps, config);
      await write(root, 'src/App.tsx', 'export const changed = true\n');
      const head = await commit(root, 'a screen only');
      await expect(checkGuard(deps, trusted)).resolves.toEqual([]);
      expect((await guardScopeAtRefs(deps.git, trusted, head)).diverged).toEqual([]);
      expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([]);
    });
  }

  const unresolvable: Array<[string, (root: string) => Promise<void>]> = [
    [
      'a link loop',
      async (root) => {
        await mkdir(join(root, 'data'), { recursive: true });
        await symlink('b.json', join(root, 'data/a.json'));
        await symlink('a.json', join(root, 'data/b.json'));
        await mkdir(join(root, 'policy'), { recursive: true });
        await symlink('../data/a.json', join(root, LINK));
      },
    ],
    [
      'a link out of the repository',
      async (root) => {
        await mkdir(join(root, 'policy'), { recursive: true });
        await symlink('../../outside.json', join(root, LINK));
      },
    ],
    [
      'a link to an absolute path',
      async (root) => {
        await mkdir(join(root, 'policy'), { recursive: true });
        await symlink('/etc/hostname', join(root, LINK));
      },
    ],
    [
      'a link to nothing',
      async (root) => {
        await mkdir(join(root, 'policy'), { recursive: true });
        await symlink('../data/missing.json', join(root, LINK));
      },
    ],
  ];

  for (const [label, build] of unresolvable) {
    it(`${label} compares as changed in the local guard and the CI policy check, even when nothing changed`, async () => {
      root = await repo();
      await build(root);
      const trusted = await commit(root, 'trusted');
      await write(root, 'src/App.tsx', 'export const changed = true\n');
      const head = await commit(root, 'a screen only');
      const deps = realDeps(root);
      await expect(checkGuard(deps, trusted)).resolves.toEqual([LINK]);
      expect((await guardScopeAtRefs(deps.git, trusted, head)).diverged).toEqual([LINK]);
    });
  }

  it('a chain longer than 8 links compares as changed', async () => {
    root = await repo();
    await write(root, 'data/l9.json', 'end');
    for (let i = 8; i >= 1; i -= 1) {
      await symlink(`l${String(i + 1)}.json`, join(root, `data/l${String(i)}.json`));
    }
    await mkdir(join(root, 'policy'), { recursive: true });
    // The guarded link is the first of nine links before the file.
    await symlink('../data/l1.json', join(root, LINK));
    const trusted = await commit(root, 'trusted');
    await expect(checkGuard(realDeps(root), trusted)).resolves.toEqual([LINK]);
  });
});
