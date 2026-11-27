/**
 * A literal guarded entry, such as the requirements folder, is a path, and its name can hold
 * characters Node's glob reads as syntax. The local guard must list what the working tree holds
 * under that exact name: a new untracked file in a requirements folder named `reqs[1]` is a
 * guarded change, never a file of `reqs1`, and a name past the glob reading bound still lists its
 * files. A glob entry keeps the files it matched before. These tests use real git repositories and
 * the real adapters.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deps, FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { checkGuard, computeSessionPins, expandConfigGuardedSet } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);
const posixOnly = process.platform === 'win32' ? it.skip : it;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

async function write(root: string, path: string, text = 'x\n'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** A repository whose committed config names the requirements folder and the guarded paths. */
async function repoWith(config: { requirements?: string; guardedPaths: string[] }, committed: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-literal-'));
  await git(root, ['init', '-q', '--initial-branch=main']);
  await write(root, 'usabl.config.json', JSON.stringify(config) + '\n');
  for (const path of committed) {
    await write(root, path);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function realDeps(root: string, platform: NodeJS.Platform = 'linux'): Deps {
  return { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root, platform }) };
}

// A requirements folder named with each character Node's glob reads as syntax. The last name is
// past the reading bound (two runs of `*` in one part), so Node never ran a pattern that holds it.
const NAMES = ['reqs[1]', 'reqs{a,b}', 'reqs+(x)', 'reqs@(a|b)', 'reqs!(z)', 'reqs*', 'reqs?', 're\\qs', 're[q]*s*x'];

// New untracked files under the folder: a plain one, a dot-named one, one in a dot-named folder,
// and one deep down.
function untrackedUnder(name: string): string[] {
  return [`${name}/new.yaml`, `${name}/.dot.yaml`, `${name}/.hidden/inner.yaml`, `${name}/deep/a/b.yaml`].sort();
}

describe.each(NAMES)('a requirements folder named %s', (name) => {
  let root = '';

  beforeAll(async () => {
    root = await repoWith({ requirements: name, guardedPaths: [] }, [`${name}/old.yaml`, 'src/App.tsx']);
    for (const path of untrackedUnder(name)) {
      await write(root, path);
    }
    // git's own data under the folder is never guarded content.
    await write(root, `${name}/.git/config`);
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  posixOnly('lists every new untracked file in it, on Linux and macOS', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const paths = await expandConfigGuardedSet(realDeps(root, platform), { guardedPaths: [], requirements: name });
      expect(paths, platform).toEqual(
        [`${name}/old.yaml`, ...untrackedUnder(name), '.usabl-evidence.json', '.usabl-waivers.json', 'usabl.config.json', 'usabl.docs.json', 'usabl.routes.json'].sort(),
      );
    }
  });

  posixOnly('reports each new untracked file in it as a guarded change', async () => {
    await expect(checkGuard(realDeps(root))).resolves.toEqual(untrackedUnder(name));
  });

  posixOnly('pins each new untracked file in it, so a file added later in the session is drift', async () => {
    const pins = await computeSessionPins(realDeps(root), { guardedPaths: [], requirements: name } as unknown as UsablConfig);
    for (const path of untrackedUnder(name)) {
      expect(Object.keys(pins)).toContain(path);
    }
  });
});

