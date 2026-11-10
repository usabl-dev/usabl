/**
 * A guardedPaths entry is matched the same way on the working tree and at every ref, by the local
 * guard and by the CI policy check.
 *
 * The CI check used to list each entry with a literal git pathspec, so a glob entry listed nothing
 * at either ref and an edited guarded file printed "no policy change". The local guard expanded a
 * glob on the working tree only, so a guarded file deleted under a glob entry was not listed. These
 * tests run the local guard through a whole run and the CI check through enforcePolicy, on real git
 * repositories. Only the check runner is scripted.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { computePolicyHash } from '../../src/evidence/receipt.js';
import { run } from '../../src/run.js';
import { enforcePolicy } from '../../src/surfaces/policy-enforce.js';
import { buildGuardedSet, expandGuardedSet } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root: string, path: string, contents: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents, 'utf8');
}

function configWith(guardedPaths: string[]): UsablConfig {
  return {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths,
  };
}

const OWNERS = '* @owner\n';

/** A repository on main with the config, CODEOWNERS, and the given files committed. */
async function repoWith(config: UsablConfig, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-glob-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'core.quotePath', 'true']);
  await write(root, 'usabl.config.json', JSON.stringify(config));
  await write(root, '.github/CODEOWNERS', OWNERS);
  for (const [path, contents] of Object.entries(files)) {
    await write(root, path, contents);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'main']);
  return root;
}

function realDeps(root: string): Deps {
  return { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
}

const verified: Result = {
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: 'verified',
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
};

/** The CI policy check on a feature branch commit, with the trusted ref at main. */
async function policyCheckAt(root: string): Promise<{ exitCode: number; message: string }> {
  const headSha = await git(root, ['rev-parse', 'HEAD']);
  return enforcePolicy(verified, {
    trustedRef: 'main',
    pr: { authorLogin: 'author', headSha },
    git: makeGitReader({ cwd: root }),
    listReviews: async () => [],
  });
}

/**
 * The guard expansion as it was before one matcher, kept here so the new listing can be compared
 * with it: each entry listed with a literal pathspec at the trusted ref, joined with Node's glob of
 * the working tree.
 */
async function previousExpansion(deps: Deps, guardedPaths: string[], trustedRef = 'HEAD'): Promise<string[]> {
  const expanded = new Set<string>();
  for (const entry of guardedPaths) {
    const prefix = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const [trustedFiles, workingFiles] = await Promise.all([
      deps.git.lsFiles(trustedRef, prefix),
      deps.fs.glob([prefix, prefix + '/**']),
    ]);
    if (trustedFiles.length === 0 && workingFiles.length === 0) {
      expanded.add(entry);
      continue;
    }
    for (const path of [...trustedFiles, ...workingFiles]) {
      expanded.add(path);
    }
  }
  return [...expanded].sort();
}

// Each test spawns a few dozen git processes, which takes more than the default five seconds on a
// busy machine.
const REAL_GIT = { timeout: 30_000 };

const GLOB_CONFIG = configWith(['policy/*.json']);
const GLOB_FILES = { 'policy/rules.json': '{"rules":1}\n', 'src/App.tsx': 'export {}\n' };

describe('the local guard with a glob entry, through a run', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports an edited guarded file as a policy change', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    await write(root, 'policy/rules.json', '{"rules":0}\n');
    const result = await run(realDeps(root), GLOB_CONFIG);
    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toEqual(['policy/rules.json']);
  });

  it('reports an added guarded file as a policy change', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    await write(root, 'policy/extra.json', '{"rules":0}\n');
    const result = await run(realDeps(root), GLOB_CONFIG);
    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toEqual(['policy/extra.json']);
  });

  it('reports a deleted guarded file as a policy change', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    await unlink(join(root, 'policy/rules.json'));
    const result = await run(realDeps(root), GLOB_CONFIG);
    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toEqual(['policy/rules.json']);
  });

  it('reads a clean tree as no policy change', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    const result = await run(realDeps(root), GLOB_CONFIG);
    expect(result.dirtyGuardedPaths).toEqual([]);
  });
});

describe('the CI policy check with a glob entry', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function featureCommit(change: (root: string) => Promise<void>): Promise<void> {
    await git(root, ['checkout', '-b', 'feature']);
    await change(root);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'change policy']);
  }

  it('refuses an edited guarded file', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    await featureCommit((r) => write(r, 'policy/rules.json', '{"rules":0}\n'));
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('policy/rules.json');
  });

  it('refuses an added guarded file', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    await featureCommit((r) => write(r, 'policy/extra.json', '{"rules":0}\n'));
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('policy/extra.json');
  });

  it('refuses a deleted guarded file', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    await featureCommit((r) => unlink(join(r, 'policy/rules.json')));
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('policy/rules.json');
  });

  it('passes a branch that changes no guarded file', async () => {
    root = await repoWith(GLOB_CONFIG, GLOB_FILES);
    await featureCommit((r) => write(r, 'src/App.tsx', 'export const changed = 1\n'));
    await expect(policyCheckAt(root)).resolves.toEqual({ exitCode: 0, message: 'no policy change' });
  });
});

