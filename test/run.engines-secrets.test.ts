/**
 * A whole run with the Evinced engine on and fake credential values in the environment. The
 * values must appear nowhere: not in a draft, a finding, a gap, a note, the receipt, or the text and
 * JSON the CLI prints. The SDK is a fake that quotes the credentials back, which is the worst case.
 */
import { describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../src/deps/fakes.js';
import { makeCheckRunner } from '../src/providers/check-runner.js';
import { makeEvincedProvider } from '../src/providers/engines/evinced.js';
import { registerPlaywrightPage } from '../src/providers/engines/shared.js';
import { makeStepRunner } from '../src/providers/keyboard-walk/steps.js';
import { run } from '../src/run.js';
import { projectCli } from '../src/surfaces/cli.js';

const SERVICE_ID = 'svc-31f4-fake-service-id';
const AUTH_TOKEN = 'tok-41a9-fake-offline-token';
const API_KEY = 'key-59c2-fake-online-secret';
const SECRETS = [SERVICE_ID, AUTH_TOKEN, API_KEY];
const ENV = { EVINCED_SERVICE_ID: SERVICE_ID, EVINCED_AUTH_TOKEN: AUTH_TOKEN, EVINCED_API_KEY: API_KEY };

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
  engines: { evinced: { enabled: true } },
};
const guardOk = { files: { 'usabl.config.json': '{}' }, headContents: { 'usabl.config.json': '{}' } };

const ECHOING_ISSUE = {
  type: { id: 'WRONG_SEMANTIC_ROLE', name: `Wrong role for ${SERVICE_ID}` },
  severity: { name: 'Critical' },
  elements: [{ selector: `#save-${AUTH_TOKEN}` }],
  summary: `token ${AUTH_TOKEN}`,
  description: `key ${API_KEY}`,
  knowledgeBaseLink: `https://example.test/kb?token=${AUTH_TOKEN}`,
};

function depsWith(evAnalyze: () => Promise<unknown>): Deps {
  const evinced = makeEvincedProvider(config.engines!.evinced!, {
    env: ENV,
    axeRuleIds: async () => new Set(['image-alt']),
    fileExists: async () => false,
    probe: async () => ({ state: 'installed', version: '3.9.0', missingDependencies: [] }),
    load: async () => ({
      setUploadToPlatformConfig: () => {},
      setOfflineCredentials: () => {},
      EvincedSDK: class {
        async evAnalyze() {
          return evAnalyze();
        }
      },
    }),
  });
  const base = makeFakeDeps({
    ...guardOk,
    writeTree: 'tree-engines',
    changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
    scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-1', engines: { evinced: '3.9.0' } },
  });
  const page = makeFakePage({
    currentUrl: async () => config.surfaces[0]!.url,
    // A keyboard stop off the body, so the screen reads as rendered rather than unseen.
    activePath: async () => 'html > body > main > button#save',
  });
  registerPlaywrightPage(page, { fake: 'playwright page' });
  return {
    ...base,
    checkRunner: makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [evinced],
      config,
      allowedCapabilities: ['live', 'secrets'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 2,
    }),
  };
}

function expectNoSecret(serialized: string): void {
  for (const secret of SECRETS) {
    expect(serialized).not.toContain(secret);
  }
}

describe('Evinced credentials across a whole run', () => {
  it('keeps them out of findings, the receipt, and CLI output on a verified run', async () => {
    const result = await run(depsWith(async () => [ECHOING_ISSUE]), config);

    // The finding is preview, so it is shown and the run still verifies with a receipt.
    expect(result.verdict).toBe('verified');
    expect(result.findings.map((finding) => [finding.rule, finding.evidenceClass])).toEqual([
      ['evinced:WRONG_SEMANTIC_ROLE', 'preview'],
    ]);
    expect(result.receipt?.scannerVersions.engines).toEqual({ evinced: '3.9.0' });

    const cli = projectCli(result);
    expectNoSecret(JSON.stringify(result));
    expectNoSecret(cli.text);
    expectNoSecret(cli.json);
  });

  it('keeps them out of the note and CLI output when the SDK throws, and the run still verifies', async () => {
    const result = await run(
      depsWith(async () => {
        throw new Error(`license rejected: service ${SERVICE_ID} token ${AUTH_TOKEN}`);
      }),
      config,
    );

    // Evinced findings are preview, so an Evinced that could not run is a note, not a gap. The
    // verdict and the receipt are what they would be without the engine.
    expect(result.verdict).toBe('verified');
    expect(result.receipt).not.toBeNull();
    expect(result.coverage.gaps).toEqual([]);
    expect(result.screens.flatMap((screen) => screen.notes ?? [])).toEqual([
      {
        ref: 'provider:evinced',
        reason:
          'provider evinced did not run: Evinced analysis failed: license rejected: service [redacted] token [redacted]. Its findings are preview, so this does not change the verdict.',
      },
    ]);

    const cli = projectCli(result);
    expect(cli.text).toContain('provider evinced did not run');
    expectNoSecret(JSON.stringify(result));
    expectNoSecret(cli.text);
    expectNoSecret(cli.json);
  });
});
