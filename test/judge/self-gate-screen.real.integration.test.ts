/**
 * This repository's own gate, run end to end on the screen it judges. Gated behind
 * USABL_INTEGRATION=1 like the other real-browser suites, because it launches Chromium.
 *
 * The self gate serves fixtures/live and checks the one screen usabl.config.json names. A pull
 * request that changes that screen can only reach `verified` if the page passes every check: axe
 * with no violation and no incomplete result, the rulepacks, and the keyboard walk. So this test
 * runs the real CLI the way the judge does (`check --ci --trusted-ref --isolated-browser --json`)
 * in a scratch repository. Its trusted ref holds the repository's own config, with only the
 * origin moved to the port of a local build server, and its head adds the screen. The verdict must
 * be `verified`, with no finding, no draft, and no gap.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { main } from '../../src/cli.js';
import { startBuildServer, type BuildServer } from '../../src/judge/serve-build.js';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCREEN_FILE = 'fixtures/live/self-gate-screen.html';
const CONFIG_ORIGIN = 'http://127.0.0.1:5173';

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')("this repository's own gate on its screen", { timeout: 180_000 }, () => {
  let repo: string;
  let app: BuildServer;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'usabl-self-gate-'));
    await mkdir(join(repo, 'fixtures', 'live'), { recursive: true });
    app = await startBuildServer({ dir: join(repo, 'fixtures', 'live'), host: '127.0.0.1', port: 0 });
    const config = await readFile(join(ROOT, 'usabl.config.json'), 'utf8');
    expect(config).toContain(CONFIG_ORIGIN);
    await writeFile(join(repo, 'usabl.config.json'), config.split(CONFIG_ORIGIN).join(app.url));
    await writeFile(join(repo, '.gitignore'), '.usabl/\n');
    await git(repo, 'init', '--quiet', '--initial-branch=main');
    await git(repo, 'config', 'user.name', 'usabl test');
    await git(repo, 'config', 'user.email', 'test@usabl.invalid');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '--quiet', '-m', 'base');
    // The pull request adds the screen, which is the build the server serves.
    await git(repo, 'checkout', '--quiet', '-b', 'pr');
    await writeFile(join(repo, SCREEN_FILE), await readFile(join(ROOT, SCREEN_FILE), 'utf8'));
    await git(repo, 'add', '.');
    await git(repo, 'commit', '--quiet', '-m', 'pr');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (repo !== undefined) await rm(repo, { recursive: true, force: true });
  });

  it('reads the screen as verified, with no finding, no draft, and no gap', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
    vi.stubEnv('USABL_STORAGE_STATE', undefined);
    const originalCwd = process.cwd();
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    let code: number;
    try {
      process.chdir(repo);
      code = await main(['check', '--ci', '--trusted-ref', 'main', '--isolated-browser', '--json']);
    } finally {
      process.chdir(originalCwd);
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }

    const result = JSON.parse(stdout.join('')) as Result;
    const screens = result.screens.map((screen) => ({
      screenId: screen.screenId,
      drafts: screen.drafts,
      gaps: screen.gaps,
      reachedSelectorPresent: screen.reachedSelectorPresent,
      browserSandbox: screen.browserSandbox,
    }));
    expect({ code, verdict: result.verdict, findings: result.findings, gaps: result.coverage.gaps, screens }).toEqual({
      code: 0,
      verdict: 'verified',
      findings: [],
      gaps: [],
      screens: [{ screenId: 'self-gate', drafts: [], gaps: [], reachedSelectorPresent: true, browserSandbox: undefined }],
    });
    expect(result.coverage.affected.map((screen) => screen.screenId)).toEqual(['self-gate']);
    expect(result.judge).toMatchObject({ isolatedBrowser: true, blockedRequests: 0 });
    // The walk reached the field, the button, and the link. Silence from a walk that never
    // started would also leave no draft, so the stops are counted.
    expect(result.screens[0]?.stops.length).toBeGreaterThanOrEqual(3);
    // axe ran on the page and no rule came back incomplete.
    const axe = result.screens[0]?.applicability.filter((entry) => entry.layer === 'axe') ?? [];
    expect(axe.some((entry) => entry.outcome === 'passed')).toBe(true);
    expect(axe.filter((entry) => entry.outcome === 'incomplete' || entry.outcome === 'failed')).toEqual([]);
  });
});
