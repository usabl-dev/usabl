/**
 * Writes the summary of the axe world comparison: the fixture harness
 * (test/deps/axe-world-compare.harness.test.ts) and the sweep over the browser tests
 * (vitest.axe-sweep.config.ts).
 *
 *   vite-node scripts/axe-compare-summary.ts -- --out <summary.json> --sweep <sweep.jsonl> <harness.json>...
 *
 * Every difference is copied into the summary in full. Counts are per page. A fixture in a later
 * harness file replaces the same fixture from an earlier one, so a page run again on its own takes
 * the place of its result in the full run. `--sweep-from <summary.json>` keeps the sweep part of an
 * earlier summary in place of `--sweep`, for when only the fixtures were measured again. A kept sweep
 * must come from the same usabl, axe-core, and Playwright versions as this install, and it does not
 * cover browser tests added since it was made. The script writes nothing when any page was unstable,
 * kept sweep included, or when a kept sweep came from other versions. A kept sweep that records no
 * versions, from before the sweep part recorded them, is refused unless `--accept-unversioned-sweep`
 * is passed, and then the output says its versions were not checked.
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

interface Versions {
  usabl: string;
  axeCore: string;
  playwright: string;
}

// The parts of an earlier summary --sweep-from reads.
interface KeptSweep {
  versions?: Versions;
  withDifferences?: Array<{ file: string; test: string; unstable?: boolean }>;
}
interface EarlierSummary {
  sweep?: KeptSweep;
}

function parseArgs(argv: string[]): {
  out: string;
  sweep: string | null;
  sweepFrom: string | null;
  acceptUnversioned: boolean;
  harness: string[];
} {
  let out = '';
  let sweep: string | null = null;
  let sweepFrom: string | null = null;
  let acceptUnversioned = false;
  const harness: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--') continue;
    if (arg === '--accept-unversioned-sweep') {
      acceptUnversioned = true;
    } else if (arg === '--out') {
      out = argv[++index] ?? '';
    } else if (arg === '--sweep') {
      sweep = argv[++index] ?? null;
    } else if (arg === '--sweep-from') {
      sweepFrom = argv[++index] ?? null;
    } else {
      harness.push(arg);
    }
  }
  if (out === '') {
    throw new Error('usage: axe-compare-summary --out <file> [--sweep <file> | --sweep-from <summary.json>] <harness.json>...');
  }
  if (sweep !== null && sweepFrom !== null) {
    throw new Error('axe-compare-summary: pass --sweep or --sweep-from, not both. --sweep-from keeps the sweep part of an earlier summary.');
  }
  if (acceptUnversioned && sweepFrom === null) {
    throw new Error('axe-compare-summary: --accept-unversioned-sweep goes with --sweep-from, the sweep it accepts.');
  }
  return { out, sweep, sweepFrom, acceptUnversioned, harness };
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

const { out, sweep, sweepFrom, acceptUnversioned, harness } = parseArgs(process.argv.slice(2));
// One outcome per fixture. A fixture in a later harness file replaces the same fixture from an
// earlier one, so a page run again on its own, with USABL_AXE_COMPARE_GROUPS, takes the place of
// its result in the full run.
const byFixture = new Map<string, HarnessOutcome>();
for (const file of harness) {
  for (const outcome of JSON.parse(await readFile(file, 'utf8')) as HarnessOutcome[]) {
    byFixture.set(outcome.fixture, outcome);
  }
}
const outcomes: HarnessOutcome[] = [...byFixture.values()];
outcomes.sort((a, b) => (a.fixture < b.fixture ? -1 : a.fixture > b.fixture ? 1 : 0));
const records: SweepRecord[] =
  sweep === null
    ? []
    : (await readFile(sweep, 'utf8'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as SweepRecord);
const require = createRequire(import.meta.url);
// The versions of this install. The summary header names them, and a sweep built here records them.
const installed: Versions = {
  usabl: (require('../package.json') as { version: string }).version,
  axeCore: (require('axe-core/package.json') as { version: string }).version,
  playwright: (require('playwright/package.json') as { version: string }).version,
};

// The sweep part of an earlier summary, kept as it was, when only the fixtures were measured again.
const earlier: EarlierSummary | null = sweepFrom === null ? null : (JSON.parse(await readFile(sweepFrom, 'utf8')) as EarlierSummary);
const earlierSweep: KeptSweep | null = earlier === null ? null : (earlier.sweep ?? null);
if (sweepFrom !== null && earlierSweep === null) {
  process.stderr.write(`axe-compare-summary: not written. ${sweepFrom} has no sweep part to keep.\n`);
  process.exit(1);
}
// A kept sweep must come from this install, or the header of the new summary would name versions
// the sweep did not run with. A sweep built before the sweep part recorded its versions cannot be
// checked: the header of its summary names the install that wrote the summary, which kept an
// earlier sweep as it was, so the header can be newer than the sweep. Such a sweep is refused
// unless --accept-unversioned-sweep says to keep it anyway, and the output then says so.
let keptNote = '';
if (sweepFrom !== null && earlierSweep !== null) {
  const recorded = earlierSweep.versions;
  if (recorded === undefined && !acceptUnversioned) {
    process.stderr.write(
      `axe-compare-summary: not written. The sweep in ${sweepFrom} records no versions, so usabl cannot tell ` +
        'whether it ran on this install. Run the sweep again on this install and pass its log with --sweep, or pass ' +
        '--accept-unversioned-sweep to keep it with its versions unchecked.\n',
    );
    process.exit(1);
  }
  const names: Record<keyof Versions, string> = { usabl: 'usabl', axeCore: 'axe-core', playwright: 'Playwright' };
  const differ =
    recorded === undefined
      ? []
      : (Object.keys(names) as Array<keyof Versions>)
          .filter((key) => recorded[key] !== installed[key])
          .map((key) => `${names[key]} ${recorded[key]} there, ${installed[key]} here`);
  if (differ.length > 0) {
    process.stderr.write(
      `axe-compare-summary: not written. The sweep in ${sweepFrom} was made with other versions than this install ` +
        `(${differ.join('; ')}), so the new summary would name versions the sweep did not run with. ` +
        'Run the sweep again on this install and pass its log with --sweep.\n',
    );
    process.exit(1);
  }
  // A kept sweep holds only the comparisons that differed or failed, so an unstable one is seen
  // only there. Such a comparison says nothing about the engine, as in the refuse rule below.
  const unstableKept = (earlierSweep.withDifferences ?? []).filter((entry) => entry.unstable === true);
  if (unstableKept.length > 0) {
    process.stderr.write(
      `axe-compare-summary: not written. The sweep in ${sweepFrom} holds unstable comparisons, whose results ` +
        `changed between two runs of the same world: ${unstableKept.map((entry) => `"${entry.file} > ${entry.test}"`).join(', ')}. ` +
        'Run the sweep again and pass its log with --sweep.\n',
    );
    process.exit(1);
  }
  if (recorded === undefined) {
    keptNote = ' (it records no versions, so they were not checked)';
  }
}

// A page whose results changed between two runs of the same world was still loading, so its
// differences say nothing about the two worlds. A summary that holds one would read as an engine
// difference, so the script writes nothing and names each such page.
const unstable = [
  ...outcomes.filter((outcome) => outcome.unstable).map((outcome) => `fixture "${outcome.fixture}"`),
  ...records.filter((record) => record.unstable === true).map((record) => `sweep "${record.file} > ${record.test}" (${stablePort(record.page)})`),
];
if (unstable.length > 0) {
  process.stderr.write(
    `axe-compare-summary: not written. These pages were unstable, so their results changed between two runs of ` +
      `the same world and their differences say nothing about the engine: ${unstable.join(', ')}. ` +
      'Run the harness again for them, for example with USABL_AXE_COMPARE_GROUPS, on a machine that is not busy, ' +
      'and build the summary from a run where every page is stable.\n',
  );
  process.exit(1);
}

const plain = outcomes.filter((outcome) => !outcome.internals);
const internals = outcomes.filter((outcome) => outcome.internals);
const byFile: Record<string, number> = {};
for (const record of records) byFile[record.file] = (byFile[record.file] ?? 0) + 1;

const summary = {
  usabl: installed.usabl,
  axeCore: installed.axeCore,
  playwright: installed.playwright,
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
  sweep: earlierSweep ?? sweepPart(),
};
await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
const sweepLine =
  earlierSweep === null
    ? `sweep: ${records.length} comparisons, ${sweepPart().withDifferences.length} differ, ${sweepPart().errors.length} errors`
    : `sweep: kept from ${sweepFrom}${keptNote}`;
process.stdout.write(
  `fixtures: ${outcomes.length} pages, ${plain.filter((o) => o.differences.length > 0).length} without internals differ, ` +
    `${internals.filter((o) => o.differences.length > 0).length} with internals differ; ${sweepLine}\n`,
);

function sweepPart() {
  return {
    // The sweep's own record of the versions it ran with, so a later --sweep-from can check them.
    versions: installed,
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
  };
}
