import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { verifyReceipt } from '../../src/evidence/receipt.js';
import { run } from '../../src/run.js';

const FIXTURE_APP_CWD = '/home/eparenti/work/repos/innovation-days-2026/usabl-app';
const FIXTURE_BASE_URL = 'http://127.0.0.1:5174';
const FIXTURE_CHANGED_FILES = ['src/pages/Clusters.tsx'];
type FixtureServerProcess = ReturnType<typeof spawn>;

function configForVariant(variant: 'broken' | 'fixed'): UsablConfig {
  return {
    appBaseUrl: FIXTURE_BASE_URL,
    uiFileGlobs: ['src/**/*.tsx'],
    discovery: {
      routerFile: 'src/App.tsx',
      wideBlastGlobs: [],
    },
    surfaces: [
      {
        id: 'clusters',
        url: `${FIXTURE_BASE_URL}/clusters?variant=${variant}`,
        files: ['src/pages/Clusters.tsx'],
      },
    ],
    guardedPaths: ['usabl.config.json'],
  };
}

function startFixtureServer(): FixtureServerProcess {
  return spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
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
      const response = await fetch(`${FIXTURE_BASE_URL}/clusters`);
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

describe.runIf(process.env['USABL_INTEGRATION'] === '1')('hero-bug flip integration', () => {
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
    'flips from broken regression to fixed verified and re-checks receipt integrity',
    async () => {
      const brokenConfig = configForVariant('broken');
      const fixedConfig = configForVariant('fixed');
      const deps = await buildDeps(brokenConfig, { cwd: FIXTURE_APP_CWD });
      try {
        const broken = await run(deps, brokenConfig, { changedFiles: FIXTURE_CHANGED_FILES });
        expect(broken.verdict).toBe('regression');
        expect(broken.exitCode).toBe(1);
        expect(broken.receipt).toBeNull();

        const brokenFocusReturn = broken.findings.filter((finding) => finding.rule === 'pf-modal-focus-return');
        expect(
          brokenFocusReturn,
          `broken findings were ${JSON.stringify(
            broken.findings.map((finding) => ({
              rule: finding.rule,
              status: finding.status,
              confidence: finding.confidence,
              elementPath: finding.elementPath,
            })),
            null,
            2,
          )}`,
        ).not.toEqual([]);
        expect(brokenFocusReturn.every((finding) => finding.status === 'new')).toBe(true);
        expect(brokenFocusReturn.every((finding) => finding.confidence === 'fail')).toBe(true);
        expect(broken.findings.some((finding) => finding.elementPath.includes('__usabl'))).toBe(false);

        const fixed = await run(deps, fixedConfig, { changedFiles: FIXTURE_CHANGED_FILES });
        expect(
          fixed.verdict,
          `fixed findings were ${JSON.stringify(
            {
              screens: fixed.screens.map((screen) => ({ id: screen.screenId, url: screen.url })),
              findings: fixed.findings.map((finding) => ({
                rule: finding.rule,
                status: finding.status,
                confidence: finding.confidence,
                elementPath: finding.elementPath,
              })),
            },
            null,
            2,
          )}`,
        ).toBe('verified');
        expect(fixed.exitCode).toBe(0);
        expect(fixed.receipt).not.toBeNull();
        expect(fixed.findings.some((finding) => finding.elementPath.includes('__usabl'))).toBe(false);

        if (fixed.receipt === null) {
          throw new Error('expected receipt for verified result');
        }
        const currentTree = await deps.git.writeTree();
        await expect(verifyReceipt(deps, fixedConfig, fixed.receipt, currentTree)).resolves.toEqual({
          valid: true,
          failedFields: [],
        });
      } finally {
        await deps.browser.close();
      }
    },
    120_000,
  );
});
