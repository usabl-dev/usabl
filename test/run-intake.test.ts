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

  it('uses trusted-ref requirements for accessibility scans when working-tree intake is malformed', async () => {
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
  - id: requirement-pr
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
    const goodYaml = `
version: 1
requirements:
  - id: requirement-base
    kind: content
    surface: clusters
    description: baseline requirement
    assertion:
      type: content
      selector: h1
      expectedText: Welcome
    approved: true
`;

    const deps = makeFakeDeps({
      files: {
        'usabl.config.json': configJson,
        'requirements/base.yaml': badYaml,
      },
      headContents: {
        'usabl.config.json': configJson,
        'requirements/base.yaml': goodYaml,
      },
      refContents: {
        'origin/main': {
          'usabl.config.json': configJson,
          'requirements/base.yaml': goodYaml,
        },
      },
      changed: [
        { code: 'M', path: 'requirements/base.yaml' },
        { code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' },
      ],
      scans: {
        clusters: {
          ...emptyScan(),
          drafts: [
            {
              rule: 'color-contrast',
              layer: 'axe',
              severity: 'serious',
              evidenceClass: 'deterministic',
              screenId: 'clusters',
              elementPath: 'button',
              elementName: 'Save',
              role: 'button',
              whatUserExperiences: '',
              why: '',
              fix: '',
              evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
              confidence: 'fail',
            },
          ],
        },
      },
    });
    const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

    const result = await run(deps, config, { trustedRef: 'origin/main' });

    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    expect(result.accessibilityVerdict).toBe('regression');
    expect(result.accessibilityExitCode).toBe(1);
    expect(result.dirtyGuardedPaths).toContain('requirements/base.yaml');
  });
});
