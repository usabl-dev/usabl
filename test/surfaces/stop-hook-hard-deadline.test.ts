/**
 * The Stop hook's deadline holds even while the checks hold their own thread. A timer can fire only
 * between pieces of work in its thread, and an agent can write input that makes one piece of the
 * checks run for minutes: one long line that a slow pattern reads, or many files against many
 * imports that the test file placement compares. A hook the host ends at its limit gives no
 * answer, and the stop goes on with nothing checked. So the stop-hook command runs the checks in a
 * worker thread, and its own thread keeps the deadline.
 *
 * Each case runs the real stop-hook command in a child process, as the host runs it, from a bundle
 * built from src with the package's own build tool, on a real git repository. The hook's limit is
 * 30 seconds, so usabl's own deadline is 15 seconds. The answer must reach the host, and the
 * process must end, before the 30 seconds pass.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerOf,
  bundle,
  DEADLINE_MS,
  GIVE_UP_MS,
  HOST_LIMIT_SECONDS,
  makeWork,
  removeWork,
  repository,
  ROOT,
  stop,
  type StopRun,
} from '../support/real-stop-hook.js';

// What the answer may take past usabl's deadline: the timer firing and the answer being written.
const ANSWER_SLACK_MS = 3_000;

let work = '';
let realDist = '';
let heldDist = '';
let endingDist = '';

beforeAll(async () => {
  work = await makeWork('usabl-hard-deadline-');
  realDist = await bundle(work, 'real');
  heldDist = await bundle(work, 'held', join(ROOT, 'test/support/held-stop-hook-worker.ts'));
  endingDist = await bundle(work, 'ending', join(ROOT, 'test/support/ending-stop-hook-worker.ts'));
}, 120_000);

afterAll(async () => {
  await removeWork(work);
});

// What every stop here must do, whatever it found: answer by usabl's deadline and a small margin,
// end before the host's limit, write one answer at most, and never say VERIFIED or save a receipt.
// An allow with nothing to show writes no stdout line, so its answer is the end of the process.
function expectAnsweredInTime(run: StopRun, repo: string): void {
  expect(run.exitMs, `the stop gave no answer before ${GIVE_UP_MS} ms; stderr: ${run.stderr.slice(0, 400)}`).not.toBeNull();
  expect(run.answerMs ?? run.exitMs!).toBeLessThan(DEADLINE_MS + ANSWER_SLACK_MS);
  expect(run.exitMs!).toBeLessThan(HOST_LIMIT_SECONDS * 1000);
  expect(run.stdout.split('\n').filter((line) => line.trim().length > 0).length).toBeLessThanOrEqual(1);
  expect(run.stdout + run.stderr).not.toContain('VERIFIED');
  expect(existsSync(join(repo, '.usabl', 'receipt.json'))).toBe(false);
}

describe('the Stop hook deadline while the checks hold their thread', () => {
  it('blocks with the out-of-time message at the deadline when the checks never yield', async () => {
    const repo = await repository(work, 'held', {}, { 'src/App.tsx': 'export const App = 2;\n' });

    const run = await stop(heldDist, repo);

    expectAnsweredInTime(run, repo);
    expect(run.answerMs).not.toBeNull();
    expect(run.answerMs!).toBeGreaterThanOrEqual(DEADLINE_MS - 1_000);
    expect(run.answerMs!).toBeLessThan(DEADLINE_MS + ANSWER_SLACK_MS);
    const answer = answerOf(run);
    expect(answer?.['decision']).toBe('block');
    expect(String(answer?.['reason'])).toMatch(/^NOT verified - usabl ran out of time: .* 15 seconds/u);
    expect(String(answer?.['reason'])).toContain('Nothing is proven about this change, and no receipt was saved.');
  }, 60_000);

  it('gives the stop hook error answer, without blocking, when the worker ends before it answers', async () => {
    const repo = await repository(work, 'ending', {}, { 'src/App.tsx': 'export const App = 2;\n' });

    const run = await stop(endingDist, repo);

    expectAnsweredInTime(run, repo);
    const message = String(answerOf(run)?.['systemMessage']);
    expect(message).toMatch(/^NOT verified - stop hook error: /u);
    expect(message).toContain('ended with exit code 3 before it answered');
    expect(answerOf(run)?.['decision']).toBeUndefined();
  }, 60_000);

  it('answers in time when one changed file has a line that a slow pattern would read for minutes', async () => {
    // One import statement with 150,000 spaces in it: valid JavaScript, read by the import reader.
    const line = `import${' '.repeat(150_000)}'./styles.css';\n`;
    const repo = await repository(work, 'long-line', {}, { 'src/Long.tsx': line });

    const run = await stop(realDist, repo);

    expectAnsweredInTime(run, repo);
    // The check finishes in time and blocks on the file it could not place, or the deadline
    // blocks first. Either is a block that says the change is not verified.
    const answer = answerOf(run);
    expect(answer?.['decision']).toBe('block');
    expect(String(answer?.['reason'])).toMatch(/^(NOT COVERED \(exit 3\): )?NOT verified/u);
  }, 60_000);

  it('answers in time when placement would compare 20,000 test files with 4,000 unresolved imports', async () => {
    const base: Record<string, string> = {};
    for (let index = 0; index < 20_000; index += 1) {
      base[`src/__tests__/f${String(index).padStart(5, '0')}.test.ts`] = 'export const t = 1;\n';
    }
    const imports = Array.from({ length: 4_000 }, (_, index) => `import k${index} from '#k${index}';`).join('\n');
    base['src/App.tsx'] = `${imports}\nexport const App = 1;\n`;
    const repo = await repository(work, 'placement', base, { 'src/__tests__/f00007.test.ts': 'export const t = 2;\n' });

    const run = await stop(realDist, repo);

    expectAnsweredInTime(run, repo);
    expect(run.stdout + run.stderr).toMatch(/NOT verified|NO VERDICT/u);
  }, 120_000);
});
