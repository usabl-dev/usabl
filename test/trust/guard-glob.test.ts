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
import { buildGuardedSet, checkGuard, expandConfigGuardedSet, expandGuardedSet } from '../../src/trust/guard.js';

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
    readPermission: async () => ({ permission: 'write' }),
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

/** The CI policy check with these reviews of the head commit. */
async function policyCheckWith(
  root: string,
  reviewers: string[],
): Promise<{ exitCode: number; message: string }> {
  const headSha = await git(root, ['rev-parse', 'HEAD']);
  return enforcePolicy(verified, {
    trustedRef: 'main',
    pr: { authorLogin: 'author', headSha },
    git: makeGitReader({ cwd: root }),
    listReviews: async () => reviewers.map((userLogin) => ({ userLogin, state: 'APPROVED', commitId: headSha })),
    readPermission: async () => ({ permission: 'write' }),
  });
}

/**
 * Config load refuses these forms, but the guard also reads the trusted ref's config, which config
 * load never checked, and every earlier release accepted a brace range. Node's glob expands a range
 * and `?`, and the guard's matcher does not, so such an entry used to match nothing in CI. The
 * guard never throws on such an entry and never guards less: it guards the literal folder above the
 * first segment it cannot evaluate, or the whole tree when there is none, and the policy check
 * names the entry. A change there needs a code owner's approval, which a review can give.
 */
describe('a guardedPaths entry the guard cannot evaluate', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = { 'policy/rule1.json': '{}\n', 'policy/rule2.json': '{}\n', 'src/App.tsx': 'export {}\n' };

  // [entry, the folder it is read as ('' is the whole tree)]
  const cases: Array<[string, string]> = [
    ['policy/rule{1..3}.json', 'policy'],
    ['policy/{q..s}ule1.json', 'policy'],
    ['policy/rule?.json', 'policy'],
    ['policy/*/../rule1.json', ''],
    ['/policy/rule1.json', ''],
    ['../policy/rule1.json', ''],
  ];

  for (const [entry, folder] of cases) {
    const config = configWith([entry]);

    it(`reads ${entry} wide in CI: approval required, named, and clearable by an owner`, async () => {
      root = await repoWith(config, files);
      await git(root, ['checkout', '-b', 'feature']);
      await write(root, 'policy/rule1.json', '{"changed":true}\n');
      await git(root, ['commit', '-am', 'change a rule']);
      const refused = await policyCheckAt(root);
      expect(refused.exitCode).toBe(2);
      expect(refused.message).toContain('policy/rule1.json');
      expect(refused.message).toContain(`guardedPaths entry "${entry}"`);
      expect(refused.message).toContain(folder === '' ? 'the whole repository' : `the folder ${folder}/`);
      const approved = await policyCheckWith(root, ['owner']);
      expect(approved.exitCode).toBe(0);
      expect(approved.message).toContain(`guardedPaths entry "${entry}"`);
    });

    it(`reads ${entry} wide in the local guard`, async () => {
      root = await repoWith(config, files);
      await write(root, 'policy/rule1.json', '{"changed":true}\n');
      const result = await run(realDeps(root), config);
      expect(result.verdict).toBe('approval_required');
      expect(result.dirtyGuardedPaths).toEqual(['policy/rule1.json']);
    });
  }

  it('reads a change outside the folder as no policy change, and still names the entry', async () => {
    root = await repoWith(configWith(['policy/rule{1..3}.json']), files);
    await git(root, ['checkout', '-b', 'feature']);
    await write(root, 'src/App.tsx', 'export const changed = 1\n');
    await git(root, ['commit', '-am', 'change the app']);
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(0);
    expect(out.message).toMatch(/^no policy change/);
    expect(out.message).toContain('guardedPaths entry "policy/rule{1..3}.json"');
  });

  it('lets the pull request that repairs the entry pass with an owner approval', async () => {
    root = await repoWith(configWith(['policy/rule{1..3}.json']), files);
    await git(root, ['checkout', '-b', 'feature']);
    await write(root, 'usabl.config.json', JSON.stringify(configWith(['policy/rule1.json', 'policy/rule2.json'])));
    await git(root, ['commit', '-am', 'list the rules with commas']);
    const refused = await policyCheckAt(root);
    expect(refused.exitCode).toBe(2);
    expect(refused.message).toContain('usabl.config.json');
    await expect(policyCheckWith(root, ['owner'])).resolves.toMatchObject({ exitCode: 0 });
  });
});

