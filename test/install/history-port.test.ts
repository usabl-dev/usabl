/**
 * The history workflow starts the app on the origin the scan reads: appBaseUrl in main's
 * usabl.config.json. It never assumes a port. A config that is missing, unreadable, or not an http
 * loopback origin with an explicit port fails the step, so the scan never runs against a server
 * on a guessed port. These tests run the step's own bytes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USABL_HISTORY_WORKFLOW } from '../../src/install/history-ci.js';

interface Step { name?: string; run?: string }
const steps = (load(USABL_HISTORY_WORKFLOW) as { jobs: Record<string, { steps: Step[] }> }).jobs['history-scan']!.steps;
const stepNamed = (name: string): Step => {
  const found = steps.find((step) => step.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
};
const READ_ORIGIN = 'Read the app origin from usabl.config.json';

let work: string;
let githubEnv: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'usabl-history-port-'));
  githubEnv = join(work, 'github-env');
  await writeFile(githubEnv, '');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function readOrigin(config: string | null): Promise<{ status: number; env: string; stderr: string }> {
  if (config !== null) await writeFile(join(work, 'usabl.config.json'), config);
  const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepNamed(READ_ORIGIN).run ?? ''], {
    cwd: work,
    env: { ...process.env, GITHUB_ENV: githubEnv },
    encoding: 'utf8',
  });
  return { status: outcome.status ?? 1, env: await readFile(githubEnv, 'utf8'), stderr: outcome.stderr };
}

describe('the history scan reads the app origin from appBaseUrl', () => {
  it('assumes no port anywhere in the workflow', () => {
    expect(USABL_HISTORY_WORKFLOW).not.toContain('5173');
  });

  it('reads the origin before it starts the app, and starts and waits on that origin', () => {
    const names = steps.map((step) => step.name);
    expect(names.indexOf(READ_ORIGIN)).toBeGreaterThan(-1);
    expect(names.indexOf(READ_ORIGIN)).toBeLessThan(names.indexOf('Start application on localhost'));
    expect(stepNamed('Start application on localhost').run).toContain(
      'npm run dev -- --host "${USABL_APP_HOST}" --port "${USABL_APP_PORT}"',
    );
    expect(stepNamed('Wait for application readiness').run).toContain('curl -fsS "${USABL_APP_ORIGIN}"');
  });

  it.each([
    ['http://127.0.0.1:9000', '127.0.0.1', '9000', 'http://127.0.0.1:9000'],
    ['http://localhost:5174/app/', 'localhost', '5174', 'http://localhost:5174'],
    ['http://[::1]:3000', '::1', '3000', 'http://[::1]:3000'],
  ])('takes %s', async (appBaseUrl, host, port, origin) => {
    const outcome = await readOrigin(JSON.stringify({ appBaseUrl }));
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.env).toBe(`USABL_APP_HOST=${host}\nUSABL_APP_PORT=${port}\nUSABL_APP_ORIGIN=${origin}\n`);
  });

  it.each([
    ['no config', null, 'usabl.config.json is missing or is not JSON'],
    ['a config that is not JSON', '{', 'usabl.config.json is missing or is not JSON'],
    ['no appBaseUrl', '{}', 'no appBaseUrl string'],
    ['a value that is not a URL', JSON.stringify({ appBaseUrl: 'not a url' }), 'is not a URL'],
    ['https', JSON.stringify({ appBaseUrl: 'https://127.0.0.1:5173' }), 'must use http'],
    ['a host off loopback', JSON.stringify({ appBaseUrl: 'http://example.com:5173' }), 'loopback'],
    ['no explicit port', JSON.stringify({ appBaseUrl: 'http://127.0.0.1' }), 'explicit port'],
    ['a port that names a shell command', JSON.stringify({ appBaseUrl: 'http://127.0.0.1:$(id)' }), 'is not a URL'],
  ])('fails closed on %s and writes nothing to the job env', async (_case, config, why) => {
    const outcome = await readOrigin(config);
    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain(why);
    expect(outcome.stderr).toContain('failing closed');
    expect(outcome.env).toBe('');
  });
});