describe('literal, folder, and non-ASCII entries behave as before', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const config = configWith(['src/gate/', 'src/run.ts']);
  const files = {
    'src/gate/index.ts': 'gate\n',
    'src/gate/Über.ts': 'umlaut\n',
    'src/run.ts': 'run\n',
    'src/App.tsx': 'export {}\n',
  };

  it('lists a folder file with a non-ASCII name by its true name, locally and in CI', async () => {
    root = await repoWith(config, files);
    await write(root, 'src/gate/Über.ts', 'changed\n');
    const local = await run(realDeps(root), config);
    expect(local.dirtyGuardedPaths).toEqual(['src/gate/Über.ts']);

    await git(root, ['checkout', '-b', 'feature']);
    await git(root, ['commit', '-am', 'change the gate']);
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('src/gate/Über.ts');
  });

  it('lists an edited literal file entry, locally and in CI', async () => {
    root = await repoWith(config, files);
    await write(root, 'src/run.ts', 'changed\n');
    const local = await run(realDeps(root), config);
    expect(local.dirtyGuardedPaths).toEqual(['src/run.ts']);

    await git(root, ['checkout', '-b', 'feature']);
    await git(root, ['commit', '-am', 'change run']);
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('src/run.ts');
  });

  it('lists the same files as before for a clean tree', async () => {
    root = await repoWith(config, files);
    const deps = realDeps(root);
    const entries = buildGuardedSet(config);
    const before = await previousExpansion(deps, entries);
    const after = await expandGuardedSet(deps, entries);
    expect(after).toEqual(before);
  });
});

describe('the policy hash for a repository with plain ASCII names', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not change for literal, folder, and glob entries, dot-named files included', async () => {
    const config = configWith(['src/gate/', 'src/run.ts', 'policy/*.json', 'rules/**']);
    root = await repoWith(config, {
      'src/gate/index.ts': 'gate\n',
      'src/gate/.hidden.ts': 'hidden\n',
      'src/run.ts': 'run\n',
      'policy/rules.json': '{}\n',
      'policy/.dot.json': '{}\n',
      'rules/a/b.yml': 'b\n',
      'rules/.private/c.yml': 'c\n',
      'src/App.tsx': 'export {}\n',
    });
    const deps = realDeps(root);
    const entries = buildGuardedSet(config);
    const before = await previousExpansion(deps, entries);
    const after = await expandGuardedSet(deps, entries);
    for (const path of before) {
      expect(after).toContain(path);
    }
    expect(await computePolicyHash(deps, after)).toBe(await computePolicyHash(deps, before));
  });
});

/**
 * The CI listing as it was before one matcher: each entry listed with a literal pathspec at both
 * refs, the raw entry kept when neither lists a file, and each path compared at the two refs.
 */
async function previousCiDiverged(root: string, guardedPaths: string[]): Promise<string[]> {
  const g = makeGitReader({ cwd: root });
  const expanded = new Set<string>();
  for (const entry of guardedPaths) {
    const prefix = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const [trustedFiles, workingFiles] = await Promise.all([g.lsFiles('main', prefix), g.lsFiles('HEAD', prefix)]);
    if (trustedFiles.length === 0 && workingFiles.length === 0) {
      expanded.add(entry);
      continue;
    }
    for (const path of [...trustedFiles, ...workingFiles]) {
      expanded.add(path);
    }
  }
  const diverged: string[] = [];
  for (const path of expanded) {
    const [working, trusted] = await Promise.all([g.show('HEAD', path), g.show('main', path)]);
    if (working === null && trusted === null) {
      continue;
    }
    if (working !== trusted) {
      diverged.push(path);
    }
  }
  return diverged.sort();
}

/**
 * Entries config load accepts that git never prints in that form: a leading `./`, a repeated or a
 * trailing `/`, and `.` for the whole tree. Each is read in its one canonical form, so it guards
 * what the canonical entry guards, in CI and in the local guard.
 */
