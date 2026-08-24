import { describe, expect, it, vi } from 'vitest';
import type { FsGlob } from '../../src/contracts/index.js';
import { loadRequirements } from '../../src/intake/load.js';
import { buildGuardedSet } from '../../src/trust/guard.js';
import { testConfig } from '../helpers.js';

function scriptedFs(paths: string[], files: Record<string, string | null>): FsGlob {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async () => paths,
  };
}

describe('loadRequirements', () => {
  it('returns an empty bundle when config.requirements is missing', async () => {
    const fs: FsGlob = {
      glob: vi.fn(async () => []),
      readFile: vi.fn(async () => null),
    };

    const result = await loadRequirements(fs, testConfig());

    expect(result).toEqual({
      ok: true,
      bundle: { version: 1, requirements: [] },
    });
    expect(fs.glob).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('loads, sorts, and merges yaml and yml requirement files', async () => {
    const fs = scriptedFs(
      ['requirements/z.yaml', 'requirements/a.yml'],
      {
        'requirements/a.yml': `
version: 1
requirements:
  - id: req-a
    kind: content
    surface: clusters
    description: heading text
    assertion:
      type: content
      selector: h1
      expectedText: Hello
    approved: true
`,
        'requirements/z.yaml': `
version: 1
requirements:
  - id: req-z
    kind: content
    surface: clusters
    description: logo text
    assertion:
      type: content
      selector: img.logo
      expectedText: Company logo
    approved: true
`,
      },
    );

    const result = await loadRequirements(fs, testConfig({ requirements: 'requirements/' }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.requirements.map((requirement) => requirement.id)).toEqual(['req-a', 'req-z']);
  });

  it('fails closed when a globbed requirement file is missing at read time', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/missing.yaml'], {}),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/missing.yaml',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('requirements/missing.yaml');
  });

  it('fails the whole load when any requirement file is malformed', async () => {
    const result = await loadRequirements(
      scriptedFs(
        ['requirements/bad.yaml', 'requirements/good.yaml'],
        {
          'requirements/bad.yaml': `
version: 1
requirements:
  - id: bad
    kind: content
    surface: clusters
    description: malformed
    assertion:
      type: content
      selector: h1
      expectedText: Hello
    approved: true
  broken: [1, 2
`,
          'requirements/good.yaml': `
version: 1
requirements:
  - id: good
    kind: content
    surface: clusters
    description: good
    assertion:
      type: content
      selector: h1
      expectedText: Hello
    approved: true
`,
        },
      ),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/bad.yaml',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('requirements/bad.yaml');
  });

  it('adds requirements path to the guarded policy set', () => {
    const guardedSet = buildGuardedSet(testConfig({ requirements: 'requirements/' }));
    expect(guardedSet).toContain('requirements/');
  });
});
