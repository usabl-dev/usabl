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

  it('fails closed when configured intake directory has no yaml files', async () => {
    const result = await loadRequirements(
      scriptedFs([], {}),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('requirements');
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

  it('fails closed when requirements root is "."', async () => {
    const result = await loadRequirements(scriptedFs([], {}), testConfig({ requirements: '.' }));

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: '.',
    });
  });

  it('fails closed when requirements root contains a traversal segment', async () => {
    const result = await loadRequirements(
      scriptedFs([], {}),
      testConfig({ requirements: 'requirements/../outside' }),
    );

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/../outside',
    });
  });

  it('fails closed when glob returns files outside the configured root', async () => {
    const result = await loadRequirements(
      scriptedFs(
        ['elsewhere/policy.yaml'],
        {
          'elsewhere/policy.yaml': `
version: 1
requirements:
  - id: req-x
    kind: content
    surface: clusters
    description: heading text
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
      path: 'elsewhere/policy.yaml',
    });
  });

  it('fails closed when glob throws', async () => {
    const fs: FsGlob = {
      glob: async () => {
        throw new Error('boom glob');
      },
      readFile: async () => null,
    };

    const result = await loadRequirements(fs, testConfig({ requirements: 'requirements/' }));

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('boom glob');
  });

  it('fails closed when readFile throws', async () => {
    const fs: FsGlob = {
      glob: async () => ['requirements/a.yaml'],
      readFile: async () => {
        throw new Error('boom read');
      },
    };

    const result = await loadRequirements(fs, testConfig({ requirements: 'requirements/' }));

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/a.yaml',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('boom read');
  });

  it('adds requirements path to the guarded policy set', () => {
    const guardedSet = buildGuardedSet(testConfig({ requirements: 'requirements/' }));
    expect(guardedSet).toContain('requirements/');
  });

  function requirementFile(id: string, selector: string): string {
    return `
version: 1
requirements:
  - id: ${id}
    kind: content
    surface: clusters
    description: account text
    assertion:
      type: content
      selector: ${selector}
      expectedText: Account name
    approved: true
`;
  }

  it('fails closed when two files in the bundle declare the same requirement id', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/name.yaml', 'requirements/email.yaml'], {
        'requirements/email.yaml': requirementFile('account-name', 'p.email'),
        'requirements/name.yaml': requirementFile('account-name', 'h1'),
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/name.yaml',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('account-name');
    expect(result.reason).toContain('requirements/name.yaml');
    expect(result.reason).toContain('requirements/email.yaml');
  });

  it('fails closed when one file declares the same requirement id twice', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/both.yaml'], {
        'requirements/both.yaml': `
version: 1
requirements:
  - id: account-name
    kind: content
    surface: clusters
    description: account name heading
    assertion:
      type: content
      selector: h1
      expectedText: Account name
    approved: true
  - id: account-name
    kind: content
    surface: clusters
    description: account email label
    assertion:
      type: content
      selector: p.email
      expectedText: Account name
    approved: true
`,
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result).toMatchObject({
      ok: false,
      verdict: 'approval_required',
      path: 'requirements/both.yaml',
    });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('account-name');
  });

  it('accepts distinct requirement ids across files', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/name.yaml', 'requirements/email.yaml'], {
        'requirements/email.yaml': requirementFile('account-email', 'p.email'),
        'requirements/name.yaml': requirementFile('account-name', 'h1'),
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result.ok).toBe(true);
  });

  it('refuses a requirement id that hides a character, by position and code point', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/a.yaml'], {
        'requirements/a.yaml': requirementFile('"account\\u2800name"', 'h1'),
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result).toMatchObject({ ok: false, verdict: 'approval_required', path: 'requirements/a.yaml' });
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('requirements[0].id');
    expect(result.reason).toContain('at position 8');
    expect(result.reason).toContain('U+2800');
    expect(result.reason).not.toContain('\u2800');
  });

  it('does not echo a terminal escape sequence carried by a rejected id', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/a.yaml'], {
        'requirements/a.yaml': `
version: 1
requirements:
  - id: "boom\\u001b[2Jclear"
    kind: content
    surface: clusters
    description: first
    assertion:
      type: content
      selector: h1
      expectedText: Account name
    approved: true
`,
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).not.toContain('\u001b');
    expect(result.reason).toContain('U+001B');
  });
});
