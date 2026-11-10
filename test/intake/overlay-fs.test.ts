import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsGlob, GitReader } from '../../src/contracts/index.js';
import { loadRequirements } from '../../src/intake/load.js';
import { toVoiceContract } from '../../src/intake/map-to-providers.js';
import { overlayRequirementsFs } from '../../src/intake/overlay-fs.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { matchGlob } from '../../src/primitives/match-glob.js';
import { testConfig } from '../helpers.js';

const execFileAsync = promisify(execFile);

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

  it('judges a voice requirement on the trusted ref bytes when the pull request edits it', async () => {
    // The pull request softens the voice requirement and changes the page in the same change. With a
    // trusted ref set, the contract the scan runs must be the base one, as for every other kind.
    const config = testConfig({ requirements: 'requirements/' });
    const voiceYaml = (tokens: string, mustAnnounce: boolean) => `
version: 1
requirements:
  - id: delete-row-announces
    kind: voice
    surface: clusters
    description: Deleting a row announces the deletion
    approved: true
    assertion:
      type: voice
      steps:
        - do: click
          selector: '[data-row="a"] button[aria-label="Delete"]'
      obligations:
        - class: live-polite
          afterStep: 0
          requiredTokens: [${tokens}]
          mustAnnounce: ${mustAnnounce}
`;
    const fs = scriptedFs({
      'requirements/voice.yaml': voiceYaml('removed', false),
      'fixtures/app/src/ClustersPage.tsx': 'export const page = "changed in the pull request";',
    });
    const git = scriptedGit({ 'origin/main': { 'requirements/voice.yaml': voiceYaml('deleted', true) } });

    const result = await loadRequirements(overlayRequirementsFs(fs, git, config, 'origin/main'), config);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [requirement] = result.bundle.requirements;
    expect(requirement?.kind).toBe('voice');
    if (requirement === undefined || requirement.assertion.type !== 'voice') {
      return;
    }
    expect(toVoiceContract({ ...requirement, assertion: requirement.assertion }).obligations).toEqual([
      { class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true },
    ]);
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

// Real git, because the defect lived in how the git adapter lists names. Without -z, git quoted
// `requirements/Über.yaml`, the quoted name matched no requirements glob, and the file was not
// loaded under a trusted ref, with nothing said.
describe('overlayRequirementsFs with a trusted requirement file git would quote', { timeout: 30_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads the file from the trusted ref beside the other requirement files', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-overlay-names-'));
    const git = async (args: string[]): Promise<void> => {
      await execFileAsync('git', args, { cwd: root });
    };
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.name', 'Test User']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'core.quotePath', 'true']);
    await mkdir(join(root, 'requirements'), { recursive: true });
    await writeFile(
      join(root, 'requirements/Über.yaml'),
      `
version: 1
requirements:
  - id: requirement-non-ascii-file
    kind: content
    surface: clusters
    description: Requirement kept in a file with a non-ASCII name
    assertion:
      type: content
      selector: h1
      expectedText: Required heading
    approved: true
`,
      'utf8',
    );
    await writeFile(
      join(root, 'requirements/base.yaml'),
      `
version: 1
requirements:
  - id: requirement-ascii-file
    kind: content
    surface: clusters
    description: Requirement kept in a file with an ASCII name
    assertion:
      type: content
      selector: h2
      expectedText: Second heading
    approved: true
`,
      'utf8',
    );
    await git(['add', '-A']);
    await git(['commit', '-m', 'requirements']);

    const config = testConfig({ requirements: 'requirements/' });
    const overlayFs = overlayRequirementsFs(makeFsGlob({ cwd: root }), makeGitReader({ cwd: root }), config, 'main');
    const result = await loadRequirements(overlayFs, config);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.bundle.requirements.map((requirement) => requirement.id)).toEqual([
      'requirement-ascii-file',
      'requirement-non-ascii-file',
    ]);
  });
});
