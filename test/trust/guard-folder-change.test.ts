/**
 * A guarded path that is a file at one ref and a folder at the other is a policy change, which an
 * approval can clear. The git reader reads a folder as git show prints it, so the guard and the CI
 * policy check compare it as changed and never stop with an error. These tests use real git
 * repositories in temporary folders.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { enforcePolicy } from '../../src/surfaces/policy-enforce.js';
import { checkGuard } from '../../src/trust/guard.js';

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

async function repoWith(config: UsablConfig, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-folder-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await write(root, 'usabl.config.json', JSON.stringify(config));
  await write(root, '.github/CODEOWNERS', '* @owner\n');
  for (const [path, contents] of Object.entries(files)) {
    await write(root, path, contents);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'main']);
  return root;
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

describe('a guarded path that changes between a file and a folder', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('needs approval in the CI policy check when the config file becomes a folder', async () => {
    root = await repoWith(configWith([]), { 'src/App.tsx': 'export {}\n' });
    await git(root, ['switch', '-c', 'feature']);
    await rm(join(root, 'usabl.config.json'));
    await write(root, 'usabl.config.json/x', 'now a folder\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'the config becomes a folder']);
    const headSha = await git(root, ['rev-parse', 'HEAD']);
    // No review approves this head, so no code owner permission is ever read. The policy check
    // catches an error from the stub, so the calls are counted instead of trusted to throw.
    let permissionReads = 0;
    const out = await enforcePolicy(verified, {
      trustedRef: 'main',
      pr: { authorLogin: 'author', headSha },
      git: makeGitReader({ cwd: root }),
      listReviews: async () => [],
      readPermission: async () => {
        permissionReads += 1;
        throw new Error('no permission read is expected in this test');
      },
    });
    expect(permissionReads).toBe(0);
    expect(out.exitCode).toBe(2);
    expect(out.message).toMatch(/approval/i);
    expect(out.message).toContain('usabl.config.json');
  });

  it('reports a guarded folder that becomes a file as changed, without an error', async () => {
    const config = configWith(['policy']);
    root = await repoWith(config, { 'policy/rules.json': '{"rules":1}\n', 'src/App.tsx': 'export {}\n' });
    await rm(join(root, 'policy'), { recursive: true, force: true });
    await write(root, 'policy', 'now a file\n');
    const deps = { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
    await expect(checkGuard(deps, config)).resolves.toContain('policy');
  });
});
