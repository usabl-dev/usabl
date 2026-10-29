/**
 * Help for every command, driven from the CLI's own command table. A new command or flag that
 * the table does not describe fails here, and so does a flag the parser reads that has no help.
 * Asking for help must never run anything: no check, no browser, no file written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { CLI_COMMANDS } from '../../src/surfaces/cli-commands.js';
import { INSTALL_TARGET_FLAGS } from '../../src/surfaces/cli.js';

describe('usabl help', () => {
  let workspace: string;
  let originalCwd: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'usabl-help-'));
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

  async function nothingWritten(): Promise<void> {
    expect(await readdir(workspace)).toEqual([]);
  }

  it.each([[['--help']], [['-h']], [['help']]])('%j prints help for every command and exits 0', async (argv) => {
    const code = await main(argv);
    expect(code).toBe(0);
    const out = stdout.join('');
    for (const command of CLI_COMMANDS) {
      const line = out.split('\n').find((entry) => entry.trimStart().startsWith(`${command.name} `));
      expect(line, `no help line for ${command.name}`).toBeDefined();
      expect(line).toContain(command.summary);
    }
    for (const line of out.split('\n')) {
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
    expect(out).toContain('With no command, usabl runs check.');
    expect(stderr.join('')).toBe('');
    await nothingWritten();
  });

  it('lists every command the CLI dispatches', () => {
    const names = CLI_COMMANDS.map((command) => command.name).sort();
    expect(names).toEqual(
      [
        'baseline',
        'bypass',
        'check',
        'comment',
        'docs',
        'doctor',
        'drift',
        'enforce',
        'floor',
        'help',
        'init',
        'install',
        'stop-hook',
      ].sort(),
    );
  });

  for (const command of CLI_COMMANDS) {
    for (const form of [[command.name, '--help'], [command.name, '-h'], ['help', command.name]]) {
      it(`usabl ${form.join(' ')} lists every flag of ${command.name} and runs nothing`, async () => {
        const code = await main(form);
        expect(code).toBe(0);
        const out = stdout.join('');
        expect(out).toContain(`Usage: ${command.usage}`);
        expect(out).toContain(command.summary);
        for (const flag of command.flags) {
          expect(flag.help.trim().length, `${command.name} ${flag.name} has no help`).toBeGreaterThan(0);
          const label = flag.value === undefined ? flag.name : `${flag.name} ${flag.value}`;
          expect(out, `${command.name} help does not list ${flag.name} with its help`).toContain(
            `  ${label}\n      ${flag.help}\n`,
          );
        }
        expect(out).toContain('--help');
        for (const line of out.split('\n')) {
          expect(line.length, line).toBeLessThanOrEqual(80);
        }
        expect(stderr.join('')).toBe('');
        await nothingWritten();
      });
    }
  }

  it('prints help for a command with a subcommand', async () => {
    expect(await main(['floor', 'prune', '--help'])).toBe(0);
    expect(stdout.join('')).toContain('--unconfirmed');
    await nothingWritten();
  });

  it('prints help when --help follows a value flag', async () => {
    expect(await main(['check', '--config', 'x.json', '--help'])).toBe(0);
    expect(stdout.join('')).toContain('Usage: usabl check');
  });

  it('every flag the parser reads has a help entry in the table', async () => {
    const source = await readFile(join(originalCwd, 'src/surfaces/cli.ts'), 'utf8');
    const parsed = new Set([...source.matchAll(/'(--[a-z][a-z-]*)'/g)].map((match) => match[1] ?? ''));
    const described = new Set(CLI_COMMANDS.flatMap((command) => command.flags.map((flag) => flag.name)));
    expect(parsed.size).toBeGreaterThan(10);
    for (const flag of parsed) {
      expect(described.has(flag), `${flag} is parsed but has no help`).toBe(true);
    }
    const install = CLI_COMMANDS.find((command) => command.name === 'install');
    for (const flag of INSTALL_TARGET_FLAGS) {
      expect(install?.flags.map((entry) => entry.name)).toContain(flag);
    }
  });

  it('refuses a flag the command does not take and names the help command', async () => {
    expect(await main(['check', '--frobnicate'])).toBe(2);
    expect(stderr.join('')).toContain('check does not take --frobnicate');
    expect(stderr.join('')).toContain('usabl check --help');
    await nothingWritten();
  });

  it('refuses a real flag given to a command that ignores it', async () => {
    expect(await main(['init', '--json'])).toBe(2);
    expect(stderr.join('')).toContain('init does not take --json');
    await nothingWritten();
  });

  it('refuses an unknown command and points at usabl help', async () => {
    expect(await main(['frobnicate'])).toBe(2);
    expect(stderr.join('')).toContain('unknown command: frobnicate');
    expect(stderr.join('')).toContain('usabl help');
  });

  it('refuses help for an unknown command', async () => {
    expect(await main(['help', 'frobnicate'])).toBe(2);
    expect(stderr.join('')).toContain('unknown command: frobnicate');
  });

  it('runs check when no command is given, and names the fix when there is no config', async () => {
    // The docs promise that usabl with no command runs check, so it still does.
    await expect(main([])).rejects.toThrow(/usabl\.config\.json.*not found.*usabl init/s);
  });
});
