/**
 * `usabl enforce policy` reads the pull request head SHA from the event file that
 * GITHUB_EVENT_PATH names and passes it to git as a ref. The CLI refuses a value that is not a
 * commit id, 7 to 40 hex characters, before any git call, with exit 2 and a message that names the
 * event file field. These tests replace the git reader with a recorder, so they read no git
 * repository and show that a refused value never reaches git.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitCalls: Array<{ method: string; ref: string }> = [];
let readersMade = 0;

vi.mock('../../src/deps/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/deps/git.js')>();
  return {
    ...actual,
    makeGitReader: () => {
      readersMade += 1;
      return {
        show: async (ref: string) => {
          gitCalls.push({ method: 'show', ref });
          return null;
        },
        lsFilesUnder: async (ref: string) => {
          gitCalls.push({ method: 'lsFilesUnder', ref });
          return [];
        },
      };
    },
  };
});

const { main } = await import('../../src/cli.js');

const TRUSTED = '0123456789abcdef0123456789abcdef01234567';
const VALID_HEAD = 'fedcba9876543210fedcba9876543210fedcba98';

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

beforeEach(() => {
  gitCalls.length = 0;
  readersMade = 0;
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (eventEnv === undefined) delete process.env.GITHUB_EVENT_PATH;
  else process.env.GITHUB_EVENT_PATH = eventEnv;
  if (stdinDescriptor !== undefined) Object.defineProperty(process, 'stdin', stdinDescriptor);
});

async function enforceWithHead(sha: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'usabl-head-sha-'));
  tempDirs.push(dir);
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, user: { login: 'author' }, head: { sha } } }));
  process.env.GITHUB_EVENT_PATH = eventPath;
  Object.defineProperty(process, 'stdin', { value: Readable.from([RESULT]), configurable: true });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const code = await main(['enforce', 'policy', '--trusted-ref', TRUSTED]);
  return {
    code,
    stdout: stdout.mock.calls.map((call) => String(call[0])).join(''),
    stderr: stderr.mock.calls.map((call) => String(call[0])).join(''),
  };
}

describe('enforce policy refuses a head SHA that is not a commit id', () => {
  const refused: Array<[string, string]> = [
    ['an empty value', ''],
    ['a value that starts with a dash', '-abcdef0'],
    ['6 hex characters', 'abcdef'],
    ['41 hex characters', `${VALID_HEAD}0`],
    ['a value with a newline', `${VALID_HEAD.slice(0, 20)}\n${VALID_HEAD.slice(20)}`],
    ['a commit id with a newline at the end', `${VALID_HEAD.slice(0, 39)}\n`],
  ];

  for (const [name, sha] of refused) {
    it(`refuses ${name} before any git call, naming the event file field`, async () => {
      const out = await enforceWithHead(sha);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain('pull_request.head.sha');
      expect(out.stderr).toContain('GITHUB_EVENT_PATH');
      expect(readersMade).toBe(0);
      expect(gitCalls).toEqual([]);
    });
  }

  it('passes a 40 character commit id on to git', async () => {
    const out = await enforceWithHead(VALID_HEAD);
    expect(out.stderr).not.toContain('pull_request.head.sha');
    expect(readersMade).toBe(1);
    expect(gitCalls.some((call) => call.ref === VALID_HEAD)).toBe(true);
  });
});
