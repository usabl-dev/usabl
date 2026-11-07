/**
 * `usabl brief` on the command line: the flags it takes, the files it reads, and the error shape it
 * shares with the other commands. It opens no browser and writes no file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { preflightCli } from '../../src/surfaces/cli-commands.js';
import { normalizeTaskFiles } from '../../src/brief/index.js';

const execFileAsync = promisify(execFile);

describe('brief arguments', () => {
  it('reads every path after --files', () => {
    const opts = parseCliArgs(['brief', '--files', 'src/a.tsx', 'src/b.tsx', '--json']);
    expect(opts.command).toBe('brief');
    expect(opts.files).toEqual(['src/a.tsx', 'src/b.tsx']);
    expect(opts.json).toBe(true);
  });

  it('has no files when --files is not given', () => {
    expect(parseCliArgs(['brief']).files).toBeNull();
  });

  it('refuses --files with no path', () => {
    expect(() => parseCliArgs(['brief', '--files'])).toThrow(/--files requires at least one path/u);
    expect(() => parseCliArgs(['brief', '--files', '--json'])).toThrow(/--files requires at least one path/u);
  });

  it('takes a file named help as a path, not as a request for help', () => {
    expect(preflightCli(['brief', '--files', 'help', 'src/a.tsx'])).toBeNull();
    expect(parseCliArgs(['brief', '--files', 'help', 'src/a.tsx']).files).toEqual(['help', 'src/a.tsx']);
  });

  it('refuses a flag brief does not take, such as a trusted ref', () => {
    expect(preflightCli(['brief', '--files', 'src/a.tsx', '--trusted-ref', 'origin/main'])).toEqual({
      kind: 'refuse',
      message: 'brief does not take --trusted-ref. Run "usabl brief --help" to list its options.',
    });
  });

  it('writes paths the way git does and drops repeats', () => {
    expect(normalizeTaskFiles(['./src/a.tsx', 'src//b.tsx', 'src/a.tsx'])).toEqual(['src/a.tsx', 'src/b.tsx']);
  });
});

describe('usabl brief', () => {
  let workspace: string;
  let originalCwd: string;
  let stdout: string[];
  let stderr: string[];

  const config = {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: ['src/App.tsx'] },
    surfaces: [{ id: 'page', url: 'http://127.0.0.1:5173/page?session=abc', files: ['src/Page.tsx'] }],
    guardedPaths: [],
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'usabl-brief-'));
    process.chdir(workspace);
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
    await rm(workspace, { recursive: true, force: true });
  });

  async function repo(): Promise<void> {
    await execFileAsync('git', ['init', '-q', '--initial-branch=main'], { cwd: workspace });
    await mkdir(join(workspace, 'src'));
    await writeFile(join(workspace, 'usabl.config.json'), JSON.stringify(config));
    await writeFile(join(workspace, 'usabl.routes.json'), JSON.stringify({ routes: [] }));
    await writeFile(join(workspace, 'src/Page.tsx'), 'export default function Page() {}');
    // git cannot read HEAD before the first commit, and neither check nor brief plans without it.
    await execFileAsync('git', ['add', '.'], { cwd: workspace });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], {
      cwd: workspace,
    });
    await writeFile(join(workspace, 'src/Page.tsx'), 'export default function Page() { return null; }');
  }

  it('prints the brief as JSON with --json and exits 0, writing nothing', async () => {
    await repo();
    const before = (await readdir(workspace)).sort();
    const code = await main(['brief', '--files', './src/Page.tsx', '--json']);
    expect(code).toBe(0);
    // loadConfig warns that the surface url has a query. The warning never prints the query.
    expect(stderr.join('')).not.toContain('session=abc');
    const brief = JSON.parse(stdout.join(''));
    expect(brief.version).toBe(1);
    expect(brief.files).toEqual(['src/Page.tsx']);
    expect(brief.screens.map((screen: { id: string }) => screen.id)).toEqual(['page']);
    expect(brief.screens[0].url).toBe('http://127.0.0.1:5173/page');
    expect((await readdir(workspace)).sort()).toEqual(before);
  });

  it('prints the text projection by default', async () => {
    await repo();
    expect(await main(['brief', '--files', 'src/Page.tsx'])).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('usabl brief: 1 changed file reaches 1 screen. This is a plan, not a verdict.');
    expect(out).toContain('screen page: http://127.0.0.1:5173/page');
    expect(out).toContain('Done when:');
    expect(out).not.toContain('session=abc');
  });

  it('uses the files git reports as changed when --files is not given', async () => {
    await repo();
    const code = await main(['brief', '--json']);
    expect(code).toBe(0);
    const brief = JSON.parse(stdout.join(''));
    expect(brief.files).toEqual(['src/Page.tsx']);
    expect(brief.screens.map((screen: { id: string }) => screen.id)).toEqual(['page']);
  });

  it('fails the same way check does when there is no config', async () => {
    await expect(main(['brief', '--files', 'src/Page.tsx'])).rejects.toThrow(/usabl\.config\.json.*not found.*usabl init/su);
  });

  it('fails when the requirements cannot be loaded', async () => {
    await repo();
    await writeFile(join(workspace, 'usabl.config.json'), JSON.stringify({ ...config, requirements: 'requirements/' }));
    await expect(main(['brief', '--files', 'src/Page.tsx'])).rejects.toThrow(/could not load the design requirements/u);
  });
});
