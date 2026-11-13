/**
 * `usabl debt ledger` through the CLI entry point, in a real git repository in a temp folder.
 * It writes nothing by default, writes the full ledger with --out, and refuses plainly when it
 * cannot run.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { dialogAt, entryFor, floorOf } from './helpers.js';

const execFileAsync = promisify(execFile);

// The machine's own git config, time zone, and locale never reach these repositories. The command
// under test inherits process.env, so it is set for each test, not only for this helper.
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TZ: 'UTC', LC_ALL: 'C' };

async function git(cwd: string, args: string[]): Promise<void> {
  const date = '2026-01-01T00:00:00Z';
  await execFileAsync('git', args, { cwd, env: { ...process.env, ...HERMETIC, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

describe('usabl debt ledger on the command line', () => {
  let originalCwd = '';
  let workspace = '';
  let stdout: string[] = [];
  let stderr: string[] = [];

  beforeEach(async () => {
    for (const [name, value] of Object.entries(HERMETIC)) vi.stubEnv(name, value);
    originalCwd = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'usabl-ledger-cli-'));
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
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
    await rm(workspace, { recursive: true, force: true });
  });

  async function repoWithFloor(): Promise<void> {
    await git(workspace, ['init', '--quiet', '--initial-branch=main']);
    await git(workspace, ['config', 'user.name', 'Test User']);
    await git(workspace, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(workspace, '.usabl-evidence.json'), JSON.stringify(floorOf([entryFor(dialogAt(1), 1)])), 'utf8');
    await git(workspace, ['add', '.usabl-evidence.json']);
    await git(workspace, ['commit', '--quiet', '-m', 'baseline']);
  }

  it('parses the ledger subcommand and its flags', () => {
    expect(parseCliArgs(['debt', 'ledger', '--json', '--out', 'ledger.json', '--trusted-ref', 'origin/main'])).toMatchObject({
      command: 'debt',
      debtSubcommand: 'ledger',
      json: true,
      outPath: 'ledger.json',
      trustedRef: 'origin/main',
    });
    expect(parseCliArgs(['debt']).debtSubcommand).toBeNull();
  });

  it('prints the table, exits 0, and writes nothing by default', async () => {
    await repoWithFloor();
    const before = (await readdir(workspace)).sort();
    expect(await main(['debt', 'ledger'])).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('usabl debt ledger: how long accessibility barriers stay open, as the floor history of HEAD');
    // No history in this repository: the row may be older and may be fixed already.
    expect(out).toMatch(/\nnot known \(\d+ by the floor\) +open +2026-01-01 /u);
    expect((await readdir(workspace)).sort()).toEqual(before);
  });

  it('reads no clock: two runs a day apart print the same bytes, counted to the tip commit', async () => {
    await repoWithFloor();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
      expect(await main(['debt', 'ledger', '--json'])).toBe(0);
      const first = stdout.join('');
      stdout = [];
      vi.setSystemTime(new Date('2026-03-02T12:00:00.000Z'));
      expect(await main(['debt', 'ledger', '--json'])).toBe(0);
      expect(stdout.join('')).toBe(first);
      const ledger = JSON.parse(first);
      // The only commit is dated 2026-01-01, so the open row has 0 days whatever the clock says.
      expect(ledger.headDate).toBe('2026-01-01T00:00:00.000Z');
      expect(ledger.rows[0].daysOpen).toBe(0);
      expect(ledger).not.toHaveProperty('now');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints the full ledger as JSON with --json, and writes it to a file with --out', async () => {
    await repoWithFloor();
    expect(await main(['debt', 'ledger', '--json', '--out', 'ledger.json'])).toBe(0);
    const printed = JSON.parse(stdout.join(''));
    const written = JSON.parse(await readFile(join(workspace, 'ledger.json'), 'utf8'));
    expect(printed.schema).toBe('usabl.ledger.v1');
    expect(written).toEqual(printed);
    expect(stderr.join('')).toContain('Wrote the full ledger to ledger.json.');
  });

  it('refuses outside a git repository and says why', async () => {
    expect(await main(['debt', 'ledger'])).toBe(4);
    expect(stderr.join('')).toContain('not in a git repository');
  });

  // A shallow clone can lack the trusted commit. The floor at that commit was never read, so the
  // command must not say that no accessibility debt is accepted.
  it('fails and names the ref when the trusted commit is not in the repository', async () => {
    await repoWithFloor();
    const absent = 'deadbeef'.repeat(5);
    expect(await main(['debt', '--trusted-ref', absent])).toBe(4);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain(`git cannot read ${absent}`);
    expect(err).not.toContain('no accessibility debt is accepted');
  });

  it('refuses a trusted ref that starts with a dash', () => {
    expect(() => parseCliArgs(['debt', '--trusted-ref', '--output=written'])).toThrow(/--trusted-ref requires a value/);
  });

  it('refuses --out on the plain debt command, which writes no file', async () => {
    expect(await main(['debt', '--out', 'debt.json'])).toBe(2);
    expect(stderr.join('')).toContain('--out is for usabl debt ledger');
    expect(await readdir(workspace)).toEqual([]);
  });
});
