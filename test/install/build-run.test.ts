/**
 * The judge's build lookup on a review event, run as the generated step against a local stand-in
 * for the GitHub runs and jobs API.
 *
 * Two pull requests can carry the same head commit, and a build can differ by pull request number
 * or base. So the lookup must take only a pull_request run of this pull request, head repository,
 * head SHA, and base SHA, whose latest build-app job succeeded, and it must page through every run
 * rather than read the newest few.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { USABL_DOCS_GATE_WORKFLOW, USABL_GATE_WORKFLOW } from '../../src/install/ci.js';

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
type Workflow = { 'run-name'?: string; jobs: Record<string, { env?: Record<string, string>; steps: Step[] }> };

const REPOSITORY = 'example/app';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER_BASE = 'c'.repeat(40);
const PR = '7';

interface Run {
  id: number;
  event: string;
  head_sha: string;
  display_title: string;
  path: string;
  repository: { full_name: string };
  head_repository: { full_name: string };
  pull_requests: Array<{ number: number }>;
}
interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
}

const state: { runs: Run[]; jobs: Map<number, Job[]>; pagesServed: number } = { runs: [], jobs: new Map(), pagesServed: 0 };
let server: Server;
let apiUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer job-token') {
      res.writeHead(401).end();
      return;
    }
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const runs = /^\/repos\/example\/app\/actions\/workflows\/([\w.-]+)\/runs$/.exec(url.pathname);
    if (runs !== null) {
      state.pagesServed += 1;
      const matching = state.runs
        .filter((run) => run.path === `.github/workflows/${runs[1]}`)
        .filter((run) => run.head_sha === url.searchParams.get('head_sha'))
        .sort((a, b) => b.id - a.id);
      const slice = matching.slice((page - 1) * perPage, page * perPage);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ total_count: matching.length, workflow_runs: slice }));
      return;
    }
    const jobs = /^\/repos\/example\/app\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (jobs !== null) {
      const all = state.jobs.get(Number(jobs[1])) ?? [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ total_count: all.length, jobs: all.slice((page - 1) * perPage, page * perPage) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  apiUrl = `http://127.0.0.1:${address !== null && typeof address === 'object' ? address.port : 0}`;
});
afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
const roots: string[] = [];
afterEach(() => {
  state.runs = [];
  state.jobs = new Map();
  state.pagesServed = 0;
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

let nextId = 100;
function addRun(options: Partial<Run> & { pr?: string; base?: string; headRepo?: string; build?: Array<string | null>; workflow?: string }): Run {
  nextId += 1;
  const headRepo = options.headRepo ?? REPOSITORY;
  const workflow = options.workflow ?? 'usabl-gate';
  const run: Run = {
    id: nextId,
    event: 'pull_request',
    head_sha: HEAD,
    display_title: `${workflow} pull_request pr ${options.pr ?? PR} head ${headRepo}@${HEAD} base ${options.base ?? BASE}`,
    path: `.github/workflows/${workflow}.yml`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: headRepo },
    pull_requests: [],
    ...options,
  };
  state.runs.push(run);
  // One build-app job per attempt, oldest first.
  const conclusions = options.build ?? ['success'];
  state.jobs.set(
    run.id,
    conclusions.map((conclusion, index) => ({ id: run.id * 10 + index, name: 'build-app', status: 'completed', conclusion, run_attempt: index + 1 })),
  );
  return run;
}

function findStep(body: string): { step: Step; jobEnv: Record<string, string> } {
  const workflow = load(body) as Workflow;
  const scan = workflow.jobs['usabl-scan'];
  const step = scan?.steps.find((entry) => entry.name === "Find this head's build");
  if (step === undefined || scan === undefined) throw new Error('no lookup step');
  return { step, jobEnv: scan.env ?? {} };
}

// Run the generated step for a review, with its expressions filled from the event.
async function lookup(body = USABL_GATE_WORKFLOW, event: { headRepo?: string } = {}): Promise<{ status: number | null; output: string; runId: string | null }> {
  const { step } = findStep(body);
  const root = mkdtempSync(join(tmpdir(), 'usabl-build-run-'));
  roots.push(root);
  const envFile = join(root, 'github-env');
  writeFileSync(envFile, '');
  const expressions: Record<string, string> = {
    '${{ github.event_name }}': 'pull_request_review',
    '${{ github.token }}': 'job-token',
    '${{ github.event.pull_request.number }}': PR,
    '${{ github.event.pull_request.head.repo.full_name }}': event.headRepo ?? REPOSITORY,
  };
  const stepEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.env ?? {})) {
    stepEnv[key] = expressions[value] ?? value;
  }
  const env = {
    PATH: process.env.PATH ?? '',
    GITHUB_ENV: envFile,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_API_URL: apiUrl,
    GITHUB_RUN_ID: '9999',
    HEAD_SHA: HEAD,
    BASE_SHA: BASE,
    ...stepEnv,
  };
  const outcome = await new Promise<{ status: number | null; output: string }>((resolve) => {
    const child = spawn('bash', ['-e', '-c', step.run ?? ''], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, output }));
  });
  const runId = /^BUILD_RUN_ID=(\d+)$/m.exec(readFileSync(envFile, 'utf8'))?.[1] ?? null;
  return { ...outcome, runId };
}

describe("the review event's build lookup", () => {
  it('names every run after its event, pull request, head repository, head, and base', () => {
    for (const [name, body] of [
      ['usabl-gate', USABL_GATE_WORKFLOW],
      ['usabl-docs-gate', USABL_DOCS_GATE_WORKFLOW],
    ] as const) {
      expect((load(body) as Workflow)['run-name']).toBe(
        `${name} \${{ github.event_name }} pr \${{ github.event.pull_request.number }} head \${{ github.event.pull_request.head.repo.full_name }}@\${{ github.event.pull_request.head.sha }} base \${{ github.event.pull_request.base.sha }}`,
      );
    }
  });

  it("takes this pull request's run, not a newer run of another pull request with the same head", async () => {
    const own = addRun({});
    addRun({ pr: '8' });
    const found = await lookup();
    expect(found.status, found.output).toBe(0);
    expect(found.runId).toBe(String(own.id));
  });

  it('refuses a run of this pull request on another base', async () => {
    addRun({ base: OTHER_BASE });
    const found = await lookup();
    expect(found.status).not.toBe(0);
    expect(found.runId).toBeNull();
    expect(found.output).toContain('failing closed');
  });

  it('refuses a run whose head came from another repository', async () => {
    addRun({ headRepo: 'someone/app' });
    expect((await lookup()).runId).toBeNull();
    // And takes it when the event names that fork.
    const fork = await lookup(USABL_GATE_WORKFLOW, { headRepo: 'someone/app' });
    expect(fork.status, fork.output).toBe(0);
  });

  it('refuses a run of another repository', async () => {
    addRun({ repository: { full_name: 'someone/app' } });
    expect((await lookup()).runId).toBeNull();
  });

  it('refuses a run whose pull request list names other pull requests only', async () => {
    addRun({ pull_requests: [{ number: 8 }] });
    expect((await lookup()).runId).toBeNull();
  });

  it('skips a run whose build failed and takes an older one whose build succeeded', async () => {
    const older = addRun({});
    addRun({ build: ['failure'] });
    const found = await lookup();
    expect(found.runId).toBe(String(older.id));
  });

  it('skips a run whose latest build-app attempt failed even though an earlier one succeeded', async () => {
    addRun({ build: ['success', 'failure'] });
    expect((await lookup()).runId).toBeNull();
  });

  it('skips a run with no build-app job at all', async () => {
    const run = addRun({});
    state.jobs.set(run.id, []);
    expect((await lookup()).runId).toBeNull();
  });

  it('pages past the newest hundred runs', async () => {
    const own = addRun({});
    for (let i = 0; i < 150; i += 1) addRun({ pr: '8' });
    const found = await lookup();
    expect(found.status, found.output).toBe(0);
    expect(found.runId).toBe(String(own.id));
    expect(state.pagesServed).toBe(2);
  });

  it('searches the docs gate runs under the docs workflow file and name', async () => {
    addRun({});
    expect((await lookup(USABL_DOCS_GATE_WORKFLOW)).runId).toBeNull();
    const docs = addRun({ workflow: 'usabl-docs-gate' });
    expect((await lookup(USABL_DOCS_GATE_WORKFLOW)).runId).toBe(String(docs.id));
  });

  it('uses this run on a pull_request event without asking the API', async () => {
    const { step } = findStep(USABL_GATE_WORKFLOW);
    expect(step.env?.['EVENT_NAME']).toBe('${{ github.event_name }}');
    expect(step.run).toContain('echo "BUILD_RUN_ID=${GITHUB_RUN_ID}" >> "$GITHUB_ENV"');
  });
});
