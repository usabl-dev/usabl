import { describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { ScreenScan } from '../src/contracts/index.js';
import { testConfig } from './helpers.js';

const config = testConfig({ requirements: 'requirements/' });

function emptyScan(): ScreenScan {
  return {
    screenId: 'clusters',
    url: 'http://127.0.0.1:5173/clusters',
    stops: [],
    drafts: [],
    gaps: [],
  };
}

describe('run with intake requirements', () => {
  it('fails closed and skips scans when requirement YAML is malformed', async () => {
    const configJson = JSON.stringify({
      appBaseUrl: config.appBaseUrl,
      uiFileGlobs: config.uiFileGlobs,
      discovery: config.discovery,
      surfaces: config.surfaces,
      requirements: 'requirements/',
      guardedPaths: config.guardedPaths,
    });
    const badYaml = `
version: 1
requirements:
  - id: bad-requirement
    kind: content
    surface: clusters
    description: malformed intake file
    assertion:
      type: content
      selector: h1
      expectedText: Welcome
    approved: true
  broken: [1, 2
`;

    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': configJson,
        'requirements/bad.yaml': badYaml,
      },
      headContents: {
        'usabl.config.json': configJson,
        'requirements/bad.yaml': badYaml,
      },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: {
        clusters: emptyScan(),
      },
    });
    const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

    const result = await run(deps, config);

    expect(scanSpy).toHaveBeenCalledTimes(0);
    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    expect(result.dirtyGuardedPaths).toContain('requirements/bad.yaml');
  });
});
