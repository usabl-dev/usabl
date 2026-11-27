/**
 * A named pipe that git reads must not keep the Stop hook from answering, or leave git running
 * after the stop. git waits on a pipe until something writes to it. The hook finds the repository
 * with git before anything else, so a pipe at `.git/HEAD` or `.git/config` gave no answer at all,
 * and the host then let the stop go on with nothing checked. A pipe at a ref or at a working-tree
 * `.gitignore` held a git command of the checks, and the deadline answered, but that git process
 * waited on after the stop ended.
 *
 * Each case runs the real stop-hook command in a child process on a real git repository. The stop
 * must block before the host's limit with the deadline's answer, and no process the stop started
 * may still run in the repository afterwards.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, readdirSync, readlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerOf,
  bundle,
  GIVE_UP_MS,
  HOST_LIMIT_SECONDS,
  makeWork,
  removeWork,
  repository,
  stop,
} from '../support/real-stop-hook.js';

// Making pipes needs a POSIX system, and finding processes by their folder reads /proc.
const CAN_RUN = process.platform === 'linux';

let work = '';
let dist = '';

beforeAll(async () => {
  work = await makeWork('usabl-git-pipes-');
  dist = await bundle(work, 'real');
}, 120_000);

afterAll(async () => {
  await removeWork(work);
});

const IDLE = { base: { 'README.md': 'one\n' }, change: { 'README.md': 'two\n' } };

// The processes whose working folder is the repository or a folder in it.
function processesIn(repo: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      if (cwd === repo || cwd.startsWith(`${repo}/`)) found.push(Number(name));
    } catch {
      // Gone, or not ours to read.
    }
  }
  return found;
}

// A kill is delivered at once, but the process table may take a moment to drop the process.
async function processesLeftIn(repo: string): Promise<number[]> {
  for (let tries = 0; tries < 20; tries += 1) {
    const left = processesIn(repo);
    if (left.length === 0) return left;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return processesIn(repo);
}

// Opens the pipe for writing and closes it, so a process still waiting to read it reads the end
// and exits. The case then leaves nothing behind even when it fails.
function releaseReaders(path: string): void {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // No process is waiting on the pipe.
  }
}

describe.skipIf(!CAN_RUN)('a named pipe that git reads', () => {
  for (const path of ['.git/HEAD', '.git/config', '.git/refs/heads/feature', '.gitignore']) {
    it(`at ${path}: blocks with the deadline's answer before the host's limit and leaves no git running`, async () => {
      const repo = await repository(work, path.replace(/[^a-z]/gu, '-'), IDLE.base, IDLE.change);
      await rm(join(repo, path));
      execFileSync('mkfifo', [join(repo, path)]);

      const run = await stop(dist, repo);
      const left = await processesLeftIn(repo);
      releaseReaders(join(repo, path));

      expect(run.exitMs, `the stop did not end before ${GIVE_UP_MS} ms; stderr: ${run.stderr.slice(0, 400)}`).not.toBeNull();
      expect(run.exitMs!).toBeLessThan(HOST_LIMIT_SECONDS * 1000);
      const answer = answerOf(run);
      expect(answer?.['decision']).toBe('block');
      expect(String(answer?.['reason'])).toMatch(/^NOT verified - usabl ran out of time/u);
      expect(run.stdout + run.stderr).not.toContain('VERIFIED');
      expect(left, 'processes the stop left running in the repository').toEqual([]);
    }, 60_000);
  }
});