/**
 * Some entries can name a path outside the folder their first segments name. A `..` after a
 * wildcard can climb above it, and the guard reads such an entry as the whole tree. A `.` or `..`
 * inside a brace alternative names a path once the braces are expanded, so the guard expands the
 * braces first and reads each expansion on its own. Either way a change to the path the entry can
 * name needs a code owner's approval, locally and in CI.
 */
describe('a guardedPaths entry that can name a path outside its folder', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = {
    'policy/rule1.json': '{}\n',
    'policy/sub/rule2.json': '{}\n',
    'x.json': '{}\n',
    'rules.json': '{}\n',
    'y.json': '{}\n',
    'b/keep.json': '{}\n',
    'src/App.tsx': 'export {}\n',
  };

  // [entry, a file at the root the entry can name]
  const cases: Array<[string, string]> = [
    ['policy/*/../../x.json', 'x.json'],
    ['{policy,b/..}/rules.json', 'rules.json'],
    ['{.,b}/y.json', 'y.json'],
  ];

  for (const [entry, changed] of cases) {
    const config = configWith([entry]);

    it(`refuses an edit to ${changed} under ${entry} in CI`, async () => {
      root = await repoWith(config, files);
      await git(root, ['checkout', '-b', 'feature']);
      await write(root, changed, '{"changed":true}\n');
      await git(root, ['commit', '-am', 'change a root file']);
      const out = await policyCheckAt(root);
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain(changed);
    });

    it(`lists an edit to ${changed} under ${entry} in the local guard`, async () => {
      root = await repoWith(config, files);
      await write(root, changed, '{"changed":true}\n');
      const result = await run(realDeps(root), config);
      expect(result.verdict).toBe('approval_required');
      expect(result.dirtyGuardedPaths).toContain(changed);
    });
  }
});

/**
 * `{,}` expands to empty paths, which guard the whole tree. The entry does not say so, so the
 * policy check names it as read wide.
 */
describe('a guardedPaths entry with an empty brace expansion', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = { 'policy/rule1.json': '{}\n', 'src/App.tsx': 'export {}\n' };
  const config = configWith(['{,}']);

  it('reads {,} as the whole repository in CI and names it', async () => {
    root = await repoWith(config, files);
    await git(root, ['checkout', '-b', 'feature']);
    await write(root, 'src/App.tsx', 'export const changed = 1\n');
    await git(root, ['commit', '-am', 'change the app']);
    const refused = await policyCheckAt(root);
    expect(refused.exitCode).toBe(2);
    expect(refused.message).toContain('src/App.tsx');
    expect(refused.message).toContain('guardedPaths entry "{,}" as the whole repository');
  });

  it('reads {,} as the whole repository in the local guard', async () => {
    root = await repoWith(config, files);
    await write(root, 'src/App.tsx', 'export const changed = 1\n');
    const result = await run(realDeps(root), config);
    expect(result.verdict).toBe('approval_required');
    expect(result.dirtyGuardedPaths).toEqual(['src/App.tsx']);
  });
});

/**
 * Past 256 brace expansions the guard reads an entry as the folder above its first brace group,
 * so a trusted ref that already holds such an entry cannot make the guard slow, and still guards
 * every path the entry names. The policy check names the entry.
 */
describe('a guardedPaths entry past the brace expansion cap', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = { 'policy/rule1.json': '{}\n', 'src/App.tsx': 'export {}\n' };
  const alternatives = Array.from({ length: 257 }, (_, i) => `rule${i}`).join(',');
  const cases: Array<[string, string]> = [
    ['one past the cap', `policy/{${alternatives}}.json`],
    ['far past the cap', 'policy/' + '{a,b}'.repeat(64) + '.json'],
  ];

  for (const [label, entry] of cases) {
    const config = configWith([entry]);

    it(`reads an entry ${label} as its folder in CI, names it, and lets an owner clear it`, async () => {
      root = await repoWith(config, files);
      await git(root, ['checkout', '-b', 'feature']);
      await write(root, 'policy/rule1.json', '{"changed":true}\n');
      await git(root, ['commit', '-am', 'change a rule']);
      const refused = await policyCheckAt(root);
      expect(refused.exitCode).toBe(2);
      expect(refused.message).toContain('policy/rule1.json');
      expect(refused.message).toContain('as the folder policy/');
      expect(refused.message).toContain('more than 256');
      const approved = await policyCheckWith(root, ['owner']);
      expect(approved.exitCode).toBe(0);
      expect(approved.message).toContain('more than 256');
    });

    it(`reads an entry ${label} as its folder in the local guard`, async () => {
      root = await repoWith(config, files);
      await write(root, 'policy/rule1.json', '{"changed":true}\n');
      const result = await run(realDeps(root), config);
      expect(result.verdict).toBe('approval_required');
      expect(result.dirtyGuardedPaths).toEqual(['policy/rule1.json']);
    });
  }
});

