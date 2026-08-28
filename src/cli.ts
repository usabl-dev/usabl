/**
 * CLI command implementation.
 * Check, comment, and self-check project a gated Result from `run()`.
 * `enforce` reads that Result from stdin and exits a CI status. It never
 * calls `gate()`. GitHub review lookup lives here, not in `run()`.
 * `init` writes draft policy only and must return before `loadConfig` / `run`
 * so this process cannot consume files it just generated.
 * The CLI never mints verdicts.
 * Sample `usabl.config.json` URLs (`http://127.0.0.1:5173`) are the fixture app's
 * Vite origin, not a hardcoded engine target. The engine always reads operator config.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { run } from './run.js';
import type { UsablConfig } from './contracts/index.js';
import { buildDeps } from './deps/build.js';
import { makeFsGlob } from './deps/fs.js';
import { formatInitReport, inferInit, writeInitDrafts, type InitFs } from './init/index.js';
import { runBaseline, type BaselineFs } from './baseline/index.js';
import { makeGitReader } from './deps/git.js';
import { parseUsablConfig } from './intake/config.js';
import { ciRefusal, mergeChangedPaths, parseCliArgs, projectCli, type CliOptions } from './surfaces/cli.js';
import { projectPrComment } from './surfaces/pr-comment.js';
import { collectReviews, enforceAccessibility, enforcePolicy, parsePullRequestEvent, parseResultJson } from './surfaces/policy-enforce.js';
import { projectSelfCheck } from './surfaces/self-check.js';
import { BYPASS_ONCE_PATH, RECEIPT_DIR, saveReceipt, type ReceiptFs } from './surfaces/receipt-store.js';

export async function loadConfig(path = 'usabl.config.json'): Promise<UsablConfig> {
  // Targets come from config so the same engine can run in local, CI, and preview environments.
  return parseUsablConfig(await readFile(path, 'utf8'));
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
}

async function runEnforce(opts: CliOptions): Promise<number> {
  try {
    if (opts.enforceCheck !== 'accessibility' && opts.enforceCheck !== 'policy') {
      process.stderr.write('usabl: enforce requires accessibility or policy\n');
      return 2;
    }
    const parsed: unknown = JSON.parse(await readStdin());
    const result = parseResultJson(parsed);
    if (opts.enforceCheck === 'accessibility') {
      const outcome = enforceAccessibility(result);
      process.stdout.write(`${outcome.message}\n`);
      return outcome.exitCode;
    }
    if (opts.trustedRef === null) {
      process.stderr.write('usabl: enforce policy requires --trusted-ref\n');
      return 2;
    }
    const pr = parsePullRequestEvent(readEventPayload());
    if (pr === null) {
      process.stderr.write('usabl: GITHUB_EVENT_PATH must describe a pull request\n');
      return 2;
    }
    const git = makeGitReader();
    const outcome = await enforcePolicy(result, {
      trustedRef: opts.trustedRef,
      pr,
      git: { show: (ref, path) => git.show(ref, path), lsFiles: (ref, prefix) => git.lsFiles(ref, prefix) },
      listReviews: () => listPullReviews(pr.number),
    });
    process.stdout.write(`${outcome.message}\n`);
    return outcome.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`usabl: ${message}\n`);
    return 4;
  }
}

function readEventPayload(): unknown {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined || eventPath.length === 0) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
}

async function listPullReviews(pullNumber: number): Promise<Array<{ userLogin: string; state: string; commitId: string }>> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (token === undefined || token.length === 0 || repo === undefined || repo.length === 0) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required for enforce policy');
  }
  return collectReviews(async (page) => {
    const url = `https://api.github.com/repos/${repo}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'usabl',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub reviews request failed (${response.status})`);
    }
    return response.json();
  });
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
    opts.command !== 'init' &&
    opts.command !== 'baseline' &&
    opts.command !== 'enforce'
  ) {
    process.stderr.write(`unknown command: ${opts.command}\n`);
    return 2;
  }

  if (opts.command === 'init') {
    // Init is a generator, not a check. Returning here keeps draft writes off
    // the verdict path and prevents a same-run consume of the new sidecar.
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

  if (opts.command === 'baseline') {
    // Baseline is an explicit local generator. It writes only the floor draft and returns.
    const config = await loadConfig(opts.configPath);
    const deps = await buildDeps(config, {
      ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
    });
    try {
      const baselineFs: BaselineFs = {
        writeFile: async (path, contents) => {
          await writeFile(path, contents, 'utf8');
        },
      };
      const outcome = await runBaseline(deps, config, baselineFs, {
        ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
      });
      if (outcome.exitCode === 0) {
        process.stdout.write(`${outcome.message}\n`);
      } else {
        process.stderr.write(`usabl: ${outcome.message}\n`);
      }
      return outcome.exitCode;
    } finally {
      await deps.browser.close();
    }
  }

  if (opts.command === 'comment') {
    // Comment mode is a pure projection from stdin so CI does not import package internals.
    const parsed: unknown = JSON.parse(await readStdin());
    const result = parseResultJson(parsed);
    process.stdout.write(projectPrComment(result) + '\n');
    return result.exitCode;
  }

  if (opts.command === 'enforce') {
    return runEnforce(opts);
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
    ...(opts.trustedRef === null ? {} : { trustedRef: opts.trustedRef }),
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
