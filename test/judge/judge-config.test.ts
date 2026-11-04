/**
 * The isolated judge takes its whole configuration from the trusted commit. The head's
 * usabl.config.json is only compared with it, so a head that breaks or rewrites that file is
 * reported as a policy change, and the judge still scans against the trusted settings instead of
 * stopping before it starts.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