/**
 * A wide reading guards every file under its folder, dot-named files and folders too, as the git
 * listings do. Node's fs.glob skips a dot name under `**`, so the local guard also lists the dot
 * names. Otherwise a new untracked dot file under a wide entry would not be reported.
 */
describe('a new dot file under an entry the guard reads wide, in the local guard', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = { 'policy/rule1.json': '{}\n', 'other/keep.json': '{}\n', 'src/App.tsx': 'export {}\n' };
  const underPolicy = ['policy/.x', 'policy/.github/x.json', 'policy/.a/.b/c.json', 'policy/n/.c/d.json'];
  const outsidePolicy = ['other/.y', '.z', '.cfg/x.json'];

  async function divergedWith(entry: string): Promise<string[]> {
    const config = configWith([entry]);
    root = await repoWith(config, files);
    for (const path of [...underPolicy, ...outsidePolicy]) {
      await write(root, path, '{}\n');
    }
    return checkGuard(realDeps(root), config);
  }

  const folderCases: Array<[string, string]> = [
    ['past the cap', `policy/{${Array.from({ length: 257 }, (_, i) => `f${i}`).join(',')}}.json`],
    ['with a brace range', 'policy/rule{1..3}.json'],
  ];
  for (const [label, entry] of folderCases) {
    it(`reports new dot files under the folder of an entry ${label}, and nothing outside it`, async () => {
      expect(await divergedWith(entry)).toEqual([...underPolicy].sort());
    });
  }

  const wholeTreeCases: Array<[string, string]> = [
    ['past the cap', '{a,b}'.repeat(9)],
    ['with an empty brace expansion', '{,}'],
    ['with a .. after a wildcard', 'policy/*/../rule1.json'],
  ];
  for (const [label, entry] of wholeTreeCases) {
    it(`reports new dot files at the root and in dot folders for an entry ${label}, and nothing in .git`, async () => {
      expect(await divergedWith(entry)).toEqual([...underPolicy, ...outsidePolicy].sort());
    });
  }
});

/**
 * The requirements value is a folder, not a glob, and the requirements loader accepts any folder
 * name. The guard reads it as a literal path, as it did before the matcher.
 */
describe('the requirements folder', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const config: UsablConfig = { ...configWith(['policy/']), requirements: 'requirements (v2)' };
  const files = {
    'requirements (v2)/flows.yaml': 'flows: []\n',
    'policy/rules.json': '{}\n',
    'src/App.tsx': 'export {}\n',
  };

  it('guards the folder as a path, locally and in CI', async () => {
    root = await repoWith(config, files);
    await write(root, 'requirements (v2)/flows.yaml', 'flows: [changed]\n');
    await write(root, 'src/App.tsx', 'export const changed = 1\n');
    const local = await run(realDeps(root), config);
    expect(local.dirtyGuardedPaths).toEqual(['requirements (v2)/flows.yaml']);

    await git(root, ['checkout', '-b', 'feature']);
    await git(root, ['commit', '-am', 'change the requirements and the app']);
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('requirements (v2)/flows.yaml');
    expect(out.message).not.toContain('src/App.tsx');
    expect(out.message).not.toContain('read the guardedPaths entry');
  });

  it('lists the same files as before the matcher', async () => {
    root = await repoWith(config, files);
    const deps = realDeps(root);
    const before = await previousExpansion(deps, buildGuardedSet(config));
    expect(await expandConfigGuardedSet(deps, config)).toEqual(before);
  });

  // The same text in requirements and in guardedPaths is read both ways: as the requirements path
  // and as the guardedPaths glob, so neither reading hides the other.
  it('guards an entry with the same text as requirements as a path and as a glob, locally and in CI', async () => {
    const both: UsablConfig = { ...configWith(['policy/*']), requirements: 'policy/*' };
    const policyFiles = { 'policy/rule1.json': '{}\n', 'src/App.tsx': 'export {}\n' };
    root = await repoWith(both, policyFiles);
    await write(root, 'policy/rule1.json', '{"changed":true}\n');
    const local = await run(realDeps(root), both);
    expect(local.dirtyGuardedPaths).toContain('policy/rule1.json');

    await git(root, ['checkout', '-b', 'feature']);
    await git(root, ['commit', '-am', 'change a rule']);
    const out = await policyCheckAt(root);
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('policy/rule1.json');
  });
});

