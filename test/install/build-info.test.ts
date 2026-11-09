/**
 * The build records the commit the engine was built from in dist/build-info.json, and
 * `usabl install --ci` writes that commit into the generated workflows as the engine pin. The pin
 * is a security value, so only a full 40-character commit SHA from a clean tree counts. Anything
 * else keeps the placeholder and says why, so a wrong or missing pin can only fail closed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILD_INFO_SCHEMA, enginePinFromBuildInfo } from '../../src/install/build-info.js';

const WRITER = resolve('scripts/write-build-info.mjs');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeInfo(repo: string, out: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [WRITER, repo, out], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

describe('scripts/write-build-info.mjs', () => {
  let work: string;
  let repo: string;
  let out: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'usabl-build-info-'));
    repo = join(work, 'repo');
    out = join(work, 'build-info.json');
    spawnSync('mkdir', [repo]);
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'usabl', version: '9.8.7' }) + '\n');
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  function commitAll(): string {
    git(repo, ['init', '--quiet']);
    git(repo, ['config', 'user.name', 'usabl build info test']);
    git(repo, ['config', 'user.email', 'build-info@usabl.invalid']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '-m', 'seed']);
    return git(repo, ['rev-parse', 'HEAD']);
  }

  it('records the full commit, the version, and a clean tree', async () => {
    const head = commitAll();
    expect(writeInfo(repo, out).status).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
      schemaVersion: BUILD_INFO_SCHEMA,
      version: '9.8.7',
      commit: head,
      clean: true,
    });
  });

  it('records a tree with an uncommitted change as not clean', async () => {
    commitAll();
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'usabl', version: '9.8.8' }) + '\n');
    expect(writeInfo(repo, out).status).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ version: '9.8.8', clean: false });
  });

  it('records a tree with an untracked file as not clean, because the build may have read it', async () => {
    commitAll();
    await writeFile(join(repo, 'extra.ts'), 'export const extra = 1;\n');
    expect(writeInfo(repo, out).status).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ clean: false });
  });

  it('records no commit when the build ran outside git', async () => {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: work };
    const result = spawnSync(process.execPath, [WRITER, repo, out], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
      schemaVersion: BUILD_INFO_SCHEMA,
      version: '9.8.7',
      commit: null,
      clean: false,
    });
  });
});

describe('enginePinFromBuildInfo', () => {
  const info = (fields: Record<string, unknown>): string =>
    JSON.stringify({ schemaVersion: BUILD_INFO_SCHEMA, version: '0.3.0', commit: SHA, clean: true, ...fields });

  it('fills the pin from a clean build with a full commit SHA', () => {
    expect(enginePinFromBuildInfo(info({}))).toEqual({ kind: 'filled', sha: SHA, version: '0.3.0' });
  });

  it('keeps the placeholder when there is no build record', () => {
    const pin = enginePinFromBuildInfo(null);
    expect(pin.kind).toBe('placeholder');
    expect(pin.kind === 'placeholder' && pin.reason).toContain('build-info.json');
  });

  it('keeps the placeholder for a build outside git or from a dirty tree, and says which', () => {
    const outside = enginePinFromBuildInfo(info({ commit: null, clean: false }));
    expect(outside.kind === 'placeholder' && outside.reason).toContain('outside a git checkout');
    const dirty = enginePinFromBuildInfo(info({ clean: false }));
    expect(dirty.kind === 'placeholder' && dirty.reason).toContain('uncommitted changes');
  });

  it('never takes a branch, a tag, a short SHA, or an uppercase SHA as the pin', () => {
    for (const commit of ['main', 'v0.3.0', SHA.slice(0, 12), SHA.toUpperCase(), `${SHA}\n`, `${SHA} `, 42]) {
      expect(enginePinFromBuildInfo(info({ commit })).kind, String(commit)).toBe('placeholder');
    }
  });

  it('keeps the placeholder for a record it cannot read', () => {
    for (const raw of ['', '{', '[]', 'null', JSON.stringify({ commit: SHA, clean: true }), info({ schemaVersion: 'other' }), info({ clean: 'yes' }), info({ version: 3 })]) {
      expect(enginePinFromBuildInfo(raw).kind, raw).toBe('placeholder');
    }
  });
});
