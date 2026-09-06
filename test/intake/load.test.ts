import { describe, expect, it, vi } from 'vitest';
import type { FsGlob } from '../../src/contracts/index.js';
import { loadRequirements } from '../../src/intake/load.js';
import { buildGuardedSet } from '../../src/trust/guard.js';
import { UNTRUSTED_FRAME_END } from '../../src/surfaces/scrub.js';
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
    expect(result.reason).toContain(
      'declared at requirements[0] in requirements/name.yaml and already at requirements[0] in requirements/email.yaml',
    );
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
    expect(result.reason).toContain(
      'declared at requirements[0] and again at requirements[1] in requirements/both.yaml',
    );
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

describe('loadRequirements scrubs every reason it returns', () => {
  // The reason reaches a terminal and, through the stop hook, a model. Every string that can
  // carry file bytes or a file name goes through the same scrubber, so these assert the outcome
  // on the real loader rather than on any one producer.
  const ESC = '\u001b';
  const BEL = '\u0007';

  function rawControlBytes(text: string): string[] {
    return [...text].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 && character !== '\n';
    });
  }

  function requirementYaml(id: string): string {
    return `
version: 1
requirements:
  - id: ${id}
    kind: content
    surface: clusters
    description: account text
    assertion:
      type: content
      selector: h1
      expectedText: Account name
    approved: true
`;
  }

  it('strips a literal escape byte that breaks YAML parsing before any id is checked', async () => {
    // A raw ESC inside a double-quoted YAML scalar is a parse error, and the parser quotes the
    // offending source line in its message. That line must not reach the reason as written.
    const result = await loadRequirements(
      scriptedFs(['requirements/a.yaml'], {
        'requirements/a.yaml': requirementYaml(`"ok${ESC}]0;OWNED${BEL}tail"`),
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(rawControlBytes(result.reason)).toEqual([]);
    expect(result.reason).not.toContain('OWNED');
  });

  it('strips a forged frame marker carried by a YAML source line', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/a.yaml'], {
        'requirements/a.yaml': requirementYaml(`"${UNTRUSTED_FRAME_END}${ESC}"`),
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(rawControlBytes(result.reason)).toEqual([]);
    expect(result.reason).not.toContain(UNTRUSTED_FRAME_END);
  });

  it('strips an escape sequence carried by a file path in the duplicate reason', async () => {
    const hostilePath = `requirements/ok${ESC}]0;OWNED${BEL}.yaml`;
    const result = await loadRequirements(
      scriptedFs(['requirements/ok.yaml', hostilePath], {
        'requirements/ok.yaml': requirementYaml('same-id'),
        [hostilePath]: requirementYaml('same-id'),
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    // The loader sorts paths, and the escape byte sorts before the dot, so the hostile path is the
    // first declaration and the clean one is the repeat. The reason names both either way.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(rawControlBytes(result.reason)).toEqual([]);
    expect(result.reason).not.toContain('OWNED');
    expect(result.reason).toContain('same-id');
    expect(result.reason).toContain('requirements/ok.yaml');
  });

  it('strips an escape sequence carried by a file path in a read failure', async () => {
    const hostilePath = `requirements/${ESC}[2J.yaml`;
    const result = await loadRequirements(
      scriptedFs([hostilePath], {}),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(rawControlBytes(result.reason)).toEqual([]);
  });

  it('strips an unrecognised key name that the schema quotes back', async () => {
    const result = await loadRequirements(
      scriptedFs(['requirements/a.yaml'], {
        'requirements/a.yaml': `
version: 1
requirements:
  - id: account-name
    kind: content
    surface: clusters
    description: account text
    assertion:
      type: content
      selector: h1
      expectedText: Account name
    approved: true
    "x\\u001b]0;OWNED\\u0007": 1
`,
      }),
      testConfig({ requirements: 'requirements/' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(rawControlBytes(result.reason)).toEqual([]);
    expect(result.reason).not.toContain('OWNED');
  });
});
