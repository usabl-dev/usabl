import { describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import type { Draft, ScreenScan } from '../src/contracts/index.js';
import { testConfig } from './helpers.js';

const config = testConfig({ requirements: 'requirements/' });

function emptyScan(): ScreenScan {
  return {
    screenId: 'clusters',
    url: 'http://127.0.0.1:5173/clusters',
    stops: [],
    drafts: [],
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
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

describe('run with two requirements sharing one id', () => {
  const configJson = JSON.stringify({
    appBaseUrl: config.appBaseUrl,
    uiFileGlobs: config.uiFileGlobs,
    discovery: config.discovery,
    surfaces: config.surfaces,
    requirements: 'requirements/',
    guardedPaths: config.guardedPaths,
  });

  const waiverLedger = JSON.stringify({
    version: 1,
    waivers: [
      {
        rule: 'intake:account-name',
        surface: 'clusters',
        scope: '*',
        reason: 'account name copy is being reworked',
        owner: 'team',
        approvedBy: 'owner',
        created: '2026-01-01T00:00:00.000Z',
        expires: '2026-12-31T00:00:00.000Z',
      },
    ],
  });

  function requirementYaml(id: string, selector: string, description: string): string {
    return `
version: 1
requirements:
  - id: ${id}
    kind: content
    surface: clusters
    description: ${description}
    assertion:
      type: content
      selector: ${selector}
      expectedText: Account name
    approved: true
`;
  }

  function failingDraft(id: string, selector: string): Draft {
    return {
      rule: `intake:${id}`,
      layer: 'intake-content',
      severity: 'moderate',
      evidenceClass: 'deterministic',
      screenId: 'clusters',
      elementPath: selector,
      elementName: null,
      role: null,
      whatUserExperiences: `Expected "Account name" at ${selector}, but no accessible node was found.`,
      why: 'The authored selector did not resolve to an accessible node for this screen.',
      fix: 'Ensure the selector identifies the intended element.',
      evidence: {},
      confidence: 'fail',
    };
  }

  function depsForSecondId(secondId: string) {
    const files = {
      'usabl.config.json': configJson,
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      '.usabl-evidence.json': JSON.stringify({ version: 1, entries: [] }),
      '.usabl-waivers.json': waiverLedger,
      'requirements/account-name.yaml': requirementYaml('account-name', 'h1', 'account name heading'),
      'requirements/account-email.yaml': requirementYaml(secondId, 'p.email', 'account email label'),
    };
    return makeFakeDeps({
      files,
      headContents: { ...files },
      changed: [{ code: 'M', path: 'fixtures/app/src/ClustersPage.tsx' }],
      scans: {
        clusters: {
          ...emptyScan(),
          drafts: [failingDraft('account-name', 'h1'), failingDraft(secondId, 'p.email')],
        },
      },
    });
  }

  it('refuses instead of letting one waiver absorb a second requirement', async () => {
    // One waiver was written for one requirement. A second requirement that reuses the id
    // produces the same rule string, so the waiver would cover a failure its author never saw
    // and a real barrier would report as verified.
    const result = await run(depsForSecondId('account-name'), config);

    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    expect(result.findings.every((finding) => finding.status !== 'waived')).toBe(true);
    expect(result.dirtyGuardedPaths).toContain('requirements/account-name.yaml');
  });

  it('still waives only the requirement the waiver names when ids are unique', async () => {
    const result = await run(depsForSecondId('account-email'), config);

    expect(result.verdict).toBe('regression');
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((finding) => [finding.rule, finding.status])).toEqual([
      ['intake:account-email', 'new'],
      ['intake:account-name', 'waived'],
    ]);
  });
});