describe('a guardedPaths entry that is not in canonical form', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = {
    'src/gate/index.ts': 'gate\n',
    'src/gate/b.ts': 'b\n',
    'policy/rules.json': '{}\n',
    'policy/b.json': '{}\n',
    'src/App.tsx': 'export {}\n',
  };

  interface Case {
    entry: string;
    edit: string;
    add: string;
    remove: string;
    // A change outside the entry, or null when the entry is the whole tree.
    elsewhere: string | null;
  }

  const gateCase = (entry: string): Case => ({
    entry,
    edit: 'src/gate/index.ts',
    add: 'src/gate/extra.ts',
    remove: 'src/gate/b.ts',
    elsewhere: 'src/App.tsx',
  });
  const cases: Case[] = [
    gateCase('./src/gate/'),
    gateCase('src/gate//'),
    { ...gateCase('.'), elsewhere: null },
    {
      entry: './policy/*.json',
      edit: 'policy/rules.json',
      add: 'policy/extra.json',
      remove: 'policy/b.json',
      elsewhere: 'src/App.tsx',
    },
  ];

  async function onFeature(change: (r: string) => Promise<void>): Promise<void> {
    await git(root, ['checkout', '-b', 'feature']);
    await change(root);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'change']);
  }

  for (const c of cases) {
    const config = configWith([c.entry]);
    const changes: Array<[string, string, (r: string) => Promise<void>]> = [
      ['an edit', c.edit, (r) => write(r, c.edit, 'changed\n')],
      ['an add', c.add, (r) => write(r, c.add, 'added\n')],
      ['a delete', c.remove, (r) => unlink(join(r, c.remove))],
    ];

    for (const [label, path, change] of changes) {
      it(`lists ${label} under ${c.entry} in the local guard`, async () => {
        root = await repoWith(config, files);
        await change(root);
        const result = await run(realDeps(root), config);
        expect(result.dirtyGuardedPaths).toEqual([path]);
      });

      it(`refuses ${label} under ${c.entry} in CI`, async () => {
        root = await repoWith(config, files);
        await onFeature(change);
        const out = await policyCheckAt(root);
        expect(out.exitCode).toBe(2);
        expect(out.message).toContain(path);
      });

      it(`lists at least what the previous guard listed for ${label} under ${c.entry}`, async () => {
        root = await repoWith(config, files);
        const entries = buildGuardedSet(config);
        await change(root);
        const deps = realDeps(root);
        const before = await previousExpansion(deps, entries);
        const after = await expandGuardedSet(deps, entries);
        // The previous expansion kept an entry that listed nothing as its own text. That text is
        // not a file, so only the files it listed are compared.
        for (const listed of before.filter((p) => !entries.includes(p))) {
          expect(after).toContain(listed);
        }
        await git(root, ['checkout', '-b', 'feature']);
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-m', 'change']);
        const ciBefore = (await previousCiDiverged(root, entries)).filter((p) => !entries.includes(p));
        const ci = await policyCheckAt(root);
        for (const diverged of ciBefore) {
          expect(ci.message).toContain(diverged);
        }
      });
    }

    if (c.elsewhere !== null) {
      const elsewhere = c.elsewhere;
      if (c.entry === './src/gate/') {
        // A `.` or `..` segment inside the entry is read the way git reads it in a pathspec.
        for (const entry of ['src/./gate/', 'src/x/../gate']) {
          it(`lists an edit under ${entry}, locally and in CI`, async () => {
            const inner = configWith([entry]);
            root = await repoWith(inner, files);
            await write(root, 'src/gate/index.ts', 'changed\n');
            expect((await run(realDeps(root), inner)).dirtyGuardedPaths).toEqual(['src/gate/index.ts']);
            await git(root, ['checkout', '-b', 'feature']);
            await git(root, ['commit', '-am', 'change']);
            const out = await policyCheckAt(root);
            expect(out.exitCode).toBe(2);
            expect(out.message).toContain('src/gate/index.ts');
          });
        }
      }
      it(`does not list a change outside ${c.entry} in the local guard`, async () => {
        root = await repoWith(config, files);
        await write(root, elsewhere, 'export const changed = 1\n');
        const result = await run(realDeps(root), config);
        expect(result.dirtyGuardedPaths).toEqual([]);
      });

      it(`reads a change outside ${c.entry} as no policy change in CI`, async () => {
        root = await repoWith(config, files);
        await onFeature((r) => write(r, elsewhere, 'export const changed = 1\n'));
        await expect(policyCheckAt(root)).resolves.toEqual({ exitCode: 0, message: 'no policy change' });
      });
    }
  }
});

describe("this repository's own config", REAL_GIT, () => {
  it('lists every file the previous expansion listed, with the same policy hash', async () => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const raw = await readFile(join(repoRoot, 'usabl.config.json'), 'utf8');
    const entries = buildGuardedSet(JSON.parse(raw) as Parameters<typeof buildGuardedSet>[0]);
    const deps = realDeps(repoRoot);
    const before = await previousExpansion(deps, entries);
    const after = await expandGuardedSet(deps, entries);
    for (const path of before) {
      expect(after).toContain(path);
    }
    expect(after.length).toBeGreaterThan(entries.length);
    expect(await computePolicyHash(deps, after)).toBe(await computePolicyHash(deps, before));
  });
});
