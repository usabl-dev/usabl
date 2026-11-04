/**
 * A local rehearsal of the generated app gate against a hostile pull request. Gated behind
 * USABL_INTEGRATION=1 like the other real-browser suites.
 *
 * The harness plays the jobs on this machine by running the exact `run:` bodies of the generated
 * workflow, parsed from USABL_GATE_WORKFLOW, through bash. The `uses:` steps (checkout, setup,
 * artifact upload, the untrusted build job's engine download, the comment post) are stood in by
 * small handlers, and each job gets its own workspace and its own runner temp directory, the way
 * each job gets its own VM. Artifacts move between jobs only through a store directory, which is
 * the one channel a hosted run gives them. Trusted jobs take them the way the generated workflow
 * does: usabl's own fetcher, run from its generated step, against a local stand-in for the GitHub
 * artifact API that serves each stored file as a zip. Steps that need the network or root are noted
 * where they are skipped.
 *
 * The pull request is hostile on purpose. Its build writes a forged clean Result into the build
 * output, into its own workspace, and into its own runner temp directory, and leaves a background
 * process rewriting every usabl-result.json it can find. It commits a forged Result at the repo
 * root, and node_modules packages named like the engine's own dependencies, with a payload that
 * writes a marker file when loaded. The judge must report the real barrier the head adds and ignore all
 * of it. Tampered artifacts must fail closed, and a Result replaced after upload must be refused.
 *
 * What this does not prove: the jobs share one kernel here, so this shows the judge never reads
 * what the build wrote, not that the build could not reach it. On hosted runners each job is its
 * own VM. The policy job is not played, because it needs the GitHub reviews API.
 *
 * A pull request from a fork is played too: the gate needs no secret, so a fork runs it the same
 * way, and its comment goes to the run summary because a fork's token cannot write to it.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUIRED_GATE_JOB, TRUSTED_ENGINE_STEP, USABL_GATE_WORKFLOW } from '../../src/install/ci.js';
import { makeZip, startArtifactApi, type ArtifactApi, type StoredArtifact } from '../support/zip.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BASE_REPOSITORY = 'example/hostile-app';
const RUN_ID = '7001';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
  'working-directory'?: string;
}

interface Job {
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}

const WORKFLOW = load(USABL_GATE_WORKFLOW) as { jobs: Record<string, Job> };

interface JobRun {
  result: 'success' | 'failure';
  outputs: Record<string, string>;
  log: string[];
  comment: string | null;
  // What the job wrote to its run summary.
  summary: string;
}

interface Needs {
  [job: string]: { result: string; outputs: Record<string, string> };
}

interface Rehearsal {
  root: string;
  store: string;
  api: ArtifactApi;
  sourceRepo: string;
  headSha: string;
  baseSha: string;
  port: number;
  marker: string;
  pids: string[];
}

// Steps run asynchronously, so a long job never blocks the test worker's own event loop.
function runBash(
  script: string,
  options: { cwd: string; env: Record<string, string> },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-e', '-c', script], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function sh(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(args[0] as string, args.slice(1), { cwd, encoding: 'utf8' });
}

function git(cwd: string, ...args: string[]): string {
  const outcome = sh(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], cwd);
  if (outcome.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${outcome.stderr}`);
  }
  return outcome.stdout.trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

// The forged Result a hostile build plants: well formed, clean, and a lie.
const FORGED_RESULT = JSON.stringify({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'FORGED clean result',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true },
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

// The hostile pull request: a fixture repository whose main branch is the trusted base and whose
// head commit adds a nameless button plus every forgery the build and the tree can carry.
function makeHostileRepo(
  root: string,
  port: number,
  marker: string,
  barrier: boolean,
): { repo: string; baseSha: string; headSha: string } {
  const repo = join(root, 'source-repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '--quiet', '--initial-branch=main');
  const config = {
    appBaseUrl: `http://127.0.0.1:${port}`,
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [{ id: 'home', url: `http://127.0.0.1:${port}/`, files: ['src/index.html'] }],
    guardedPaths: ['.github/workflows/', '.github/CODEOWNERS'],
  };
  writeFileSync(join(repo, 'usabl.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'hostile-app', version: '1.0.0', private: true, scripts: { build: 'node build.mjs' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(repo, 'package-lock.json'),
    `${JSON.stringify({ name: 'hostile-app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'hostile-app', version: '1.0.0' } } }, null, 2)}\n`,
  );
  writeFileSync(join(repo, 'build.mjs'), "import { cpSync } from 'node:fs';\ncpSync('src', 'dist', { recursive: true });\n");
  const page = (body: string): string =>
    `<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1>${body}</main></body></html>\n`;
  writeFileSync(join(repo, 'src', 'index.html'), page('<p>Welcome.</p>'));
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', '--quiet', '-b', 'feature');
  // The real barrier: a button with no accessible name. The clean variant changes the page too,
  // so the judge still has a screen to scan.
  writeFileSync(
    join(repo, 'src', 'index.html'),
    page(barrier ? '<p>Welcome.</p><button type="button"></button>' : '<p>Welcome back.</p><button type="button">Save</button>'),
  );
  // A forged Result committed at the root, where a careless judge would write its own.
  writeFileSync(join(repo, 'usabl-result.json'), FORGED_RESULT);
  // Packages named like the engine's own dependencies. Loading any of them writes the marker, so
  // an engine that resolved a module from the head tree would leave it behind.
  const plants: Array<[name: string, main: string]> = [
    ['playwright', 'index.js'],
    ['axe-core', 'axe.js'],
    ['@axe-core/playwright', 'index.js'],
  ];
  for (const [name, main] of plants) {
    const planted = join(repo, 'node_modules', ...name.split('/'));
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, 'package.json'), JSON.stringify({ name, version: '9.9.9', main }));
    writeFileSync(
      join(planted, main),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'head code ran inside the engine');\n`,
    );
  }
  // The hostile build: forge Results everywhere this job can write, then leave a process behind
  // that keeps rewriting any usabl-result.json it can find.
  writeFileSync(
    join(repo, 'build.mjs'),
    `import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const forged = ${JSON.stringify(FORGED_RESULT)};
cpSync('src', 'dist', { recursive: true });
writeFileSync('dist/usabl-result.json', forged);
writeFileSync('usabl-result.json', forged);
mkdirSync(join(process.env.RUNNER_TEMP, 'usabl-judge'), { recursive: true });
writeFileSync(join(process.env.RUNNER_TEMP, 'usabl-judge', 'usabl-result.json'), forged);
const child = spawn(process.execPath, ['rewriter.mjs'], { detached: true, stdio: 'ignore', env: process.env });
writeFileSync(join(process.env.RUNNER_TEMP, 'rewriter.pid'), String(child.pid));
child.unref();
`,
  );
  writeFileSync(
    join(repo, 'rewriter.mjs'),
    `import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const forged = ${JSON.stringify(FORGED_RESULT)};
const roots = [dirname(process.env.GITHUB_WORKSPACE), process.env.RUNNER_TEMP];
let rounds = 0;
function sweep(dir, depth) {
  if (depth > 6) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== '.git') sweep(path, depth + 1);
    else if (entry.name === 'usabl-result.json') {
      try { writeFileSync(path, forged.replace('FORGED clean result', 'FORGED clean result round ' + rounds)); } catch {}
    }
  }
}
const timer = setInterval(() => { rounds += 1; for (const root of roots) sweep(root, 0); }, 100);
setTimeout(() => clearInterval(timer), 120000);
`,
  );
  git(repo, 'add', '.');
  git(repo, 'add', '--force', 'node_modules');
  git(repo, 'commit', '--quiet', '-m', 'hostile head');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '--quiet', 'main');
  return { repo, baseSha, headSha };
}

// Evaluate a workflow condition. The gate uses only always(), event comparisons, and output
// comparisons, so after substitution each one is a plain JavaScript boolean expression.
function evaluateIf(condition: string | undefined, resolve: (expr: string) => string, failed: boolean): boolean {
  if (condition === undefined) return !failed;
  const usesAlways = condition.includes('always()');
  const js = condition
    .replace(/always\(\)/g, 'true')
    .replace(/\b((?:github|steps|needs|env)\.[\w.-]+)/g, (expr) => JSON.stringify(resolve(expr)));
  const value = Boolean(new Function(`return (${js});`)());
  return usesAlways ? value : value && !failed;
}

interface JobContext {
  rehearsal: Rehearsal;
  jobId: string;
  needs: Needs;
  // The repository the pull request head lives in. A fork's differs from the base repository.
  headRepository?: string;
  // The handler for actions/checkout in this job, given the step's resolved inputs.
  checkout: (workspace: string, inputs: Record<string, string>) => void;
  skip?: (step: Step) => boolean;
}

async function runJob(ctx: JobContext): Promise<JobRun> {
  const job = WORKFLOW.jobs[ctx.jobId];
  if (job === undefined) throw new Error(`no job ${ctx.jobId}`);
  const jobRoot = mkdtempSync(join(ctx.rehearsal.root, `${ctx.jobId}-`));
  const workspace = join(jobRoot, 'work', 'repo');
  const runnerTemp = join(jobRoot, 'temp');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const stepOutputs: Record<string, Record<string, string>> = {};
  const exported: Record<string, string> = {};
  const log: string[] = [];
  let comment: string | null = null;
  let failed = false;
  const summaryFile = join(runnerTemp, 'step-summary.md');
  writeFileSync(summaryFile, '');

  const resolveExpr = (expr: string): string => {
    const e = expr.trim();
    const fixed: Record<string, string> = {
      'runner.temp': runnerTemp,
      'github.event_name': 'pull_request',
      'github.event.pull_request.base.ref': 'main',
      'github.event.pull_request.base.sha': ctx.rehearsal.baseSha,
      'github.event.pull_request.head.sha': ctx.rehearsal.headSha,
      'github.event.pull_request.number': '7',
      'github.event.pull_request.head.repo.full_name': ctx.headRepository ?? BASE_REPOSITORY,
      'github.repository': BASE_REPOSITORY,
      'github.run_id': RUN_ID,
      'github.token': 'job-token',
      'secrets.GITHUB_TOKEN': 'job-token',
    };
    if (e in fixed) return fixed[e] as string;
    if (e.startsWith('vars.')) return '';
    let match = /^needs\.([\w-]+)\.(result|outputs\.(\w+))$/.exec(e);
    if (match !== null) {
      const need = ctx.needs[match[1] as string];
      if (need === undefined) return '';
      return match[2] === 'result' ? need.result : (need.outputs[match[3] as string] ?? '');
    }
    match = /^steps\.([\w-]+)\.outputs\.(\w+)$/.exec(e);
    if (match !== null) return stepOutputs[match[1] as string]?.[match[2] as string] ?? '';
    match = /^env\.(\w+)$/.exec(e);
    if (match !== null) return exported[match[1] as string] ?? '';
    throw new Error(`the harness does not know the expression ${e}`);
  };
  const resolve = (value: string): string => value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => resolveExpr(expr));

  const jobEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(job.env ?? {})) jobEnv[key] = resolve(value);

  for (const step of job.steps) {
    const label = step.name ?? step.uses ?? 'step';
    if (!evaluateIf(step.if, resolveExpr, failed) || ctx.skip?.(step) === true) {
      log.push(`skip: ${label}`);
      continue;
    }
    const inputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.with ?? {})) inputs[key] = resolve(String(value));
    const stepEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.env ?? {})) stepEnv[key] = resolve(value);

    if (step.uses !== undefined) {
      const action = step.uses.split('@')[0];
      if (action === 'actions/checkout') {
        ctx.checkout(inputs['path'] === undefined ? workspace : join(workspace, inputs['path']), inputs);
      } else if (action === 'actions/setup-node') {
        // This machine already has Node 22.
      } else if (action === 'actions/upload-artifact') {
        const target = join(ctx.rehearsal.store, inputs['name'] as string);
        rmSync(target, { recursive: true, force: true });
        mkdirSync(target, { recursive: true });
        copyFileSync(inputs['path'] as string, join(target, basename(inputs['path'] as string)));
      } else if (action === 'actions/download-artifact') {
        // Only the untrusted build job still uses this action; trusted jobs run the fetcher.
        if (ctx.jobId !== 'build-app') throw new Error(`${ctx.jobId} must not use download-artifact`);
        const source = join(ctx.rehearsal.store, inputs['name'] as string);
        if (!existsSync(source)) {
          failed = true;
          log.push(`fail: ${label}: no artifact`);
          continue;
        }
        cpSync(source, inputs['path'] as string, { recursive: true });
      } else if (action === 'actions/github-script') {
        comment = readFileSync(stepEnv['COMMENT_PATH'] as string, 'utf8');
      } else {
        throw new Error(`the harness has no stand-in for ${step.uses}`);
      }
      log.push(`ok: ${label}`);
      continue;
    }

    const outputFile = join(runnerTemp, `output-${Math.random().toString(36).slice(2)}`);
    const envFile = join(runnerTemp, `env-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outputFile, '');
    writeFileSync(envFile, '');
    const cwd = step['working-directory'] === undefined ? workspace : join(workspace, resolve(step['working-directory']));
    const outcome = await runBash(step.run ?? '', {
      cwd: step['working-directory']?.startsWith('${{') === true ? resolve(step['working-directory']) : cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: outputFile,
        GITHUB_ENV: envFile,
        GITHUB_REPOSITORY: BASE_REPOSITORY,
        GITHUB_RUN_ID: RUN_ID,
        GITHUB_API_URL: ctx.rehearsal.api.url,
        GITHUB_STEP_SUMMARY: summaryFile,
        RUNNER_TEMP: runnerTemp,
        // The fixture has no dependencies; keep npm off the network and out of the user's cache.
        npm_config_offline: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_cache: join(runnerTemp, 'harness-npm-cache'),
        ...jobEnv,
        ...exported,
        ...stepEnv,
      },
    });
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) exported[line.slice(0, at)] = line.slice(at + 1);
    }
    if (step.id !== undefined) {
      const outputs: Record<string, string> = {};
      for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
      }
      stepOutputs[step.id] = outputs;
    }
    if (outcome.status !== 0) {
      failed = true;
      log.push(`fail: ${label}\n${outcome.stdout}\n${outcome.stderr}`);
    } else {
      log.push(`ok: ${label}`);
    }
  }

  const outputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(job.outputs ?? {})) outputs[key] = resolve(value);
  const pidFile = join(runnerTemp, 'rewriter.pid');
  if (existsSync(pidFile)) ctx.rehearsal.pids.push(readFileSync(pidFile, 'utf8').trim());
  return { result: failed ? 'failure' : 'success', outputs, log, comment, summary: readFileSync(summaryFile, 'utf8') };
}

function cloneAt(rehearsal: Rehearsal, target: string, sha: string): void {
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  git(dirname(target), 'clone', '--quiet', rehearsal.sourceRepo, target);
  git(target, 'checkout', '--quiet', '--detach', sha);
}

// usabl-engine: the checkout and the npm build are stood in by the engine this repository built,
// with its node_modules linked rather than copied. The real pack step then runs as written.
function runEngineJob(rehearsal: Rehearsal): Promise<JobRun> {
  return runJob({
    rehearsal,
    jobId: 'usabl-engine',
    needs: {},
    checkout: (target) => {
      mkdirSync(target, { recursive: true });
      copyFileSync(join(REPO_ROOT, 'package.json'), join(target, 'package.json'));
      cpSync(join(REPO_ROOT, 'dist'), join(target, 'dist'), { recursive: true });
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(target, 'node_modules'));
    },
    skip: (step) => step.name === 'Install and build trusted engine',
  });
}

function runBuildJob(rehearsal: Rehearsal, engine: JobRun): Promise<JobRun> {
  return runJob({
    rehearsal,
    jobId: 'build-app',
    needs: { 'usabl-engine': { result: engine.result, outputs: engine.outputs } },
    checkout: (target, inputs) => cloneAt(rehearsal, target, inputs['ref'] as string),
  });
}

function runScanJob(rehearsal: Rehearsal, engine: JobRun, build: JobRun): Promise<JobRun> {
  return runJob({
    rehearsal,
    jobId: 'usabl-scan',
    needs: {
      'usabl-engine': { result: engine.result, outputs: engine.outputs },
      'build-app': { result: build.result, outputs: build.outputs },
    },
    checkout: (target, inputs) => cloneAt(rehearsal, target, inputs['ref'] as string),
    // Chromium is already installed for this repository's Playwright; the install needs apt.
    skip: (step) => step.name === 'Install Chromium for the judge',
  });
}

function runCommentJob(rehearsal: Rehearsal, engine: JobRun, scan: JobRun, headRepository?: string): Promise<JobRun> {
  return runJob({
    rehearsal,
    jobId: 'gate-comment',
    ...(headRepository === undefined ? {} : { headRepository }),
    needs: {
      'usabl-engine': { result: engine.result, outputs: engine.outputs },
      'usabl-scan': { result: scan.result, outputs: scan.outputs },
    },
    checkout: (target, inputs) => {
      mkdirSync(target, { recursive: true });
      const config = git(rehearsal.sourceRepo, 'show', `${inputs['ref']}:usabl.config.json`);
      writeFileSync(join(target, 'usabl.config.json'), config);
    },
  });
}

function decide(needs: Record<string, string>, verdict: string): number {
  const decideStep = WORKFLOW.jobs[REQUIRED_GATE_JOB]?.steps.find((step) => step.name === 'Decide the merge gate');
  const outcome = spawnSync('bash', ['-e', '-c', decideStep?.run ?? ''], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      EVENT_NAME: 'pull_request',
      ENGINE_RESULT: needs['usabl-engine'] ?? '',
      BUILD_RESULT: needs['build-app'] ?? '',
      SCAN_RESULT: needs['usabl-scan'] ?? '',
      COMMENT_RESULT: needs['gate-comment'] ?? '',
      // The policy job is not played here; it is given its clean result so the rule is judged on
      // the accessibility half alone.
      POLICY_RESULT: 'success',
      ACCESSIBILITY_VERDICT: verdict,
    },
  });
  return outcome.status ?? 1;
}

function storedFile(rehearsal: Rehearsal, artifact: string): string {
  const dir = join(rehearsal.store, artifact);
  const [file] = readdirSync(dir);
  return join(dir, file as string);
}

// The run's artifacts as the API lists them: each stored file zipped the way upload-artifact
// zips it, unless the test replaced the whole zip, as a runner token can, with <name>.zip.
function storedArtifacts(store: string): StoredArtifact[] {
  const ids = new Map<string, number>();
  return readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry, index) => {
      ids.set(entry.name, 2000 + index);
      const replaced = join(store, `${entry.name}.zip`);
      const [file] = readdirSync(join(store, entry.name));
      const zip = existsSync(replaced)
        ? readFileSync(replaced)
        : makeZip([{ name: file as string, data: readFileSync(join(store, entry.name, file as string)), dataDescriptor: true }]);
      return { id: ids.get(entry.name) as number, name: entry.name, zip };
    });
}

async function newRehearsal(barrier = true): Promise<Rehearsal> {
  const root = mkdtempSync(join(tmpdir(), 'usabl-rehearsal-'));
  const port = await freePort();
  const marker = join(root, 'planted-package-ran');
  const { repo, baseSha, headSha } = makeHostileRepo(root, port, marker, barrier);
  const store = join(root, 'artifacts');
  mkdirSync(store);
  const api = await startArtifactApi(BASE_REPOSITORY, (runId) => (runId === RUN_ID ? storedArtifacts(store) : []));
  return { root, store, api, sourceRepo: repo, headSha, baseSha, port, marker, pids: [] };
}

async function cleanup(rehearsal: Rehearsal | undefined): Promise<void> {
  if (rehearsal === undefined) return;
  await rehearsal.api.close();
  for (const pid of rehearsal.pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  rmSync(rehearsal.root, { recursive: true, force: true });
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('the generated app gate against a hostile pull request', () => {
  let rehearsal: Rehearsal;
  let engine: JobRun;
  let build: JobRun;
  let scan: JobRun;

  beforeAll(async () => {
    // The judge runs the built engine, exactly as the workflow does.
    const built = await runBash('npm run build', { cwd: REPO_ROOT, env: { ...process.env } as Record<string, string> });
    if (built.status !== 0) throw new Error(`engine build failed: ${built.stderr}`);
    rehearsal = await newRehearsal();
    engine = await runEngineJob(rehearsal);
    build = await runBuildJob(rehearsal, engine);
    scan = await runScanJob(rehearsal, engine, build);
  }, 600_000);

  afterAll(async () => cleanup(rehearsal));

  it('builds and packs the hostile head in build-app, which left its rewriter running', () => {
    expect(engine.result, engine.log.join('\n')).toBe('success');
    expect(engine.outputs['engine_digest']).toMatch(/^[0-9a-f]{64}$/);
    expect(build.result, build.log.join('\n')).toBe('success');
    expect(build.outputs['build_digest']).toBe(sha256(storedFile(rehearsal, 'usabl-app-build')));
    // The hostile process really ran: it is still rewriting the build job's own files.
    expect(rehearsal.pids.length).toBe(1);
    expect(() => process.kill(Number(rehearsal.pids[0]), 0)).not.toThrow();
  });

  it('reports the real barrier and ignores every forged Result', () => {
    expect(scan.outputs['verdict']).toBe('fail');
    expect(scan.outputs['result_digest']).toMatch(/^[0-9a-f]{64}$/);
    // The scan job fails on the regression, after it uploaded the Result.
    expect(scan.result).toBe('failure');
    expect(scan.log.find((line) => line.startsWith('fail:'))).toMatch(/^fail: Enforce accessibility/);

    const resultPath = storedFile(rehearsal, 'usabl-result');
    expect(sha256(resultPath)).toBe(scan.outputs['result_digest']);
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      verdict: string;
      summary: string;
      findings: Array<{ rule: string; screenId: string; status: string }>;
      judge: { isolatedBrowser: boolean; buildDigest: string };
    };
    expect(result.verdict).toBe('regression');
    expect(result.summary).not.toContain('FORGED');
    expect(result.findings.some((finding) => finding.rule === 'button-name' && finding.screenId === 'home' && finding.status === 'new')).toBe(true);
    // The verdict is bound to the exact build bytes the judge verified.
    expect(result.judge.isolatedBrowser).toBe(true);
    expect(result.judge.buildDigest).toBe(build.outputs['build_digest']);
  });

  it('never loads the packages the head planted under the engine dependency names', () => {
    expect(existsSync(rehearsal.marker)).toBe(false);
  });

  it('posts the comment from the digest-checked Result, and the required rule blocks', async () => {
    const comment = await runCommentJob(rehearsal, engine, scan);
    expect(comment.result, comment.log.join('\n')).toBe('success');
    expect(comment.comment).toContain('<!-- usabl-report -->');
    expect(comment.comment).toContain('button-name');
    expect(comment.comment).toContain('Judge: isolated browser');
    expect(comment.comment).not.toContain('FORGED');
    expect(
      decide({ 'usabl-engine': engine.result, 'build-app': build.result, 'usabl-scan': scan.result, 'gate-comment': comment.result }, scan.outputs['verdict'] ?? ''),
    ).toBe(1);
  }, 120_000);

  it('refuses a Result replaced after the judge uploaded it, and the verdict still comes from the job output', async () => {
    const resultPath = storedFile(rehearsal, 'usabl-result');
    const original = readFileSync(resultPath);
    writeFileSync(resultPath, FORGED_RESULT);
    try {
      const comment = await runCommentJob(rehearsal, engine, scan);
      expect(comment.result).toBe('failure');
      expect(comment.comment).toBeNull();
      expect(comment.log.join('\n')).toMatch(/FAILED|did NOT match/);
      // The forged artifact says clean; the judge's output still says fail, and the rule blocks.
      expect(
        decide({ 'usabl-engine': engine.result, 'build-app': build.result, 'usabl-scan': 'success', 'gate-comment': 'success' }, scan.outputs['verdict'] ?? ''),
      ).toBe(1);
    } finally {
      writeFileSync(resultPath, original);
    }
  }, 120_000);

  it('fails closed when the build archive was tampered with after the build job', async () => {
    const archive = storedFile(rehearsal, 'usabl-app-build');
    const original = readFileSync(archive);
    appendFileSync(archive, Buffer.alloc(512, 1));
    try {
      const tampered = await runScanJob(rehearsal, engine, build);
      expect(tampered.result).toBe('failure');
      expect(tampered.outputs['verdict']).toBe('fail');
      expect(tampered.outputs['result_digest']).toBe('');
      expect(tampered.log.find((line) => line.startsWith('fail:'))).toMatch(/^fail: Verify and unpack the build/);
    } finally {
      writeFileSync(archive, original);
    }
  }, 300_000);

  it('fails closed when the engine archive was tampered with after the engine job', async () => {
    const archive = storedFile(rehearsal, 'usabl-engine');
    const original = readFileSync(archive);
    appendFileSync(archive, Buffer.from('tampered'));
    try {
      const tampered = await runScanJob(rehearsal, engine, build);
      expect(tampered.result).toBe('failure');
      expect(tampered.outputs['verdict']).toBe('fail');
      expect(tampered.outputs['result_digest']).toBe('');
      expect(tampered.log.find((line) => line.startsWith('fail:'))?.startsWith(`fail: ${TRUSTED_ENGINE_STEP}`)).toBe(true);
    } finally {
      writeFileSync(archive, original);
    }
  }, 300_000);

  it('refuses a build zip that carries an entry climbing out to the engine, before it writes a byte', async () => {
    // download-artifact strips only a leading ../, so this entry would land on the judge's
    // verified engine. The tar inside is unchanged, so its digest would still match.
    const payload = join(rehearsal.root, 'replaced-engine-ran');
    const zipPath = join(rehearsal.store, 'usabl-app-build.zip');
    writeFileSync(
      zipPath,
      makeZip([
        { name: 'usabl-app-build.tar', data: readFileSync(storedFile(rehearsal, 'usabl-app-build')) },
        {
          name: 'nested/../../usabl-engine/dist/cli.js',
          data: `require('node:fs').writeFileSync(${JSON.stringify(payload)}, 'x'); console.log('verdict=pass');`,
        },
      ]),
    );
    try {
      const tampered = await runScanJob(rehearsal, engine, build);
      expect(tampered.result).toBe('failure');
      expect(tampered.outputs['verdict']).toBe('fail');
      expect(tampered.outputs['result_digest']).toBe('');
      const failure = tampered.log.find((line) => line.startsWith('fail:')) ?? '';
      expect(failure).toMatch(/^fail: Fetch the build/);
      expect(failure).toContain('failing closed');
      expect(existsSync(payload)).toBe(false);
    } finally {
      rmSync(zipPath, { force: true });
    }
  }, 300_000);

  it('refuses a Result zip that carries a link instead of the file, in the comment job', async () => {
    const zipPath = join(rehearsal.store, 'usabl-result.zip');
    writeFileSync(zipPath, makeZip([{ name: 'usabl-result.json', data: '/etc/passwd', method: 0, mode: 0o120777 }]));
    try {
      const comment = await runCommentJob(rehearsal, engine, scan);
      expect(comment.result).toBe('failure');
      expect(comment.comment).toBeNull();
      expect(comment.log.find((line) => line.startsWith('fail:'))).toMatch(/^fail: Fetch Result JSON[\s\S]*not a regular file/);
    } finally {
      rmSync(zipPath, { force: true });
    }
  }, 120_000);
});

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('a hostile pull request that adds no barrier', () => {
  let rehearsal: Rehearsal | undefined;

  afterAll(async () => cleanup(rehearsal));

  it('passes the whole gate on a clean head, so the blocks above come from the barrier and the tampering', async () => {
    rehearsal = await newRehearsal(false);
    const engine = await runEngineJob(rehearsal);
    const build = await runBuildJob(rehearsal, engine);
    const scan = await runScanJob(rehearsal, engine, build);
    expect(scan.result, scan.log.join('\n')).toBe('success');
    expect(scan.outputs['verdict']).toBe('pass');
    const comment = await runCommentJob(rehearsal, engine, scan);
    expect(comment.result, comment.log.join('\n')).toBe('success');
    expect(comment.comment).toContain('Judge: isolated browser, 0 request(s) outside the allowed origins blocked');
    expect(
      decide({ 'usabl-engine': engine.result, 'build-app': build.result, 'usabl-scan': scan.result, 'gate-comment': comment.result }, scan.outputs['verdict'] ?? ''),
    ).toBe(0);

    // The same head from a fork: nothing in the gate needs a secret, so the judge runs the same,
    // and the comment goes to the run summary, so the comment job still succeeds.
    const fork = await runCommentJob(rehearsal, engine, scan, 'someone/hostile-app');
    expect(fork.result, fork.log.join('\n')).toBe('success');
    expect(fork.comment).toBeNull();
    expect(fork.summary).toContain('<!-- usabl-report -->');
    expect(fork.summary).toContain('Judge: isolated browser');
    expect(
      decide({ 'usabl-engine': engine.result, 'build-app': build.result, 'usabl-scan': scan.result, 'gate-comment': fork.result }, scan.outputs['verdict'] ?? ''),
    ).toBe(0);
  }, 600_000);
});
