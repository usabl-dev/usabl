/**
 * CLI command implementation over `run()`.
 * The CLI never mints verdicts. It only parses args, runs the engine, and projects.
 * Sample `usabl.config.json` URLs (`http://127.0.0.1:5173`) are the fixture app's
 * Vite origin, not a hardcoded engine target. The engine always reads operator config.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { run } from './run.js';
import type { Result, SurfaceConfig, UsablConfig } from './contracts/index.js';
import { buildDeps } from './deps/build.js';
import { makeFsGlob } from './deps/fs.js';
import { formatInitReport, inferInit, writeInitDrafts, type InitFs } from './init/index.js';
import { ciRefusal, mergeChangedPaths, parseCliArgs, projectCli } from './surfaces/cli.js';
import { projectPrComment } from './surfaces/pr-comment.js';
import { projectSelfCheck } from './surfaces/self-check.js';
import { BYPASS_ONCE_PATH, RECEIPT_DIR, saveReceipt, type ReceiptFs } from './surfaces/receipt-store.js';

function expectObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function parseSurface(raw: unknown, index: number): SurfaceConfig {
  const surface = expectObject(raw, `surfaces[${index}]`);
  return {
    id: expectString(Reflect.get(surface, 'id'), `surfaces[${index}].id`),
    url: expectString(Reflect.get(surface, 'url'), `surfaces[${index}].url`),
    files: expectStringArray(Reflect.get(surface, 'files'), `surfaces[${index}].files`),
  };
}

function parseConfig(raw: string): UsablConfig {
  const parsed: unknown = JSON.parse(raw);
  const root = expectObject(parsed, 'config');
  const discovery = expectObject(Reflect.get(root, 'discovery'), 'discovery');
  const surfacesRaw = Reflect.get(root, 'surfaces');
  if (!Array.isArray(surfacesRaw)) {
    throw new Error('surfaces must be an array');
  }

  const requirementsRaw = Reflect.get(root, 'requirements');
  const requirements =
    requirementsRaw === undefined ? undefined : expectString(requirementsRaw, 'requirements');

  const promotedRaw = Reflect.get(root, 'promotedObligations');
  const promotedObligations =
    promotedRaw === undefined ? undefined : expectStringArray(promotedRaw, 'promotedObligations');

  return {
    appBaseUrl: expectString(Reflect.get(root, 'appBaseUrl'), 'appBaseUrl'),
    uiFileGlobs: expectStringArray(Reflect.get(root, 'uiFileGlobs'), 'uiFileGlobs'),
    discovery: {
      routerFile: expectString(Reflect.get(discovery, 'routerFile'), 'discovery.routerFile'),
      wideBlastGlobs: expectStringArray(Reflect.get(discovery, 'wideBlastGlobs'), 'discovery.wideBlastGlobs'),
    },
    surfaces: surfacesRaw.map((surface, index) => parseSurface(surface, index)),
    guardedPaths: expectStringArray(Reflect.get(root, 'guardedPaths'), 'guardedPaths'),
    ...(requirements === undefined ? {} : { requirements }),
    ...(promotedObligations === undefined ? {} : { promotedObligations }),
  };
}

export async function loadConfig(path = 'usabl.config.json'): Promise<UsablConfig> {
  // Targets come from config so the same engine can run in local, CI, and preview environments.
  return parseConfig(await readFile(path, 'utf8'));
}

function expectResult(value: unknown): Result {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('comment input must be a Result object');
  }
  const schemaVersion = Reflect.get(value, 'schemaVersion');
  if (schemaVersion !== 'usabl.result.v1') {
    throw new Error('comment input must have schemaVersion usabl.result.v1');
  }
  return value as Result;
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`usabl: ${message}\n`);
    return 2;
  }

  if (
    opts.command !== 'check' &&
    opts.command !== 'comment' &&
    opts.command !== 'bypass' &&
    opts.command !== 'init'
  ) {
    process.stderr.write(`unknown command: ${opts.command}\n`);
    return 2;
  }

  if (opts.command === 'init') {
    const globber = makeFsGlob();
    const initFs: InitFs = {
      readFile: globber.readFile,
      glob: globber.glob,
      writeFile: async (path, contents) => {
        await writeFile(path, contents, 'utf8');
      },
    };
    const draft = await inferInit(initFs);
    const result = await writeInitDrafts(initFs, draft, { force: opts.force });
    process.stdout.write(formatInitReport(draft, result));
    return result.ok ? 0 : 2;
  }

  if (opts.command === 'bypass') {
    await mkdir(RECEIPT_DIR, { recursive: true });
    await writeFile(BYPASS_ONCE_PATH, `${new Date().toISOString()}\n`, 'utf8');
    process.stdout.write('NOT verified - BYPASS set for the next stop only.\n');
    return 0;
  }

  if (opts.command === 'comment') {
    // Comment mode is a pure projection from stdin so CI does not import package internals.
    const parsed: unknown = JSON.parse(await readStdin());
    const result = expectResult(parsed);
    process.stdout.write(projectPrComment(result) + '\n');
    return result.exitCode;
  }

  const refusal = ciRefusal(opts);
  if (refusal !== null) {
    process.stderr.write(`usabl: ${refusal.message}\n`);
    return refusal.exitCode;
  }

  const config = await loadConfig(opts.configPath);
  const deps = await buildDeps(config, {
    // Static-only denies live checks as explicit capability gaps instead of silent omission.
    allowedCapabilities: opts.staticOnly ? [] : ['live'],
  });
  try {
    let changedFiles: string[] | undefined;
    if (opts.trustedRef !== null) {
      // Merge-base diff covers CI checkouts; status paths keep local dirty files in scope.
      const diffNames = await deps.git.diffNameOnly(opts.trustedRef);
      const statusPaths = (await deps.git.statusZ()).map((entry) => entry.path);
      changedFiles = mergeChangedPaths(diffNames, statusPaths);
    }

    const result = await run(deps, config, {
      ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
      ...(changedFiles === undefined ? {} : { changedFiles }),
    });
    if (result.verdict === 'verified' && result.receipt !== null) {
      const receiptFs: ReceiptFs = {
        readFile: async () => null,
        writeFile: async (path, contents) => {
          await writeFile(path, contents, 'utf8');
        },
        mkdir: async (path) => {
          await mkdir(path, { recursive: true });
        },
      };
      // Verified checks persist local proof so the stop-hook fast path can re-check without a browser.
      await saveReceipt(receiptFs, result.receipt);
    }
    if (opts.selfCheck) {
      // Self-check is advisory and keeps exit 0 so stop-hook remains the only gate for continuation.
      const advisory = projectSelfCheck(result);
      process.stdout.write(advisory.message + '\n');
      return advisory.advisoryExitCode;
    }
    const projected = projectCli(result);
    process.stdout.write((opts.json ? projected.json : projected.text) + '\n');
    return projected.exitCode;
  } finally {
    // Always close browser resources, even when run() throws before returning a Result.
    await deps.browser.close();
  }
}
