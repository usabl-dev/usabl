import { describe, expect, it, vi } from 'vitest';
import type { FsGlob, GitReader } from '../../src/contracts/index.js';
import { loadRequirements } from '../../src/intake/load.js';
import { overlayRequirementsFs } from '../../src/intake/overlay-fs.js';
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
      const childrenPrefix = normalized + '/';
      return Object.keys(refContents[ref] ?? {})
        .filter((path) => path === normalized || path.startsWith(childrenPrefix))
        .sort();
    }),
  };
}

describe('overlayRequirementsFs', () => {
  it('loads requirement IDs from trusted ref bytes, not the PR tree', async () => {
    const config = testConfig({ requirements: 'requirements/' });
    const fs = scriptedFs({
      'requirements/bundle.yaml': `
version: 1
requirements:
  - id: requirement-softened-pr
    kind: content
    surface: clusters
    description: PR softens this requirement
    assertion:
      type: content
      selector: h1
      expectedText: Optional heading
    approved: true
`,
      'requirements/new-pr.yaml': `
version: 1
requirements:
  - id: requirement-added-pr
    kind: content
    surface: clusters
    description: PR-only requirement file
    assertion:
      type: content
      selector: h2
      expectedText: Added in PR
    approved: true
`,
    });
    const git = scriptedGit({
      'origin/main': {
        'requirements/bundle.yaml': `
version: 1
requirements:
  - id: requirement-baseline
    kind: content
    surface: clusters
    description: Baseline requirement
    assertion:
      type: content
      selector: h1
      expectedText: Required heading
    approved: true
`,
        'requirements/still-required.yaml': `
version: 1
requirements:
  - id: requirement-still-required
    kind: content
    surface: clusters
    description: Requirement removed in PR
    assertion:
      type: content
      selector: h3
      expectedText: Keep this
    approved: true
`,
      },
    });
    const overlayFs = overlayRequirementsFs(fs, git, config, 'origin/main');

    const result = await loadRequirements(overlayFs, config);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.requirements.map((requirement) => requirement.id)).toEqual([
      'requirement-baseline',
      'requirement-still-required',
    ]);
    expect(result.bundle.requirements.map((requirement) => requirement.id)).not.toContain('requirement-softened-pr');
    expect(result.bundle.requirements.map((requirement) => requirement.id)).not.toContain('requirement-added-pr');
  });

  it('uses trusted glob and readFile under requirements root only', async () => {
    const config = testConfig({ requirements: 'requirements/' });
    const fs = scriptedFs({
      'requirements/new-pr.yaml': `
version: 1
requirements:
  - id: requirement-added-pr
    kind: content
    surface: clusters
    description: PR-only requirement file
    assertion:
      type: content
      selector: h2
      expectedText: Added in PR
    approved: true
`,
      'docs/local-note.md': 'working-tree note',
    });
    const git = scriptedGit({
      'origin/main': {
        'requirements/base.yaml': `
version: 1
requirements:
  - id: requirement-baseline
    kind: content
    surface: clusters
    description: Baseline requirement
    assertion:
      type: content
      selector: h1
      expectedText: Required heading
    approved: true
`,
      },
    });
    const overlayFs = overlayRequirementsFs(fs, git, config, 'origin/main');

    await expect(overlayFs.glob(['requirements/**/*.yaml'])).resolves.toEqual(['requirements/base.yaml']);
    await expect(overlayFs.readFile('requirements/base.yaml')).resolves.toContain('requirement-baseline');
    await expect(overlayFs.readFile('docs/local-note.md')).resolves.toBe('working-tree note');
  });
});
