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
    const deps = depsForSecondId('account-name');
    const scanSpy = vi.spyOn(deps.checkRunner, 'scan');
    const result = await run(deps, config);

    expect(result.verdict).toBe('approval_required');
    expect(result.exitCode).toBe(2);
    // Nothing was scanned and nothing was found, so nothing could have been waived. Asserting
    // the empty set directly, rather than a property over it, is what makes that claim real.
    expect(scanSpy).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
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

describe('run with a requirements file it cannot load', () => {
  // A requirements file that does not load stops every scan, because policy cannot be half
  // applied. The loader returns why, and the run used to drop that reason: the operator saw a
  // guarded path and an approval request, and nothing said the file was broken or how.
  const configJson = JSON.stringify({
    appBaseUrl: config.appBaseUrl,
    uiFileGlobs: config.uiFileGlobs,
    discovery: config.discovery,
    surfaces: config.surfaces,
    requirements: 'requirements/',
    guardedPaths: config.guardedPaths,
  });
  // The note line carries a low-entropy token so the test can see whether the parser's quote of
  // the file reaches the gap.
  const brokenYaml = [
    'version: 1',
    'requirements:',
    '  - id: welcome-heading',
    '    note: token=SECRETPOISON',
    '  broken: [1, 2',
    '',
  ].join('\n');

  function depsWith(changed: string[]) {
    const files = { 'usabl.config.json': configJson, 'requirements/bad.yaml': brokenYaml };
    return makeFakeDeps({
      files,
      headContents: { ...files },
      changed: changed.map((path) => ({ code: 'M', path })),
      scans: { clusters: emptyScan() },
    });
  }

  it('reports the loader reason as a not-covered gap that names the file', async () => {
    const result = await run(depsWith(['fixtures/app/src/ClustersPage.tsx']), config);
    const gap = result.coverage.gaps.find((entry) => entry.ref === 'requirements/bad.yaml');

    expect(result.verdict).toBe('approval_required');
    expect(gap?.state).toBe('not-covered');
    expect(gap?.reason).toContain('requirements/bad.yaml');
    expect(gap?.reason).toContain('intake YAML is invalid');
    expect(gap?.reason).toMatch(/no screen was scanned/i);
  });

  it('never reads as verified accessibility when nothing was scanned', async () => {
    const result = await run(depsWith(['fixtures/app/src/ClustersPage.tsx']), config);

    expect(result.screens).toEqual([]);
    expect(result.accessibilityVerdict).toBe('not_covered');
    expect(result.accessibilityExitCode).toBe(3);
  });

  it('never quotes a secret from the file in the gap', async () => {
    const result = await run(depsWith(['fixtures/app/src/ClustersPage.tsx']), config);

    expect(JSON.stringify(result.coverage.gaps)).not.toContain('SECRETPOISON');
    expect(result.coverage.gaps.some((entry) => entry.ref === 'requirements/bad.yaml')).toBe(true);
  });

  it('shows the reason even when no UI file changed', async () => {
    const result = await run(depsWith(['README.md']), config);

    expect(result.verdict).toBe('approval_required');
    expect(result.coverage.gaps.map((entry) => entry.ref)).toContain('requirements/bad.yaml');
  });
});
