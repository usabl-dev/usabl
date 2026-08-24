import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { run } from '../../src/run.js';

const FIXTURE_APP_CWD = '/home/eparenti/work/repos/innovation-days-2026/usabl-app';
const FIXTURE_BASE_URL = 'http://127.0.0.1:5173';
const FIXTURE_CHANGED_FILES = ['src/pages/Clusters.tsx', 'src/pages/Settings.tsx'];
type FixtureServerProcess = ReturnType<typeof spawn>;

const fixtureConfig: UsablConfig = {
  appBaseUrl: FIXTURE_BASE_URL,
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: {
    routerFile: 'src/App.tsx',
    wideBlastGlobs: [],
  },
  surfaces: [
    {
      id: 'clusters',
      url: `${FIXTURE_BASE_URL}/clusters?variant=fixed`,
      files: ['src/pages/Clusters.tsx'],
    },
    {
      id: 'settings',
      url: `${FIXTURE_BASE_URL}/settings`,
      files: ['src/pages/Settings.tsx'],
    },
  ],
  guardedPaths: ['usabl.config.json'],
};

function startFixtureServer(): FixtureServerProcess {
  return spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: FIXTURE_APP_CWD,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function attachOutputBuffer(server: FixtureServerProcess): string[] {
  if (server.stdout === null || server.stderr === null) {
    throw new Error('fixture server must expose stdout and stderr pipes');
  }
  const output: string[] = [];
  server.stdout.on('data', (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
  });
  server.stderr.on('data', (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
  });
  return output;
}

function summarizeOutput(chunks: string[]): string {
  const compact = chunks.join('').trim();
  if (compact.length === 0) {
    return 'no fixture server output';
  }
  return compact.slice(-3000);
}

async function waitForServerReady(server: FixtureServerProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastReason = 'request never succeeded';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `fixture dev server exited before ready with code ${server.exitCode}: ${summarizeOutput(output)}`,
      );
    }
    try {
      const response = await fetch(`${FIXTURE_BASE_URL}/settings`);
      if (response.ok) {
        return;
      }
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`fixture dev server did not become ready: ${lastReason}; output: ${summarizeOutput(output)}`);
}

async function stopFixtureServer(server: FixtureServerProcess): Promise<void> {
  if (server.exitCode !== null) {
    return;
  }
  server.kill('SIGTERM');
  const graceful = await Promise.race([once(server, 'exit'), delay(5_000).then(() => null)]);
  if (graceful === null && server.exitCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}

describe.runIf(process.env['USABL_INTEGRATION'] === '1')('fixture clean oracle integration', () => {
  let fixtureServer: FixtureServerProcess | null = null;
  let fixtureOutput: string[] = [];

  beforeAll(async () => {
    fixtureServer = startFixtureServer();
    fixtureOutput = attachOutputBuffer(fixtureServer);
    await waitForServerReady(fixtureServer, fixtureOutput);
  }, 60_000);

  afterAll(async () => {
    if (fixtureServer !== null) {
      await stopFixtureServer(fixtureServer);
    }
  }, 10_000);

  it(
    'treats the fixed fixture variant as a verified zero-finding oracle',
    async () => {
      const deps = await buildDeps(fixtureConfig, { cwd: FIXTURE_APP_CWD });
      try {
        const result = await run(deps, fixtureConfig, { changedFiles: FIXTURE_CHANGED_FILES });
        const newFailures = result.findings.filter((finding) => finding.confidence === 'fail' && finding.status === 'new');

        expect(newFailures, `unexpected new failures: ${JSON.stringify(newFailures, null, 2)}`).toEqual([]);
        expect(result.verdict).toBe('verified');
        expect(result.receipt).not.toBeNull();
        expect(result.exitCode).toBe(0);
        expect(result.coverage.gaps.length).toBe(0);
      } finally {
        await deps.browser.close();
      }
    },
    120_000,
  );
});
