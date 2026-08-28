import { describe, expect, it, vi } from 'vitest';
import type { FsGlob, GitReader } from '../../src/contracts/index.js';
import { loadRequirements } from '../../src/intake/load.js';
import { overlayRequirementsFs } from '../../src/intake/overlay-fs.js';
import { resolveIntakeConfig } from '../../src/intake/trusted-config.js';
import { matchGlob } from '../../src/primitives/match-glob.js';
import { testConfig } from '../helpers.js';

function scriptedFs(files: Record<string, string>): FsGlob {
  return {
    readFile: vi.fn(async (path: string) => files[path] ?? null),
    glob: vi.fn(async (patterns: string[]) =>
      Object.keys(files).filter((path) => patterns.some((pattern) => matchGlob(pattern, path))),
    ),
  };
}

function scriptedGit(refContents: Record<string, Record<string, string>>): Pick<GitReader, 'lsFiles' | 'show'> {
  return {
    show: vi.fn(async (ref: string, path: string) => refContents[ref]?.[path] ?? null),
    lsFiles: vi.fn(async (ref: string, prefix: string) => {
      const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      const childrenPrefix = `${normalized}/`;
      return Object.keys(refContents[ref] ?? {})
        .filter((path) => path === normalized || path.startsWith(childrenPrefix))
        .sort();
    }),
  };
}

describe('resolveIntakeConfig', () => {
  it('uses trusted config requirements root for intake loading', async () => {
    const workingConfig = testConfig({ requirements: 'requirements-pr/' });
    const trustedConfig = testConfig({ requirements: 'requirements/' });
    const trustedConfigJson = JSON.stringify(trustedConfig);
    const fs = scriptedFs({
      'requirements-pr/pr.yaml': `
version: 1
requirements:
  - id: requirement-pr-only
    kind: content
    surface: clusters
    description: PR-only requirement
    assertion:
      type: content
      selector: h2
      expectedText: PR requirement
    approved: true
`,
    });
    const git = scriptedGit({
      'origin/main': {
        'usabl.config.json': trustedConfigJson,
        'requirements/base.yaml': `
version: 1
requirements:
  - id: requirement-base
    kind: content
    surface: clusters
    description: trusted requirement
    assertion:
      type: content
      selector: h1
      expectedText: Baseline requirement
    approved: true
`,
      },
    });

    const intakeConfig = await resolveIntakeConfig(git, workingConfig, 'origin/main');
    const overlayFs = overlayRequirementsFs(fs, git, intakeConfig, 'origin/main');
    const result = await loadRequirements(overlayFs, intakeConfig);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(intakeConfig.requirements).toBe('requirements/');
    expect(result.bundle.requirements.map((requirement) => requirement.id)).toEqual(['requirement-base']);
    expect(result.bundle.requirements.map((requirement) => requirement.id)).not.toContain('requirement-pr-only');
  });

  it('fails closed when trusted config is missing', async () => {
    const workingConfig = testConfig({ requirements: 'requirements-pr/' });
    const fs = scriptedFs({
      'requirements-pr/pr.yaml': `
version: 1
requirements:
  - id: requirement-pr-only
    kind: content
    surface: clusters
    description: PR-only requirement
    assertion:
      type: content
      selector: h2
      expectedText: PR requirement
    approved: true
`,
    });
    const git = scriptedGit({
      'origin/main': {},
    });

    const intakeConfig = await resolveIntakeConfig(git, workingConfig, 'origin/main');
    const overlayFs = overlayRequirementsFs(fs, git, intakeConfig, 'origin/main');
    const result = await loadRequirements(overlayFs, intakeConfig);

    expect(intakeConfig.requirements).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      bundle: {
        version: 1,
        requirements: [],
      },
    });
  });

  it('fails closed when trusted config is unparseable', async () => {
    const workingConfig = testConfig({ requirements: 'requirements-pr/' });
    const fs = scriptedFs({
      'requirements-pr/pr.yaml': `
version: 1
requirements:
  - id: requirement-pr-only
    kind: content
    surface: clusters
    description: PR-only requirement
    assertion:
      type: content
      selector: h2
      expectedText: PR requirement
    approved: true
`,
    });
    const git = scriptedGit({
      'origin/main': {
        'usabl.config.json': '{"appBaseUrl"',
      },
    });

    const intakeConfig = await resolveIntakeConfig(git, workingConfig, 'origin/main');
    const overlayFs = overlayRequirementsFs(fs, git, intakeConfig, 'origin/main');
    const result = await loadRequirements(overlayFs, intakeConfig);

    expect(intakeConfig.requirements).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      bundle: {
        version: 1,
        requirements: [],
      },
    });
  });
});
