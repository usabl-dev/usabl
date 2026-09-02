/**
 * These tests exercise the CLI glue for doctor, not just the collectors. They run main()
 * end to end against a real temporary working directory and prove that the doctor command
 * is routed (not rejected as unknown), renders a report to stdout, and always exits 0
 * because doctor mints no verdict. A bare directory has no usabl wiring, yet doctor must
 * still exit 0: a missing surface is information, not a doctor failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.js';

describe('usabl doctor command wiring', () => {
  let workspace: string;
  let originalCwd: string;
  let stdout: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'usabl-doctor-cli-'));
    process.chdir(workspace);
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
    await rm(workspace, { recursive: true, force: true });
  });

  it('routes doctor, renders a report, and exits 0 in a bare repo', async () => {
    const code = await main(['doctor']);
    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('usabl doctor:');
    expect(out).toContain('[missing]');
    // gh state depends on the environment, but the file surfaces are confidently missing.
    expect(out.toLowerCase()).toContain('no verdict');
  });

  it('reports config wired and exits 0 when a valid usabl.config.json is present', async () => {
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(
      join(workspace, 'usabl.config.json'),
      JSON.stringify({
        appBaseUrl: 'http://127.0.0.1:5173',
        uiFileGlobs: ['src/**'],
        discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
        surfaces: [],
        guardedPaths: ['usabl.config.json'],
      }),
      'utf8',
    );
    const code = await main(['doctor']);
    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('[wired] usabl config');
  });

  it('reads the session variable from the real environment and never prints its value', async () => {
    // This is the glue the collector cannot test for itself: doctor takes the environment as
    // an injected value, so only the command wiring proves an operator's exported session is
    // the one being reported on. The path stays out of stdout in every state.
    const sessionPath = join(workspace, 'storage-state.json');
    await writeFile(sessionPath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    vi.stubEnv('USABL_STORAGE_STATE', sessionPath);

    const code = await main(['doctor']);

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('[wired] authenticated session (USABL_STORAGE_STATE)');
    expect(out).not.toContain(sessionPath);
  });

  it('reports no session as missing when the variable is not exported', async () => {
    vi.stubEnv('USABL_STORAGE_STATE', '');

    const code = await main(['doctor']);

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('[missing] authenticated session (USABL_STORAGE_STATE)');
  });
});