describe('a requirements folder with glob syntax beside folders whose names differ only in case', { timeout: 60_000 }, () => {
  let root = '';

  beforeAll(async () => {
    root = await repoWith({ requirements: 'reqs[1]', guardedPaths: [] }, ['reqs[1]/old.yaml', 'REQS[1]/old.yaml']);
    await write(root, 'reqs[1]/new.yaml');
    await write(root, 'Reqs[1]/new.yaml');
    await write(root, 'REQS[1]/new.yaml');
    await write(root, 'reqs1/new.yaml');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  posixOnly('guards the folder with the exact name, and no other, on a file system that keeps case', async () => {
    await expect(checkGuard(realDeps(root))).resolves.toEqual(['reqs[1]/new.yaml']);
    for (const platform of ['linux', 'darwin'] as const) {
      const paths = await expandConfigGuardedSet(realDeps(root, platform), { guardedPaths: [], requirements: 'reqs[1]' });
      expect(paths.filter((path) => path.includes('/')), platform).toEqual(['reqs[1]/new.yaml', 'reqs[1]/old.yaml']);
    }
  });
});

describe('a requirements folder with glob syntax replaced on the working tree', { timeout: 60_000 }, () => {
  let root = '';

  beforeAll(async () => {
    root = await repoWith({ requirements: 'reqs[1]', guardedPaths: [] }, ['reqs[1]/old.yaml', 'elsewhere/real.yaml']);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  posixOnly('lists the folder name itself when it is now a link or a file', async () => {
    await rm(join(root, 'reqs[1]'), { recursive: true, force: true });
    await symlink('elsewhere', join(root, 'reqs[1]'));
    const linked = await expandConfigGuardedSet(realDeps(root), { guardedPaths: [], requirements: 'reqs[1]' });
    expect(linked).toContain('reqs[1]');
    expect(linked).toContain('reqs[1]/real.yaml');
    expect(await checkGuard(realDeps(root))).toEqual(expect.arrayContaining(['reqs[1]', 'reqs[1]/old.yaml']));

    await rm(join(root, 'reqs[1]'));
    await write(root, 'reqs[1]', 'a file now\n');
    const filed = await expandConfigGuardedSet(realDeps(root), { guardedPaths: [], requirements: 'reqs[1]' });
    expect(filed).toContain('reqs[1]');
    expect(await checkGuard(realDeps(root))).toEqual(['reqs[1]', 'reqs[1]/old.yaml']);
  });
});

describe('guardedPaths entries whose names hold glob syntax', { timeout: 60_000 }, () => {
  let root = '';
  // `pol{a,b}` is a glob entry (each brace expansion) and, as the requirements folder, a literal
  // path too. `area/pol[1]/x.json` and `zone/+(a)/**` use syntax the guard reads wide, as the
  // folder above it.
  const config = { requirements: 'pol{a,b}', guardedPaths: ['pol{a,b}', 'area/pol[1]/x.json', 'zone/+(a)/**'] };

  beforeAll(async () => {
    root = await repoWith(config, ['pola/old.json', 'area/old.json', 'zone/old.json', 'src/App.tsx']);
    for (const path of ['pol{a,b}/new.json', 'pola/new.json', 'polb/.dot.json', 'polc/new.json', 'area/pol[1]/new.json', 'area/.x/y.json', 'zone/+(a)/new.json', 'zone/other/new.json', 'other/new.json']) {
      await write(root, path);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  posixOnly('guards the literal folder by its name, and what each glob reading matched before', async () => {
    const paths = await expandConfigGuardedSet(realDeps(root), config);
    expect(paths.filter((path) => path.includes('/'))).toEqual(
      ['area/.x/y.json', 'area/old.json', 'area/pol[1]/new.json', 'pol{a,b}/new.json', 'pola/new.json', 'pola/old.json', 'zone/+(a)/new.json', 'zone/old.json', 'zone/other/new.json'].sort(),
    );
    // A glob reading keeps Node's dot rule, so `polb/.dot.json` is not guarded, as the git
    // listings in CI read it. The literal folder `pol{a,b}` no longer lists `polb` as text.
    await expect(checkGuard(realDeps(root))).resolves.toEqual(
      ['area/.x/y.json', 'area/pol[1]/new.json', 'pol{a,b}/new.json', 'pola/new.json', 'zone/+(a)/new.json', 'zone/other/new.json'].sort(),
    );
  });
});

describe('a file reader without the folder listing', { timeout: 60_000 }, () => {
  let root = '';

  beforeAll(async () => {
    root = await repoWith({ requirements: 'reqs[1]', guardedPaths: ['policy'] }, ['reqs[1]/old.yaml', 'policy/old.json']);
    await write(root, 'reqs[1]/new.yaml');
    await write(root, 'policy/new.json');
    await write(root, 'policy/.dot.json');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The real reader less its folder listing, as a wrapper that passes glob through would build it.
  function withoutFolderListing(): Deps {
    const real = makeFsGlob({ cwd: root });
    const { globUnder: _dropped, ...rest } = real;
    const fs: FsGlob = rest;
    return { ...realDeps(root), fs };
  }

  posixOnly('lists a plain name with the patterns, and refuses a name with glob syntax', async () => {
    const deps = withoutFolderListing();
    await expect(expandConfigGuardedSet(deps, { guardedPaths: ['policy'] })).resolves.toEqual(
      expect.arrayContaining(['policy/.dot.json', 'policy/new.json', 'policy/old.json']),
    );
    await expect(expandConfigGuardedSet(deps, { guardedPaths: [], requirements: 'reqs[1]' })).rejects.toThrow(
      /cannot list the guarded path reqs\[1\]/u,
    );
    await expect(checkGuard(deps)).rejects.toThrow(/cannot list the guarded path reqs\[1\]/u);
  });
});
