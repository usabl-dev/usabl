/**
 * Gate topology for the generated app gate and docs gate: which job may run what, which job may
 * hold what, and which check an operator makes required.
 *
 * The property these tests hold, in one sentence: no job that decides a verdict, or holds a
 * write token, ever executes code from the pull request head in Node or a shell. Head code runs
 * only in build-app, which holds no secret, and as page script inside the judge's sandboxed,
 * request-filtered Chromium.
 *
 * A job that runs head code on a hosted runner may be able to replace artifacts in the run, so
 * no trusted job may believe an artifact by name: each download must be checked against a digest
 * that arrives as a job output, through env, and is format-checked first. No trusted job may use
 * a cache. Both generated gates are asserted together, because a fix in one and not the other
 * would leave the same hole open.
 *
 * Every assertion reads the workflow through a real YAML parser, and the decision rule and the
 * download check are executed as the shell GitHub would run.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENGINE_REF_PLACEHOLDER,
  REQUIRED_GATE_JOB,
  REQUIRED_GATE_SCRIPT,
  TRUSTED_ENGINE_STEP,
  USABL_DOCS_GATE_WORKFLOW,
  USABL_GATE_WORKFLOW,
} from '../../src/install/ci.js';
import { REQUIRED_CHECK, branchRuleSetting } from '../../src/install/branch-rule.js';
import { engineTreeDigestCommand } from '../../src/install/artifact-fetch.js';

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
  name?: string;
  needs?: string | string[];
  if?: string | boolean;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  jobs: Record<string, Job>;
}

const GATES: Array<{ name: string; body: string }> = [
  { name: 'the generated app gate', body: USABL_GATE_WORKFLOW },
  { name: 'the generated docs gate', body: USABL_DOCS_GATE_WORKFLOW },
];

const JOB_ORDER = ['usabl-engine', 'build-app', 'usabl-scan', 'gate-comment', 'usabl-policy', REQUIRED_GATE_JOB];
// Every job except build-app is trusted: it decides, presents, or holds a token.
const TRUSTED_JOBS = JOB_ORDER.filter((job) => job !== 'build-app');

function parse(body: string): Workflow {
  return load(body) as Workflow;
}

function job(body: string, id: string): Job {
  const found = parse(body).jobs[id];
  if (found === undefined) throw new Error(`no ${id} job`);
  return found;
}

function step(body: string, jobId: string, name: string): Step {
  const found = job(body, jobId).steps.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`job ${jobId} has no step ${name}`);
  return found;
}

// The text of one job, for the "never anywhere in this job" assertions. It is serialized from the
// parsed document, so it covers action inputs and env as well as shell.
function jobText(body: string, id: string): string {
  return JSON.stringify(job(body, id));
}

const tempDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usabl-topology-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

// The engine tree digest, computed by the same command the generated engine job runs.
function treeDigest(dir: string): string {
  const outcome = spawnSync('bash', ['-e', '-c', `echo ${engineTreeDigestCommand(dir)}`.replace('echo (', 'echo $(')], { encoding: 'utf8' });
  return outcome.stdout.trim();
}

// Run a step's shell the way the runner does by default: bash -e.
function runStep(run: string, env: Record<string, string>, cwd?: string): number {
  const outcome = spawnSync('bash', ['-e', '-c', run], { env: { ...process.env, ...env }, cwd, encoding: 'utf8' });
  return outcome.status ?? 1;
}

describe.each(GATES)('$name', ({ body }) => {
  describe('job graph', () => {
    it('declares exactly the six gate jobs', () => {
      expect(Object.keys(parse(body).jobs)).toEqual(JOB_ORDER);
    });

    it('makes the aggregate always() and dependent on every other job, with no name override', () => {
      const required = job(body, REQUIRED_GATE_JOB);
      expect(required.if).toBe('always()');
      expect(required.needs).toEqual(JOB_ORDER.filter((id) => id !== REQUIRED_GATE_JOB));
      // GitHub names the check after the job id unless a name is set; branch-rule names the id.
      expect(required.name).toBeUndefined();
      expect(REQUIRED_CHECK).toBe(REQUIRED_GATE_JOB);
    });

    it('fences build-app to pull_request and runs the judge on both events', () => {
      expect(job(body, 'build-app').if).toBe("github.event_name == 'pull_request'");
      const scanIf = String(job(body, 'usabl-scan').if);
      expect(scanIf).toContain('always()');
      expect(scanIf).toContain("github.event_name == 'pull_request' && needs.build-app.result == 'success'");
      expect(scanIf).toContain("github.event_name == 'pull_request_review' && needs.build-app.result == 'skipped'");
    });

    it('posts the comment after a failed scan whenever the judge produced a Result', () => {
      const commentIf = String(job(body, 'gate-comment').if);
      expect(commentIf).toContain('always()');
      expect(commentIf).toContain("needs.usabl-scan.outputs.result_digest != ''");
      expect(commentIf).toContain("github.event_name == 'pull_request'");
    });
  });

  describe('build-app, the only job that runs head code', () => {
    it('has a read-only token and references no secret', () => {
      expect(job(body, 'build-app').permissions).toEqual({ contents: 'read' });
      expect(jobText(body, 'build-app')).not.toContain('secrets.');
    });

    it('checks out no engine and keeps no git credentials', () => {
      const checkouts = job(body, 'build-app').steps.filter((entry) => entry.uses?.startsWith('actions/checkout@'));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with?.['repository']).toBeUndefined();
      expect(checkouts[0]?.with?.['persist-credentials']).toBe(false);
    });

    it('keeps the build a week so a later approval can still be re-judged', () => {
      expect(step(body, 'build-app', 'Upload the build').with?.['retention-days']).toBe(7);
    });
  });

  describe('usabl-scan, the trusted judge', () => {
    it('has contents read and actions read only, and references no secret at all', () => {
      expect(job(body, 'usabl-scan').permissions).toEqual({ contents: 'read', actions: 'read' });
      expect(jobText(body, 'usabl-scan')).not.toContain('secrets.');
    });

    it('runs no npm or npx anywhere, so nothing resolves a package from a checkout', () => {
      for (const entry of job(body, 'usabl-scan').steps) {
        expect(entry.run ?? '').not.toMatch(/\bnpx?\b/);
      }
    });

    it('checks the head out as data into head/, never at the workspace root', () => {
      const checkouts = job(body, 'usabl-scan').steps.filter((entry) => entry.uses?.startsWith('actions/checkout@'));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with?.['ref']).toBe('${{ github.event.pull_request.head.sha }}');
      expect(checkouts[0]?.with?.['path']).toBe('head');
      expect(checkouts[0]?.with?.['persist-credentials']).toBe(false);
    });

    it('runs every node command from the engine or the fetcher under the runner temp directory, outside the head tree', () => {
      // The engine is unpacked to $RUNNER_TEMP/usabl-engine. RUNNER_TEMP is not under the
      // workspace, and the head is in workspace/head, so a node_modules the head commits is never
      // on the engine's module resolution path.
      const unpack = step(body, 'usabl-scan', TRUSTED_ENGINE_STEP).run ?? '';
      expect(unpack).toContain('--directory "${RUNNER_TEMP}/usabl-engine"');
      for (const entry of job(body, 'usabl-scan').steps) {
        for (const line of (entry.run ?? '').split('\n')) {
          const command = /^\s*node\s+(\S+)/.exec(line)?.[1];
          if (command === undefined || command === '<<\'NODE\'') continue;
          const inEngine =
            command.startsWith('"${RUNNER_TEMP}/usabl-engine/') ||
            command === '"${RUNNER_TEMP}/usabl-fetch-artifact.cjs"' ||
            (entry['working-directory'] === '${{ runner.temp }}/usabl-engine' && command.startsWith('node_modules/'));
          expect(inEngine, `${entry.name}: ${line.trim()}`).toBe(true);
        }
      }
    });

    it('serves and scans with the isolated browser against the trusted base ref', () => {
      const judge = step(body, 'usabl-scan', 'Run the judge').run ?? '';
      expect(judge).toContain('check --ci --trusted-ref "origin/${BASE_REF}" --isolated-browser --json');
      expect(step(body, 'usabl-scan', 'Allow the Chromium sandbox').run).toContain(
        'kernel.apparmor_restrict_unprivileged_userns=0',
      );
    });

    it('checks the build against the build job output on pull_request, through env', () => {
      const verify = step(body, 'usabl-scan', 'Verify and unpack the build');
      expect(verify.env?.['BUILD_DIGEST']).toBe('${{ needs.build-app.outputs.build_digest }}');
      const run = verify.run ?? '';
      expect(run.indexOf('=~ ^[0-9a-f]{64}$')).toBeGreaterThan(-1);
      expect(run.indexOf('=~ ^[0-9a-f]{64}$')).toBeLessThan(run.indexOf('sha256sum -c'));
      expect(run).toContain('extract-build --archive');
    });

    it('regex-checks the run id it finds on a review before using it', () => {
      const find = step(body, 'usabl-scan', "Find this head's build");
      expect(find.run).toContain('=~ ^[0-9]+$');
      expect(find.env?.['GH_TOKEN']).toBe('${{ github.token }}');
    });

    it('publishes the verdict and the Result digest as job outputs, fail by default', () => {
      expect(job(body, 'usabl-scan').outputs).toEqual({
        verdict: '${{ steps.verdict.outputs.verdict }}',
        result_digest: '${{ steps.verdict.outputs.result_digest }}',
      });
      const resolve = step(body, 'usabl-scan', 'Validate the Result and resolve the verdict');
      expect(resolve.id).toBe('verdict');
      expect(resolve.if).toBe('always()');
      expect(resolve.run).toMatch(/^.*verdict=fail/m);
    });

    it('uploads the Result before it enforces, so a failed scan still has a comment', () => {
      const names = job(body, 'usabl-scan').steps.map((entry) => entry.name);
      expect(names.indexOf('Upload Result JSON')).toBeLessThan(names.indexOf('Enforce accessibility'));
      expect(step(body, 'usabl-scan', 'Upload Result JSON').if).toBe(
        "always() && steps.verdict.outputs.result_digest != ''",
      );
    });
  });

  describe('gate-comment', () => {
    it('checks out no head code: only the base config', () => {
      const checkouts = job(body, 'gate-comment').steps.filter((entry) => entry.uses?.startsWith('actions/checkout@'));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with?.['ref']).toBe('${{ github.event.pull_request.base.sha }}');
      expect(jobText(body, 'gate-comment')).not.toContain('head.sha');
    });

    it('posts on a pull request from this repository and writes the job summary for a fork', () => {
      // A fork's token cannot write to the pull request, so posting would fail the job and block
      // every fork. The comment is presentation only, so a fork gets it in the job summary.
      expect(step(body, 'gate-comment', 'Post sticky PR comment').if).toBe(
        'github.event.pull_request.head.repo.full_name == github.repository',
      );
      const summary = step(body, 'gate-comment', 'Show the comment in the job summary for a fork');
      expect(summary.if).toBe('github.event.pull_request.head.repo.full_name != github.repository');
      expect(summary.env?.['COMMENT_PATH']).toBe('${{ runner.temp }}/usabl-comment.md');

      const temp = scratch();
      writeFileSync(join(temp, 'comment.md'), '<!-- usabl-report -->\nREGRESSION\n');
      const summaryFile = join(temp, 'summary.md');
      expect(runStep(summary.run ?? '', { COMMENT_PATH: join(temp, 'comment.md'), GITHUB_STEP_SUMMARY: summaryFile })).toBe(0);
      expect(readFileSync(summaryFile, 'utf8')).toContain('REGRESSION');
    });

    it('reads the Result through the fetcher, with actions read for that only', () => {
      expect(job(body, 'gate-comment').permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'write' });
      expect(step(body, 'gate-comment', 'Fetch Result JSON').env?.['ARTIFACT_NAME']).toBe('usabl-result');
    });

    it('is the only job that can write to the pull request', () => {
      for (const id of JOB_ORDER) {
        const write = Object.values(job(body, id).permissions ?? {}).includes('write');
        expect(write, id).toBe(id === 'gate-comment');
      }
    });
  });

  describe('usabl-policy', () => {
    it('reads the head only as git objects and has no engine checkout', () => {
      const checkouts = job(body, 'usabl-policy').steps.filter((entry) => entry.uses?.startsWith('actions/checkout@'));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with?.['ref']).toBe('${{ github.event.pull_request.base.sha }}');
      expect(checkouts[0]?.with?.['repository']).toBeUndefined();
      expect(jobText(body, 'usabl-policy')).toContain('git fetch --no-tags origin \\"refs/pull/${PR_NUMBER}/head\\"');
    });
  });

  describe('properties across every job', () => {
    it('checks the public engine out at the pinned commit with no token', () => {
      for (const id of JOB_ORDER) {
        expect(jobText(body, id), id).not.toContain('USABL_ENGINE_CHECKOUT_TOKEN');
      }
      expect(job(body, 'usabl-engine').permissions).toEqual({ contents: 'read' });
      const checkouts = job(body, 'usabl-engine').steps.filter((entry) => entry.uses?.startsWith('actions/checkout@'));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with).toEqual({
        repository: 'usabl-dev/usabl',
        ref: ENGINE_REF_PLACEHOLDER,
        path: 'usabl-engine',
        'persist-credentials': false,
      });
    });

    it('references no secret but the policy job GITHUB_TOKEN, so a fork pull request lacks nothing it needs', () => {
      // GitHub gives a pull request from a fork no repository secrets. A gate that needed one
      // would fail closed for every fork. GITHUB_TOKEN is the run's own token and forks get it.
      for (const id of JOB_ORDER) {
        const secrets = jobText(body, id).match(/secrets\.\w+/g) ?? [];
        expect(secrets, id).toEqual(id === 'usabl-policy' ? ['secrets.GITHUB_TOKEN'] : []);
      }
    });

    it('uses no cache in any job, neither setup-node cache nor actions/cache', () => {
      // setup-node v5 and later turns npm caching on by itself when package.json names npm, so
      // leaving the cache inputs out does not turn it off. Every setup-node must say false.
      let setups = 0;
      for (const id of JOB_ORDER) {
        for (const entry of job(body, id).steps) {
          expect(entry.uses ?? '', `${id}: ${entry.name}`).not.toMatch(/^actions\/cache/);
          if (entry.uses?.startsWith('actions/setup-node@')) {
            setups += 1;
            expect(entry.with, `${id}: ${entry.name}`).toEqual({ 'node-version': '22', 'package-manager-cache': false });
          }
        }
      }
      expect(setups).toBeGreaterThanOrEqual(JOB_ORDER.length - 1);
    });

    it('sets a fresh npm cache for every npm call in a trusted job', () => {
      for (const id of TRUSTED_JOBS) {
        for (const entry of job(body, id).steps) {
          if (/\bnpm\b/.test(entry.run ?? '')) {
            expect(entry.run, `${id}: ${entry.name}`).toContain('export npm_config_cache="${RUNNER_TEMP}/');
          }
        }
      }
    });

    it('pins every action by a full commit SHA', () => {
      for (const id of JOB_ORDER) {
        for (const entry of job(body, id).steps) {
          if (entry.uses !== undefined) {
            expect(entry.uses, `${id}: ${entry.name}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
          }
        }
      }
    });

    it('passes every expression to shell through env, never inside a run script', () => {
      // An expression inside run: is template-substituted into the script before bash sees it,
      // so an event value there is code. Through env it is data.
      for (const id of JOB_ORDER) {
        for (const entry of job(body, id).steps) {
          expect(entry.run ?? '', `${id}: ${entry.name}`).not.toContain('${{');
        }
      }
    });

    it('never extracts an artifact with actions/download-artifact in a trusted job', () => {
      // Its zip extraction strips only a leading ../ from an entry name, so an entry with a ..
      // in the middle writes outside the download folder before any digest is checked.
      for (const id of TRUSTED_JOBS) {
        for (const entry of job(body, id).steps) {
          expect(entry.uses ?? '', `${id}: ${entry.name}`).not.toMatch(/^actions\/download-artifact@/);
        }
      }
    });

    it('follows every artifact fetch in a trusted job with a digest check against a job output', () => {
      for (const id of TRUSTED_JOBS) {
        const steps = job(body, id).steps;
        steps.forEach((entry, index) => {
          if (entry.env?.['ARTIFACT_NAME'] === undefined) return;
          const name = entry.env['ARTIFACT_NAME'];
          // The review-path build comes from another run, whose job outputs are out of reach. The
          // judge records the digest it scanned instead; the verify step says so.
          const checker = steps.slice(index).find((later) =>
            Object.values(later.env ?? {}).some((value) => /^\$\{\{ needs\.[\w-]+\.outputs\.\w+_digest \}\}$/.test(value)),
          );
          expect(checker, `${id}: fetch of ${name}`).toBeDefined();
          const digestVar = Object.entries(checker?.env ?? {}).find(([, value]) => /outputs\.\w+_digest/.test(value))?.[0];
          const run = checker?.run ?? '';
          expect(run, `${id}: ${name}`).toContain(`[[ "\${${digestVar}}" =~ ^[0-9a-f]{64}$ ]]`);
          expect(run, `${id}: ${name}`).toContain('sha256sum -c -');
          if (name === 'usabl-app-build') {
            expect(run).toContain('USABL_BUILD_DIGEST=$(sha256sum');
          }
        });
      }
    });

    it('checks the unpacked engine tree against the engine job output right before every engine run in a trusted job', () => {
      expect(job(body, 'usabl-engine').outputs?.['engine_tree_digest']).toBe('${{ steps.pack.outputs.engine_tree_digest }}');
      for (const id of TRUSTED_JOBS.filter((entry) => entry !== 'usabl-engine' && entry !== REQUIRED_GATE_JOB)) {
        expect(job(body, id).env?.['ENGINE_TREE_DIGEST'], id).toBe('${{ needs.usabl-engine.outputs.engine_tree_digest }}');
        for (const entry of job(body, id).steps) {
          const lines = (entry.run ?? '').split('\n');
          const firstRun = lines.findIndex(
            (line) =>
              line.includes('"${RUNNER_TEMP}/usabl-engine/dist/cli.js"') ||
              /^\s*node node_modules\//.test(line),
          );
          if (firstRun === -1) continue;
          const check = lines.findIndex((line) => line.includes('[[ "${ENGINE_TREE_DIGEST}" =~ ^[0-9a-f]{64}$ ]]'));
          expect(check, `${id}: ${entry.name}`).toBeGreaterThan(-1);
          expect(check, `${id}: ${entry.name}`).toBeLessThan(firstRun);
        }
      }
    });

    it('fetches each artifact into its own fresh directory under the runner temp directory', () => {
      for (const id of TRUSTED_JOBS) {
        for (const entry of job(body, id).steps) {
          if (entry.env?.['ARTIFACT_NAME'] === undefined) continue;
          expect(String(entry.env['ARTIFACT_INTO']), `${id}: ${entry.name}`).toMatch(/^\$\{\{ runner\.temp \}\}\/usabl-download-[a-z]+$/);
        }
      }
    });

    it('runs inline node scripts with node builtins only, from the runner temp directory', () => {
      for (const id of TRUSTED_JOBS) {
        for (const entry of job(body, id).steps) {
          const run = entry.run ?? '';
          if (!run.includes("<<'NODE'") && !/\bnode -e\b/.test(run)) continue;
          expect(entry['working-directory'] ?? '', `${id}: ${entry.name}`).toMatch(/^\$\{\{ runner\.temp \}\}/);
          for (const spec of run.matchAll(/(?:require|import)\(\s*'([^']+)'/g)) {
            expect(spec[1], `${id}: ${entry.name}`).toMatch(/^node:/);
          }
        }
      }
    });

    it('keeps the .git directory out of the engine archive', () => {
      expect(step(body, 'usabl-engine', 'Pack trusted engine').run).toContain('--exclude=.git');
    });
  });

  describe('the decision rule', () => {
    it('passes the rule its seven inputs and nothing else, the verdict from the judge output', () => {
      const decide = step(body, REQUIRED_GATE_JOB, 'Decide the merge gate');
      expect(decide.env).toEqual({
        EVENT_NAME: '${{ github.event_name }}',
        ENGINE_RESULT: '${{ needs.usabl-engine.result }}',
        BUILD_RESULT: '${{ needs.build-app.result }}',
        SCAN_RESULT: '${{ needs.usabl-scan.result }}',
        COMMENT_RESULT: '${{ needs.gate-comment.result }}',
        POLICY_RESULT: '${{ needs.usabl-policy.result }}',
        ACCESSIBILITY_VERDICT: '${{ needs.usabl-scan.outputs.verdict }}',
      });
    });

    it('embeds exactly the one decision rule', () => {
      expect(step(body, REQUIRED_GATE_JOB, 'Decide the merge gate').run).toBe(
        `node <<'NODE'\n${REQUIRED_GATE_SCRIPT}\nNODE\n`,
      );
    });

    it('runs correctly as shell, blocking on a failed build, a cancelled scan, and the old cases', () => {
      const run = step(body, REQUIRED_GATE_JOB, 'Decide the merge gate').run ?? '';
      const pr = {
        EVENT_NAME: 'pull_request',
        ENGINE_RESULT: 'success',
        BUILD_RESULT: 'success',
        SCAN_RESULT: 'success',
        COMMENT_RESULT: 'success',
        POLICY_RESULT: 'success',
        ACCESSIBILITY_VERDICT: 'pass',
      };
      const review = { ...pr, EVENT_NAME: 'pull_request_review', BUILD_RESULT: 'skipped', COMMENT_RESULT: 'skipped' };
      expect(runStep(run, pr)).toBe(0);
      expect(runStep(run, review)).toBe(0);
      expect(runStep(run, { ...pr, BUILD_RESULT: 'failure' })).toBe(1);
      expect(runStep(run, { ...pr, SCAN_RESULT: 'cancelled' })).toBe(1);
      expect(runStep(run, { ...pr, ACCESSIBILITY_VERDICT: 'fail' })).toBe(1);
      expect(runStep(run, { ...review, ACCESSIBILITY_VERDICT: '' })).toBe(1);
      expect(runStep(run, { ...review, SCAN_RESULT: 'skipped' })).toBe(1);
      expect(runStep(run, { ...pr, POLICY_RESULT: 'failure' })).toBe(1);
      expect(runStep(run, { ...pr, COMMENT_RESULT: 'skipped' })).toBe(1);
    }, 60_000);
  });

  describe('the download check, run as shell', () => {
    const verify = (): string => step(body, 'gate-comment', 'Verify Result JSON and render the comment').run ?? '';
    // Only the check, cut before the render, so it runs without an engine.
    const checkOnly = (): string => verify().slice(0, verify().indexOf('if ! [[ "${ENGINE_TREE_DIGEST}"'));

    function download(files: Record<string, string>): string {
      const dir = join(scratch(), 'usabl-download-result');
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), content);
      }
      return dir;
    }

    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

    it('accepts exactly the expected file with the expected digest', () => {
      const dir = download({ 'usabl-result.json': '{"ok":true}' });
      expect(runStep(checkOnly(), { DOWNLOAD_DIR: dir, RESULT_DIGEST: sha('{"ok":true}') })).toBe(0);
    });

    it('refuses a replaced file whose digest no longer matches the job output', () => {
      const dir = download({ 'usabl-result.json': '{"forged":true}' });
      expect(runStep(checkOnly(), { DOWNLOAD_DIR: dir, RESULT_DIGEST: sha('{"ok":true}') })).not.toBe(0);
    });

    it('refuses an artifact that carries anything besides the expected file', () => {
      const dir = download({ 'usabl-result.json': '{"ok":true}', 'extra.json': '{}' });
      expect(runStep(checkOnly(), { DOWNLOAD_DIR: dir, RESULT_DIGEST: sha('{"ok":true}') })).not.toBe(0);
    });

    it('refuses an expected digest that is not a sha256', () => {
      const dir = download({ 'usabl-result.json': '{"ok":true}' });
      expect(runStep(checkOnly(), { DOWNLOAD_DIR: dir, RESULT_DIGEST: '' })).not.toBe(0);
      expect(runStep(checkOnly(), { DOWNLOAD_DIR: dir, RESULT_DIGEST: `${sha('{"ok":true}')} x` })).not.toBe(0);
    });
  });

  describe('the verdict step, run as shell against a stub engine', () => {
    const run = (): string => step(body, 'usabl-scan', 'Validate the Result and resolve the verdict').run ?? '';
    const DIGEST = 'c'.repeat(64);
    const validResult = (exitCode: number): string =>
      JSON.stringify({
        schemaVersion: 'usabl.result.v1',
        exitCode,
        accessibilityExitCode: exitCode,
        judge: { isolatedBrowser: true, blockedRequests: 0, buildDigest: DIGEST },
      });

    function resolve(
      result: string | null,
      usablExit: string,
      engineExit: number,
      tamper?: (engineDir: string) => void,
    ): { verdict: string; digest: string } {
      const temp = scratch();
      const judgeDir = join(temp, 'usabl-judge');
      mkdirSync(judgeDir, { recursive: true });
      mkdirSync(join(temp, 'usabl-engine', 'dist'), { recursive: true });
      writeFileSync(join(temp, 'usabl-engine', 'dist', 'cli.js'), `process.exit(${engineExit});\n`);
      const tree = treeDigest(join(temp, 'usabl-engine'));
      tamper?.(join(temp, 'usabl-engine'));
      if (result !== null) writeFileSync(join(judgeDir, 'usabl-result.json'), result);
      const output = join(temp, 'github-output');
      writeFileSync(output, '');
      runStep(
        run(),
        { RUNNER_TEMP: temp, GITHUB_OUTPUT: output, USABL_EXIT: usablExit, USABL_BUILD_DIGEST: DIGEST, ENGINE_TREE_DIGEST: tree },
        temp,
      );
      const written = readFileSync(output, 'utf8');
      return {
        verdict: /verdict=(\S*)/.exec(written)?.[1] ?? '',
        digest: /result_digest=(\S*)/.exec(written)?.[1] ?? '',
      };
    }

    it('publishes pass and a digest only for a valid Result and a clean enforce', () => {
      const outcome = resolve(validResult(0), '0', 0);
      expect(outcome.verdict).toBe('pass');
      expect(outcome.digest).toMatch(/^[0-9a-f]{64}$/);
    }, 30_000);

    it('publishes fail and no digest when the engine tree changed after it was checked', () => {
      const replaced = resolve(validResult(0), '0', 0, (dir) => writeFileSync(join(dir, 'dist', 'cli.js'), 'process.exit(0); // replaced\n'));
      expect(replaced).toEqual({ verdict: 'fail', digest: '' });
      const added = resolve(validResult(0), '0', 0, (dir) => writeFileSync(join(dir, 'dist', 'extra.js'), ''));
      expect(added).toEqual({ verdict: 'fail', digest: '' });
      const linked = resolve(validResult(0), '0', 0, (dir) => symlinkSync('/tmp', join(dir, 'dist', 'link')));
      expect(linked).toEqual({ verdict: 'fail', digest: '' });
    }, 60_000);

    it('publishes fail with a digest for a regression, so the comment can explain it', () => {
      const outcome = resolve(validResult(1), '1', 1);
      expect(outcome.verdict).toBe('fail');
      expect(outcome.digest).toMatch(/^[0-9a-f]{64}$/);
    }, 30_000);

    it('publishes fail and no digest for a Result that does not record this build', () => {
      const other = JSON.stringify({ ...JSON.parse(validResult(0)), judge: { isolatedBrowser: true, blockedRequests: 0, buildDigest: 'd'.repeat(64) } });
      expect(resolve(other, '0', 0)).toEqual({ verdict: 'fail', digest: '' });
    }, 30_000);

    it('publishes fail even when the judge never ran and its directory does not exist', () => {
      const temp = scratch();
      const output = join(temp, 'github-output');
      writeFileSync(output, '');
      runStep(run(), { RUNNER_TEMP: temp, GITHUB_OUTPUT: output, USABL_EXIT: '', USABL_BUILD_DIGEST: DIGEST, ENGINE_TREE_DIGEST: 'e'.repeat(64) }, temp);
      expect(readFileSync(output, 'utf8')).toContain('verdict=fail');
    }, 30_000);

    it('publishes fail and no digest for a missing, empty, or mismatched Result', () => {
      expect(resolve(null, '0', 0)).toEqual({ verdict: 'fail', digest: '' });
      expect(resolve('', '0', 0)).toEqual({ verdict: 'fail', digest: '' });
      expect(resolve(validResult(0), '1', 0)).toEqual({ verdict: 'fail', digest: '' });
      expect(resolve(validResult(0), '', 0)).toEqual({ verdict: 'fail', digest: '' });
    }, 60_000);
  });
});

describe('what an operator is told to require', () => {
  it('prints the aggregate in the branch protection setting', () => {
    const setting = branchRuleSetting();
    expect(setting).toContain(REQUIRED_GATE_JOB);
    expect(setting).toContain(`contexts: ["${REQUIRED_GATE_JOB}"]`);
  });
});
