/**
 * The axe world comparison summary is committed and read as a record of how the two worlds differ.
 * A page whose results changed between two runs of the same world was still loading, so its
 * differences say nothing about the engine. The script refuses to write a summary that holds one.
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const viteNode = resolve('node_modules/.bin/vite-node');
const scriptPath = resolve('scripts/axe-compare-summary.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runSummary(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(viteNode, [scriptPath, '--', ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outcome(fixture: string, unstable: boolean) {
  return {
    fixture,
    internals: false,
    counts: { violation: 1, incomplete: 0, pass: 2, inapplicable: 3 },
    differences: [],
    uncheckedFrames: [],
    unstable,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('axe-compare-summary', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usabl-axe-summary-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to write a summary when a fixture page was unstable, and names the page', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('frame: frameset', true), outcome('cell: named', false)]));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, harness]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unstable');
    expect(result.stderr).toContain('frame: frameset');
    expect(await exists(out)).toBe(false);
  }, 60_000);

  it('refuses to write a summary when a sweep comparison was unstable', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const sweep = join(dir, 'sweep.jsonl');
    await writeFile(sweep, `${JSON.stringify({ file: 'test/a.test.ts', test: 'a case', via: 'axe', page: '/a', counts: {}, unstable: true })}\n`);
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--sweep', sweep, harness]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unstable');
    expect(result.stderr).toContain('test/a.test.ts');
    expect(await exists(out)).toBe(false);
  }, 60_000);

  it('writes the summary when every page was stable', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, harness]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(await readFile(out, 'utf8')) as { fixtures: { pages: number; withoutInternals: { unstablePages: number } } };
    expect(summary.fixtures.pages).toBe(1);
    expect(summary.fixtures.withoutInternals.unstablePages).toBe(0);
  }, 60_000);
});
