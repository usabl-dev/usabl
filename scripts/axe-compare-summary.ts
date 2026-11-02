/**
 * Writes the summary of the axe world comparison: the fixture harness
 * (test/deps/axe-world-compare.harness.test.ts) and the sweep over the browser tests
 * (vitest.axe-sweep.config.ts).
 *
 *   vite-node scripts/axe-compare-summary.ts -- --out <summary.json> --sweep <sweep.jsonl> <harness.json>...
 *
 * Every difference is copied into the summary in full. Counts are per page.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

interface Difference {
  entry: { category: string; rule: string; target: string | null; impact: string | null; elementKey: string | null };
  pageWorld: number;
  isolated: number;
}

interface HarnessOutcome {
  fixture: string;
  internals: boolean;
  counts: Record<string, number>;
  differences: Difference[];
  uncheckedFrames: Array<{ origin: string; why: string }>;
  unstable: boolean;
}

interface SweepRecord {
  file: string;
  test: string;
  via: string;
  page: string;
  counts?: Record<string, number>;
  differences?: Difference[];
  uncheckedFrames?: Array<{ origin: string; why: string }>;
  unstable?: boolean;
  error?: string;
}

function parseArgs(argv: string[]): { out: string; sweep: string | null; harness: string[] } {
  let out = '';
  let sweep: string | null = null;
  const harness: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--') continue;
    if (arg === '--out') {
      out = argv[++index] ?? '';
    } else if (arg === '--sweep') {
      sweep = argv[++index] ?? null;
    } else {
      harness.push(arg);
    }
  }
  if (out === '') throw new Error('usage: axe-compare-summary --out <file> [--sweep <file>] <harness.json>...');
  return { out, sweep, harness };
}

// The origin is the only part of a frame address that reaches the summary, and test servers listen
// on a random port, so the port is replaced.
function stablePort(text: string): string {
  return text.replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:<port>');
}

function total(rows: Array<Record<string, number> | undefined>): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row ?? {})) sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
}

const { out, sweep, harness } = parseArgs(process.argv.slice(2));
const outcomes: HarnessOutcome[] = [];
for (const file of harness) {
  outcomes.push(...(JSON.parse(await readFile(file, 'utf8')) as HarnessOutcome[]));
}
outcomes.sort((a, b) => (a.fixture < b.fixture ? -1 : a.fixture > b.fixture ? 1 : 0));
const records: SweepRecord[] =
  sweep === null
    ? []
    : (await readFile(sweep, 'utf8'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as SweepRecord);

const plain = outcomes.filter((outcome) => !outcome.internals);
const internals = outcomes.filter((outcome) => outcome.internals);
const byFile: Record<string, number> = {};
for (const record of records) byFile[record.file] = (byFile[record.file] ?? 0) + 1;

const require = createRequire(import.meta.url);
const summary = {
  axeCore: (require('axe-core/package.json') as { version: string }).version,
  playwright: (require('playwright/package.json') as { version: string }).version,
  fixtures: {
    pages: outcomes.length,
    withoutInternals: {
      pages: plain.length,
      pagesWithDifferences: plain.filter((outcome) => outcome.differences.length > 0).length,
      unstablePages: plain.filter((outcome) => outcome.unstable).length,
      comparedEntries: total(plain.map((outcome) => outcome.counts)),
    },
    withInternals: {
      pages: internals.length,
      pagesWithDifferences: internals.filter((outcome) => outcome.differences.length > 0).length,
      comparedEntries: total(internals.map((outcome) => outcome.counts)),
    },
    perPage: outcomes.map((outcome) => ({
      fixture: outcome.fixture,
      internals: outcome.internals,
      counts: outcome.counts,
      differences: outcome.differences.length,
      uncheckedFrames: outcome.uncheckedFrames.map((frame) => `${stablePort(frame.origin)}: ${frame.why}`),
    })),
    differences: outcomes
      .filter((outcome) => outcome.differences.length > 0)
      .map((outcome) => ({ fixture: outcome.fixture, internals: outcome.internals, differences: outcome.differences })),
  },
  sweep: {
    comparisons: records.length,
    byFile,
    comparedEntries: total(records.map((record) => record.counts)),
    withDifferences: records
      .filter((record) => (record.differences ?? []).length > 0)
      .map((record) => ({ file: record.file, test: record.test, page: record.page, unstable: record.unstable, differences: record.differences })),
    withUncheckedFrames: records
      .filter((record) => (record.uncheckedFrames ?? []).length > 0)
      .map((record) => ({ file: record.file, test: record.test, uncheckedFrames: record.uncheckedFrames })),
    errors: records
      .filter((record) => record.error !== undefined)
      .map((record) => ({ file: record.file, test: record.test, page: record.page, error: stablePort(record.error ?? '') })),
  },
};
await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(
  `fixtures: ${outcomes.length} pages, ${plain.filter((o) => o.differences.length > 0).length} without internals differ, ` +
    `${internals.filter((o) => o.differences.length > 0).length} with internals differ; ` +
    `sweep: ${records.length} comparisons, ${summary.sweep.withDifferences.length} differ, ${summary.sweep.errors.length} errors\n`,
);
