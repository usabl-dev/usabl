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

async function git(cwd: string, args: string[]): Promise<void> {
  const date = '2026-01-01T00:00:00Z';
  await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

describe('usabl debt ledger on the command line', () => {
  let originalCwd = '';
  let workspace = '';
  let stdout: string[] = [];
  let stderr: string[] = [];

  beforeEach(async () => {
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
    expect(out).toMatch(/\nat least \d+ +open +2026-01-01 /u);
    expect((await readdir(workspace)).sort()).toEqual(before);
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

  it('refuses --out on the plain debt command, which writes no file', async () => {
    expect(await main(['debt', '--out', 'debt.json'])).toBe(2);
    expect(stderr.join('')).toContain('--out is for usabl debt ledger');
    expect(await readdir(workspace)).toEqual([]);
  });
});