/**
 * For each form config load accepts, the guard's matcher, reading a git listing, selects the same
 * files Node's fs.glob selects on the working tree. A literal entry also selects the dot-named
 * files under it, as git lists them and as the guard always has; under a glob entry a dot-named
 * file is not guarded, in both places.
 */
describe('the guard matcher and Node fs.glob agree on every accepted form', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const tree = [
    'policy/a.json',
    'policy/b.json',
    'policy/.dot.json',
    'policy/readme.md',
    'policy/{x}.json',
    'policy/sub/c.json',
    'policy/sub/.d.json',
    'policy/sub/deep/e.json',
    'policy/.hidden/f.json',
    'rules/x.yml',
    'rules/y.yaml',
    'rules/.private/z.yml',
    'src/gate/index.ts',
    'src/gate/Über.ts',
    'src/run.ts',
    'top.json',
    '.github/w.yml',
  ];

  // [form, pattern, true when the entry is literal]
  const forms: Array<[string, string, boolean]> = [
    ['a star at the root', '*', false],
    ['a double star alone', '**', false],
    ['a star in a file name', 'policy/*.json', false],
    ['a double star at the end', 'policy/**', false],
    ['a double star in the middle', 'policy/**/*.json', false],
    ['a double star at the start', '**/*.json', false],
    ['a brace group', 'policy/{a,b}.json', false],
    ['a brace group of folders', '{policy,rules}/**', false],
    ['a brace group of extensions', 'rules/*.{yml,yaml}', false],
    ['a comma-less brace, read as text', 'policy/{x}.json', false],
    ['a star folder', 'policy/*/deep', false],
    ['a nested mix', 'po*/**/{c,e}.json', false],
    ['a star that names a folder', 'src/*', false],
    ['a literal folder', 'policy', true],
    ['a literal folder with a trailing slash', 'src/gate/', true],
    ['a literal file', 'src/run.ts', true],
    ['a literal file with a non-ASCII name', 'src/gate/Über.ts', true],
  ];

  it('selects the same files for each form', async () => {
    root = await repoWith(configWith([]), Object.fromEntries(tree.map((path) => [path, 'x\n'])));
    const node = makeFsGlob({ cwd: root });
    // Only the git listing at HEAD feeds the matcher here: the working tree glob is switched off.
    const deps: Deps = { ...realDeps(root), fs: { ...node, glob: async () => [] } };
    for (const [form, pattern, literal] of forms) {
      const prefix = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
      const byNode = (await node.glob([prefix, prefix + '/**'])).filter((path) => tree.includes(path));
      const byGuard = (await expandGuardedSet(deps, [pattern])).filter((path) => tree.includes(path));
      const isDotNamed = (path: string): boolean => path.split('/').some((segment) => segment.startsWith('.'));
      if (literal) {
        expect(byGuard.filter((path) => !isDotNamed(path)), form).toEqual(byNode);
        expect(byGuard.filter(isDotNamed), form).toEqual(
          tree.filter((path) => isDotNamed(path) && (path === prefix || path.startsWith(prefix + '/'))).sort(),
        );
      } else {
        expect(byGuard, form).toEqual(byNode);
      }
    }
  });
});

describe('the guard listing without git status', REAL_GIT, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('still lists a file deleted locally and a new untracked file under a guarded glob', async () => {
    // The HEAD listing holds the deleted file and fs.glob finds the new one, so git status adds
    // nothing. A status call that throws shows the guard no longer makes it.
    root = await repoWith(GLOB_CONFIG, { ...GLOB_FILES, 'policy/kept.json': '{}\n' });
    await unlink(join(root, 'policy/rules.json'));
    await write(root, 'policy/new.json', '{}\n');
    const base = realDeps(root);
    const deps: Deps = {
      ...base,
      git: {
        ...base.git,
        statusZ: async () => {
          throw new Error('git status is not part of the guard listing');
        },
      },
    };
    const listed = await expandGuardedSet(deps, ['policy/*.json']);
    expect(listed).toEqual(['policy/kept.json', 'policy/new.json', 'policy/rules.json']);
  });
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
