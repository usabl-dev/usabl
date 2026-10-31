/**
 * A file usabl cannot place on any screen is named with its path, why it could not be placed,
 * and the fix, on both commands an operator meets it in: baseline and check. The fixture is a
 * shared layout imported by every route through an alias usabl cannot follow.
 */
import { describe, expect, it } from 'vitest';
import type { ScreenScan } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { runBaseline } from '../../src/baseline/index.js';
import { run } from '../../src/run.js';
import { formatSummary } from '../../src/output/summary.js';
import { SHARED_LAYOUT_FILE, sharedLayoutConfig, sharedLayoutFiles } from '../fixtures/shared-layout-app.js';

const FIX = /add it to the files of a surface in usabl\.config\.json, or add the route that renders it to usabl\.routes\.json/;

function cleanScan(screenId: string, url: string): ScreenScan {
  return { screenId, url, stops: [], drafts: [], gaps: [], applicability: [], reachedSelectorPresent: null };
}

const scans = {
  home: cleanScan('home', 'http://127.0.0.1:5173/'),
  settings: cleanScan('settings', 'http://127.0.0.1:5173/settings'),
};

function fixtureDeps() {
  return makeFakeDeps({ files: sharedLayoutFiles, headContents: sharedLayoutFiles, scans });
}

describe('a shared file usabl cannot place on a screen', () => {
  it('gets a gap that says why and names the fix', async () => {
    const coverage = await computeCoverage(fixtureDeps().fs, sharedLayoutConfig, [
      'src/pages/Home.tsx',
      SHARED_LAYOUT_FILE,
    ]);
    expect(coverage.unresolvedFiles).toEqual([SHARED_LAYOUT_FILE]);
    const gap = coverage.gaps.find((entry) => entry.ref === SHARED_LAYOUT_FILE);
    expect(gap?.state).toBe('unresolved');
    expect(gap?.reason).toContain("could not resolve '@/layout/AppLayout' in src/pages/Home.tsx");
    expect(gap?.reason).toMatch(FIX);
  });

  it('is named by baseline with its path, the reason, and the fix', async () => {
    const writes: string[] = [];
    const outcome = await runBaseline(fixtureDeps(), sharedLayoutConfig, {
      writeFile: async (path) => {
        writes.push(path);
      },
    });
    expect(outcome.exitCode).toBe(3);
    expect(writes).toEqual([]);
    const line = outcome.message.split('\n').find((entry) => entry.includes(SHARED_LAYOUT_FILE));
    expect(line, outcome.message).toBeDefined();
    expect(line).toMatch(/^ {2}- src\/layout\/AppLayout\.tsx: /);
    expect(line).toContain("could not resolve '@/layout/AppLayout'");
    expect(line).toMatch(FIX);
  });

  it('is named by baseline --partial too, which floors the screens it could scan', async () => {
    const writes: string[] = [];
    const outcome = await runBaseline(
      fixtureDeps(),
      sharedLayoutConfig,
      {
        writeFile: async (path) => {
          writes.push(path);
        },
      },
      { partial: true },
    );
    expect(outcome.exitCode).toBe(0);
    expect(writes).toEqual(['.usabl-evidence.json']);
    expect(outcome.message).toContain(`- ${SHARED_LAYOUT_FILE}: `);
    expect(outcome.message).toMatch(FIX);
  });

  it('is named by check with every unplaced path', async () => {
    const extra = 'src/layout/Footer.tsx';
    const deps = makeFakeDeps({
      files: { ...sharedLayoutFiles, [extra]: 'export function Footer() { return null }\n' },
      headContents: { ...sharedLayoutFiles, [extra]: 'export function Footer() { return null }\n' },
      scans,
    });
    const result = await run(deps, sharedLayoutConfig, { changedFiles: [SHARED_LAYOUT_FILE, extra] });
    expect(result.verdict).toBe('not_covered');
    const text = formatSummary(result);
    for (const file of [SHARED_LAYOUT_FILE, extra]) {
      expect(text, text).toContain(`${file}: `);
    }
    expect(text, text).toMatch(FIX);
    // No page text: every unplaced line is a repository path and usabl's own words.
    expect(text).not.toContain('http://127.0.0.1:5173/settings');
  });
});
