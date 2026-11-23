/**
 * The axe world comparison summary is committed and read as a record of how the two worlds differ.
 * A page whose results changed between two runs of the same world was still loading, so its
 * differences say nothing about the engine. The script refuses to write a summary that holds one.
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

const require = createRequire(import.meta.url);
// The versions of this install, as the script reads them.
const INSTALLED = {
  usabl: (require('../../package.json') as { version: string }).version,
  axeCore: (require('axe-core/package.json') as { version: string }).version,
  playwright: (require('playwright/package.json') as { version: string }).version,
};

// A sweep part with no differences, as an earlier summary holds it.
const SWEEP = { comparisons: 7, byFile: { 'test/a.test.ts': 7 }, comparedEntries: { pass: 70 }, withDifferences: [], withUncheckedFrames: [], errors: [] };

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

  it('takes a fixture from a later harness file over an earlier one, so a page can be run again on its own', async () => {
    const full = join(dir, 'full.json');
    await writeFile(full, JSON.stringify([outcome('frame: frameset', true), outcome('cell: named', false)]));
    const rerun = join(dir, 'rerun.json');
    await writeFile(rerun, JSON.stringify([{ ...outcome('frame: frameset', false), counts: { violation: 8, incomplete: 0, pass: 45, inapplicable: 63 } }]));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, full, rerun]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(await readFile(out, 'utf8')) as {
      fixtures: { pages: number; withoutInternals: { unstablePages: number }; perPage: Array<{ fixture: string; counts: Record<string, number> }> };
    };
    expect(summary.fixtures.pages).toBe(2);
    expect(summary.fixtures.withoutInternals.unstablePages).toBe(0);
    expect(summary.fixtures.perPage.find((page) => page.fixture === 'frame: frameset')?.counts['violation']).toBe(8);
  }, 60_000);

  it('keeps the sweep part of an earlier summary when asked, so the fixtures can be measured again on their own', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const earlier = join(dir, 'earlier.json');
    const sweep = { ...SWEEP, versions: INSTALLED };
    await writeFile(earlier, JSON.stringify({ ...INSTALLED, fixtures: {}, sweep }));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--sweep-from', earlier, harness]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(await readFile(out, 'utf8')) as { sweep: unknown; fixtures: { pages: number } };
    expect(summary.sweep).toEqual(sweep);
    expect(summary.fixtures.pages).toBe(1);
  }, 60_000);

  it('records the usabl, axe-core, and Playwright versions in the sweep part it builds', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const sweep = join(dir, 'sweep.jsonl');
    await writeFile(sweep, `${JSON.stringify({ file: 'test/a.test.ts', test: 'a case', via: 'axe', page: '/a', counts: { pass: 1 } })}\n`);
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--sweep', sweep, harness]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(await readFile(out, 'utf8')) as { usabl: string; sweep: { versions: unknown } };
    expect(summary.sweep.versions).toEqual(INSTALLED);
    expect(summary.usabl).toBe(INSTALLED.usabl);
  }, 60_000);

  // The summary header names the versions of this install, so a sweep kept from another version
  // would sit under a header that does not describe it.
  for (const [name, changed] of [
    ['axe-core', { axeCore: '4.0.0' }],
    ['Playwright', { playwright: '1.0.0' }],
    ['usabl', { usabl: '0.0.1' }],
  ] as const) {
    it(`refuses to keep a sweep made with another ${name} version, and names both versions`, async () => {
      const harness = join(dir, 'harness.json');
      await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
      const earlier = join(dir, 'earlier.json');
      const versions = { ...INSTALLED, ...changed };
      await writeFile(earlier, JSON.stringify({ ...INSTALLED, fixtures: {}, sweep: { ...SWEEP, versions } }));
      const out = join(dir, 'summary.json');

      const result = await runSummary(['--out', out, '--sweep-from', earlier, harness]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('not written');
      expect(result.stderr).toContain(name);
      expect(result.stderr).toContain(Object.values(changed)[0]);
      expect(result.stderr).toContain('--sweep');
      expect(await exists(out)).toBe(false);
    }, 60_000);
  }

  // A summary's header names the install that wrote the summary, which is not always the install
  // that ran the sweep it kept, so a sweep with no versions of its own cannot be checked at all.
  it('refuses to keep a sweep with no versions of its own, even under a header that names this install', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const earlier = join(dir, 'earlier.json');
    await writeFile(earlier, JSON.stringify({ ...INSTALLED, fixtures: {}, sweep: SWEEP }));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--sweep-from', earlier, harness]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not written');
    expect(result.stderr).toContain('records no versions');
    expect(result.stderr).toContain('--accept-unversioned-sweep');
    expect(await exists(out)).toBe(false);
  }, 60_000);

  it('keeps a sweep with no versions of its own with --accept-unversioned-sweep, and says its versions were not checked', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const earlier = join(dir, 'earlier.json');
    await writeFile(earlier, JSON.stringify({ axeCore: 'x', playwright: 'y', fixtures: {}, sweep: SWEEP }));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--sweep-from', earlier, '--accept-unversioned-sweep', harness]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('records no versions, so they were not checked');
    const summary = JSON.parse(await readFile(out, 'utf8')) as { sweep: unknown };
    expect(summary.sweep).toEqual(SWEEP);
  }, 60_000);

  it('refuses --accept-unversioned-sweep without --sweep-from', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--accept-unversioned-sweep', harness]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--accept-unversioned-sweep');
    expect(await exists(out)).toBe(false);
  }, 60_000);

  it('refuses to keep a sweep that holds an unstable comparison', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const earlier = join(dir, 'earlier.json');
    const unstableEntry = { file: 'test/b.test.ts', test: 'b case', page: '/b', unstable: true, differences: [] };
    await writeFile(
      earlier,
      JSON.stringify({ ...INSTALLED, fixtures: {}, sweep: { ...SWEEP, versions: INSTALLED, withDifferences: [unstableEntry] } }),
    );
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--sweep-from', earlier, harness]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unstable');
    expect(result.stderr).toContain('test/b.test.ts');
    expect(await exists(out)).toBe(false);
  }, 60_000);

  it('refuses both a sweep log and an earlier sweep part', async () => {
    const harness = join(dir, 'harness.json');
    await writeFile(harness, JSON.stringify([outcome('cell: named', false)]));
    const out = join(dir, 'summary.json');

    const result = await runSummary(['--out', out, '--sweep', join(dir, 'a.jsonl'), '--sweep-from', join(dir, 'b.json'), harness]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--sweep-from');
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
