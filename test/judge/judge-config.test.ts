/**
 * The isolated judge takes its whole configuration from the trusted commit. The head's
 * usabl.config.json is only compared with it, so a head that breaks or rewrites that file is
 * reported as a policy change, and the judge still scans against the trusted settings instead of
 * stopping before it starts.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { testConfig } from '../helpers.js';

const execFileAsync = promisify(execFile);

describe('check --isolated-browser with a trusted ref', () => {
  let repo: string;
  let originalCwd: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = await mkdtemp(join(tmpdir(), 'usabl-judge-config-'));
    await execFileAsync('git', ['init', '-q', '--initial-branch=main'], { cwd: repo });
    await writeFile(join(repo, 'usabl.config.json'), JSON.stringify({ ...testConfig(), readyTimeoutMs: 30_000 }), 'utf8');
    await execFileAsync('git', ['add', 'usabl.config.json'], { cwd: repo });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'base'], { cwd: repo });
    process.chdir(repo);
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(repo, { recursive: true, force: true });
  });

  it('does not stop on an invalid head config: it judges with the trusted one and reports the change', async () => {
    await writeFile(join(repo, 'usabl.config.json'), '{ this head broke its config', 'utf8');
    const code = await main(['check', '--ci', '--trusted-ref', 'HEAD', '--isolated-browser', '--json']);
    const result = JSON.parse(stdout.join('')) as { dirtyGuardedPaths: string[]; judge: { isolatedBrowser: boolean } };
    expect(stderr.join('')).not.toContain('Unexpected token');
    expect(result.judge.isolatedBrowser).toBe(true);
    // The changed config is a guarded-path change, so the run waits for approval, never a pass.
    expect(result.dirtyGuardedPaths).toContain('usabl.config.json');
    expect(code).not.toBe(0);
  }, 60_000);

  // The judge builds its config from the trusted ref and never calls the loader, so an empty
  // uiFileGlobs list there read every change as nothing to check and exited 0. The docs manifest
  // that would excuse it is read at the trusted ref too, so the head cannot add one to pass.
  const commitEmptyGlobs = async (files: Record<string, string>): Promise<string> => {
    await writeFile(join(repo, 'usabl.config.json'), JSON.stringify({ ...testConfig(), uiFileGlobs: [] }), 'utf8');
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await writeFile(join(repo, name), text, 'utf8');
    }
    await execFileAsync('git', ['add', 'usabl.config.json', ...Object.keys(files)], { cwd: repo });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'empty globs'], { cwd: repo });
    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  };

  it('refuses a trusted config with an empty uiFileGlobs list, exit 4, with the workflow command line', async () => {
    const base = await commitEmptyGlobs({ 'src/App.tsx': 'export const App = 1;\n' });
    await writeFile(join(repo, 'src/App.tsx'), 'export const App = 2;\n', 'utf8');
    const code = await main(['check', '--ci', '--trusted-ref', base, '--isolated-browser', '--json']);
    expect(code).toBe(4);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('usabl.config.json has an empty uiFileGlobs list');
  }, 60_000);

  it('tells a pull request that fixes the empty list that the fix takes effect once merged', async () => {
    const base = await commitEmptyGlobs({ 'src/App.tsx': 'export const App = 1;\n' });
    // The head fixes the list, but the judge reads the config at the trusted ref, so it still
    // refuses. The message must say why, or the author reads exit 4 as a broken fix.
    await writeFile(join(repo, 'usabl.config.json'), JSON.stringify({ ...testConfig(), uiFileGlobs: ['src/**/*.tsx'] }), 'utf8');
    const code = await main(['check', '--ci', '--trusted-ref', base, '--isolated-browser', '--json']);
    expect(code).toBe(4);
    expect(stderr.join('')).toContain('usabl.config.json has an empty uiFileGlobs list');
    expect(stderr.join('')).toContain(
      'In CI, usabl reads this config from the base branch, so a fix to uiFileGlobs takes effect once it is merged there.',
    );
  }, 60_000);

  it('reads the docs manifest that would excuse it at the trusted ref, not in the head', async () => {
    const base = await commitEmptyGlobs({ 'usabl.docs.json': '{"docsBaseUrl":"http://127.0.0.1:4000","pages":[]}' });
    await writeFile(
      join(repo, 'usabl.docs.json'),
      JSON.stringify({
        format: 'asciidoc-modular',
        docsBaseUrl: 'http://127.0.0.1:4000',
        builtRoot: 'build/html',
        pages: [{ pageId: 'install', url: '/install/index.html', assemblyFile: 'assemblies/install.adoc', sources: [] }],
        sharedGlobs: [],
      }),
      'utf8',
    );
    const code = await main(['check', '--ci', '--trusted-ref', base, '--isolated-browser', '--json']);
    expect(code).toBe(4);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('usabl.config.json has an empty uiFileGlobs list');
  }, 60_000);
});
