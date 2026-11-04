/**
 * The artifact fetcher every trusted generated job uses instead of actions/download-artifact.
 *
 * Each test runs the exact step bytes of the generated app gate, through bash, against a local
 * stand-in for the GitHub artifact API: the step that writes the fetcher, then the step that
 * fetches the build. The zips are crafted the way an artifact replaced in the run could be. The
 * claim: the fetcher writes exactly the expected file into a fresh directory, or it writes nothing
 * at all, and nothing outside that directory ever changes.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { USABL_GATE_WORKFLOW } from '../../src/install/ci.js';
import { USABL_HISTORY_WORKFLOW } from '../../src/install/history-ci.js';
import { FETCH_ARTIFACT_SCRIPT } from '../../src/install/artifact-fetch.js';
import { makeZip, startArtifactApi, storeArtifact, type ArtifactApi, type ZipEntry } from '../support/zip.js';

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const REPOSITORY = 'example/app';
const RUN_ID = '4242';
const GATE = load(USABL_GATE_WORKFLOW) as Workflow;

function step(workflow: Workflow, jobId: string, name: string): Step {
  const found = workflow.jobs[jobId]?.steps.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no step ${name} in ${jobId}`);
  return found;
}

function bash(script: string, env: Record<string, string>, cwd: string): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-e', '-c', script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, output }));
  });
}

let api: ArtifactApi;
const roots: string[] = [];

beforeAll(async () => {
  api = await startArtifactApi(REPOSITORY);
});
afterAll(async () => {
  await api.close();
});
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  api.runs.clear();
  api.requests.length = 0;
});

interface Runner {
  temp: string;
  workspace: string;
  // A file the engine job unpacked earlier. Nothing the fetch does may change it.
  canary: string;
  env: Record<string, string>;
}

async function runner(): Promise<Runner> {
  const root = mkdtempSync(join(tmpdir(), 'usabl-fetch-'));
  roots.push(root);
  const temp = join(root, '_temp');
  const workspace = join(root, 'repo', 'repo');
  mkdirSync(join(temp, 'usabl-engine', 'dist'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const canary = join(temp, 'usabl-engine', 'dist', 'cli.js');
  writeFileSync(canary, 'the verified engine\n');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    RUNNER_TEMP: temp,
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_API_URL: api.url,
  };
  const written = await bash(step(GATE, 'usabl-scan', 'Write the artifact fetcher').run ?? '', env, temp);
  expect(written.status, written.output).toBe(0);
  return { temp, workspace, canary, env };
}

// The fetch step of the judge, with its expressions filled in the way the runner would.
async function fetchBuild(
  r: Runner,
  overrides: Record<string, string> = {},
): Promise<{ status: number | null; output: string; into: string }> {
  const fetchStep = step(GATE, 'usabl-scan', 'Fetch the build');
  const into = join(r.temp, 'usabl-download-build');
  const env: Record<string, string> = {
    ...r.env,
    GH_TOKEN: 'job-token',
    ARTIFACT_NAME: fetchStep.env?.['ARTIFACT_NAME'] ?? '',
    ARTIFACT_MEMBERS: fetchStep.env?.['ARTIFACT_MEMBERS'] ?? '',
    ARTIFACT_RUN_ID: RUN_ID,
    ARTIFACT_MAX_BYTES: fetchStep.env?.['ARTIFACT_MAX_BYTES'] ?? '',
    ARTIFACT_INTO: into,
    ...overrides,
  };
  const outcome = await bash(fetchStep.run ?? '', env, r.temp);
  return { ...outcome, into };
}

const BUILD = 'usabl-app-build.tar';
const good = (data = 'the build archive'): ZipEntry => ({ name: BUILD, data });

function expectNothingWritten(r: Runner, into: string): void {
  expect(readFileSync(r.canary, 'utf8')).toBe('the verified engine\n');
  expect(existsSync(into)).toBe(false);
  // Only what was there before: the engine and the fetcher. The zip itself is removed too.
  expect(readdirSync(r.temp).sort()).toEqual(['usabl-engine', 'usabl-fetch-artifact.cjs']);
  expect(readdirSync(join(r.temp, 'usabl-engine', 'dist'))).toEqual(['cli.js']);
  expect(readdirSync(r.workspace)).toEqual([]);
}

describe('the generated fetch steps', () => {
  it('write the fetcher with the exact script bytes', async () => {
    const r = await runner();
    expect(readFileSync(join(r.temp, 'usabl-fetch-artifact.cjs'), 'utf8')).toBe(`${FETCH_ARTIFACT_SCRIPT}\n`);
  });

  it('refuse to write the fetcher over a file already there', async () => {
    const r = await runner();
    const again = await bash(step(GATE, 'usabl-scan', 'Write the artifact fetcher').run ?? '', r.env, r.temp);
    expect(again.status).not.toBe(0);
  });

  it('fetch the one expected file, deflated with a data descriptor as upload-artifact writes it', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([{ ...good('x'.repeat(5000)), dataDescriptor: true }]));
    const outcome = await fetchBuild(r);
    expect(outcome.status, outcome.output).toBe(0);
    expect(readdirSync(outcome.into)).toEqual([BUILD]);
    expect(readFileSync(join(outcome.into, BUILD), 'utf8')).toBe('x'.repeat(5000));
    expect(readFileSync(r.canary, 'utf8')).toBe('the verified engine\n');
    expect(existsSync(`${outcome.into}.zip`)).toBe(false);
  });

  it('fetch a stored entry too', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([{ ...good(), method: 0 }]));
    const outcome = await fetchBuild(r);
    expect(outcome.status, outcome.output).toBe(0);
    expect(readFileSync(join(outcome.into, BUILD), 'utf8')).toBe('the build archive');
  });

  it('send the job token to the API and never to the storage the download redirects to', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([good()]));
    expect((await fetchBuild(r)).status).toBe(0);
    const storage = api.requests.filter((request) => request.path.startsWith('/storage/'));
    expect(storage.length).toBe(1);
    expect(storage.every((request) => !request.authorized)).toBe(true);
    expect(api.requests.filter((request) => request.path.startsWith('/repos/')).every((request) => request.authorized)).toBe(true);
  });

  it('take the newest artifact under the name, which is what a replaced artifact becomes', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([good('first')]));
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([good('replaced')]));
    const outcome = await fetchBuild(r);
    expect(outcome.status, outcome.output).toBe(0);
    expect(readFileSync(join(outcome.into, BUILD), 'utf8')).toBe('replaced');
  });
});

describe('the fetcher refuses a hostile zip and writes nothing', () => {
  const cases: Array<{ name: string; zip: () => Buffer; reason: RegExp }> = [
    {
      name: 'the expected file plus an entry that climbs out through a .. in the middle of its name',
      zip: () => makeZip([good(), { name: 'nested/../../usabl-engine/dist/cli.js', data: 'attacker code' }]),
      reason: /2 entries/,
    },
    {
      name: 'a single entry with a .. in the middle of its name',
      zip: () => makeZip([{ name: 'nested/../../usabl-engine/dist/cli.js', data: 'attacker code' }]),
      reason: /\.\. segment/,
    },
    {
      name: 'a .. written with backslashes',
      zip: () => makeZip([{ name: 'nested\\..\\..\\cli.js', data: 'attacker code' }]),
      reason: /\.\. segment/,
    },
    {
      name: 'an absolute entry name',
      zip: () => makeZip([{ name: '/tmp/usabl-engine/dist/cli.js', data: 'attacker code' }]),
      reason: /absolute path/,
    },
    {
      name: 'the expected name inside a folder',
      zip: () => makeZip([{ name: `dir/${BUILD}`, data: 'x' }]),
      reason: /is a path/,
    },
    {
      name: 'the expected name as a symbolic link',
      zip: () => makeZip([{ name: BUILD, data: '../usabl-engine/dist/cli.js', method: 0, mode: 0o120777 }]),
      reason: /not a regular file/,
    },
    {
      name: 'the expected name as a directory',
      zip: () => makeZip([{ name: BUILD, data: '', method: 0, mode: 0o040755 }]),
      reason: /not a regular file/,
    },
    {
      name: 'an extra member beside the expected one',
      zip: () => makeZip([good(), { name: 'extra.txt', data: 'x' }]),
      reason: /2 entries/,
    },
    {
      name: 'an unexpected member in place of the expected one',
      zip: () => makeZip([{ name: 'other.tar', data: 'x' }]),
      reason: /not an expected member/,
    },
    {
      name: 'a local header that names another path than the central directory',
      zip: () => makeZip([{ ...good(), localName: '../../usabl-engine/dist/cli.js' }]),
      reason: /local header/,
    },
    {
      name: 'an entry that inflates past the size it declares',
      zip: () => makeZip([{ ...good('y'.repeat(100_000)), declaredSize: 10 }]),
      reason: /more than the 10 bytes/,
    },
    {
      name: 'an entry made on a system whose file types are not checked',
      zip: () => makeZip([{ ...good(), host: 19 }]),
      reason: /system/,
    },
    {
      name: 'an encrypted entry',
      zip: () => makeZip([{ ...good(), flags: 0x0801 }]),
      reason: /encrypted/,
    },
    {
      name: 'bytes that are not a zip',
      zip: () => Buffer.from('not a zip archive at all, just text'),
      reason: /not a zip/,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const r = await runner();
      storeArtifact(api, RUN_ID, 'usabl-app-build', testCase.zip());
      const outcome = await fetchBuild(r);
      expect(outcome.status).toBe(1);
      expect(outcome.output).toMatch(testCase.reason);
      expect(outcome.output).toContain('failing closed');
      expectNothingWritten(r, outcome.into);
    });
  }

  it('a duplicate of an expected name', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([good('one'), good('two')]));
    const outcome = await fetchBuild(r, { ARTIFACT_MEMBERS: `${BUILD},second.tar` });
    expect(outcome.status).toBe(1);
    expect(outcome.output).toMatch(/appears twice/);
    expectNothingWritten(r, outcome.into);
  });

  it('a zip over the size limit, before it is read', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([{ ...good('z'.repeat(4096)), method: 0 }]));
    const outcome = await fetchBuild(r, { ARTIFACT_MAX_BYTES: '1024' });
    expect(outcome.status).toBe(1);
    expect(outcome.output).toMatch(/over the limit of 1024/);
    expectNothingWritten(r, outcome.into);
  });

  it('an entry whose declared size is over the limit although the zip is small', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([{ ...good('z'.repeat(2048)), declaredSize: 50_000 }]));
    const outcome = await fetchBuild(r, { ARTIFACT_MAX_BYTES: '4096' });
    expect(outcome.status).toBe(1);
    expect(outcome.output).toMatch(/unpacks to 50000 bytes, over the limit/);
    expectNothingWritten(r, outcome.into);
  });

  it('a run with no such artifact', async () => {
    const r = await runner();
    const outcome = await fetchBuild(r);
    expect(outcome.status).toBe(1);
    expect(outcome.output).toMatch(/no artifact named usabl-app-build/);
    expectNothingWritten(r, outcome.into);
  });

  it('a download directory that already exists', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([good()]));
    mkdirSync(join(r.temp, 'usabl-download-build'));
    const outcome = await fetchBuild(r);
    expect(outcome.status).toBe(1);
    expect(readdirSync(join(r.temp, 'usabl-download-build'))).toEqual([]);
  });

  it('a download directory inside the workspace', async () => {
    const r = await runner();
    storeArtifact(api, RUN_ID, 'usabl-app-build', makeZip([good()]));
    const outcome = await fetchBuild(r, { ARTIFACT_INTO: join(r.workspace, 'download') });
    expect(outcome.status).toBe(1);
    expect(outcome.output).toMatch(/outside the workspace/);
    expect(readdirSync(r.workspace)).toEqual([]);
  });
});

describe('every generated fetch step', () => {
  it('runs the fetcher the same job wrote, with a size bound, into a fresh directory under the runner temp directory', () => {
    const workflows: Array<[string, Workflow]> = [
      ['gate', GATE],
      ['history', load(USABL_HISTORY_WORKFLOW) as Workflow],
    ];
    let fetches = 0;
    for (const [label, workflow] of workflows) {
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        const names = job.steps.map((entry) => entry.name);
        job.steps.forEach((entry, index) => {
          if (!(entry.run ?? '').includes('usabl-fetch-artifact.cjs') || entry.name === 'Write the artifact fetcher') return;
          fetches += 1;
          expect(names.indexOf('Write the artifact fetcher'), `${label} ${jobId}`).toBeGreaterThanOrEqual(0);
          expect(names.indexOf('Write the artifact fetcher'), `${label} ${jobId}`).toBeLessThan(index);
          expect(entry.run?.split('\n')[0]).toBe('node "${RUNNER_TEMP}/usabl-fetch-artifact.cjs"');
          expect(entry.env?.['GH_TOKEN']).toBe('${{ github.token }}');
          expect(entry.env?.['ARTIFACT_MAX_BYTES']).toMatch(/^[1-9][0-9]*$/);
          expect(entry.env?.['ARTIFACT_MEMBERS']).toMatch(/^[a-z-]+\.(tgz|tar|json)$/);
          expect(entry.env?.['ARTIFACT_INTO']).toMatch(/^\$\{\{ runner\.temp \}\}\/usabl-download-[a-z]+$/);
        });
      }
    }
    // Gate: the engine in three jobs, the build, and the Result twice. History: the engine twice and the record.
    expect(fetches).toBe(9);
  });
});
