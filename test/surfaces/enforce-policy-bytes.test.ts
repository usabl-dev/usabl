/**
 * The CI policy check, run through the command line, compares guarded files as bytes. Two bytes
 * that are each invalid UTF-8 decode to the same text, so a text compare reads the change as no
 * policy change. These tests use a real git repository in a temporary folder.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
let root = '';

vi.mock('../../src/deps/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/deps/git.js')>();
  return { ...actual, makeGitReader: () => actual.makeGitReader({ cwd: root }) };
});

const { main } = await import('../../src/cli.js');

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
  return stdout.trim();
}

async function write(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents);
}

const RESULT = JSON.stringify({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: 'verified',
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
});

const eventEnv = process.env.GITHUB_EVENT_PATH;
const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

afterEach(async () => {
  vi.restoreAllMocks();
  if (eventEnv === undefined) delete process.env.GITHUB_EVENT_PATH;
  else process.env.GITHUB_EVENT_PATH = eventEnv;
  if (stdinDescriptor !== undefined) Object.defineProperty(process, 'stdin', stdinDescriptor);
  await rm(root, { recursive: true, force: true });
});

describe('enforce policy compares guarded files as bytes', { timeout: 60_000 }, () => {
  it('reads 0xFE changed to 0xFF in a guarded file as a policy change', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-enforce-bytes-'));
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.name', 'Test User']);
    await git(['config', 'user.email', 'test@example.com']);
    await write('usabl.config.json', JSON.stringify({ guardedPaths: ['policy.bin'] }));
    await write('policy.bin', Buffer.from([0xfe, 0x41]));
    await git(['add', '-A']);
    await git(['commit', '-m', 'trusted']);
    const trusted = await git(['rev-parse', 'HEAD']);
    await write('policy.bin', Buffer.from([0xff, 0x41]));
    await git(['add', '-A']);
    await git(['commit', '-m', 'head']);
    const head = await git(['rev-parse', 'HEAD']);

    // Written after the commits, so it is in neither ref.
    const eventPath = join(root, 'event.json');
    await writeFile(eventPath, JSON.stringify({ pull_request: { number: 7, user: { login: 'author' }, head: { sha: head } } }));
    process.env.GITHUB_EVENT_PATH = eventPath;
    Object.defineProperty(process, 'stdin', { value: Readable.from([RESULT]), configurable: true });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await main(['enforce', 'policy', '--trusted-ref', trusted]);
    const printed = stdout.mock.calls.map((call) => String(call[0])).join('');
    // The trusted ref has no CODEOWNERS, so a policy change stops there. No policy change would
    // exit 0 with "no policy change".
    expect(printed).not.toContain('no policy change');
    expect(printed).toContain('missing .github/CODEOWNERS');
    expect(code).toBe(2);
  });
});
