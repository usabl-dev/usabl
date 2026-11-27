/**
 * The requirements folder is a name from the config. Node's fs.glob has no escape, so a folder
 * name put into a pattern is read as a pattern: `reqs[1]` there means `reqs1`. The loader lists the
 * files under the folder with its name read as plain text, on the working tree and at the trusted
 * ref, so it loads every file in that folder and none from another.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsGlob, GitReader } from '../../src/contracts/index.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { loadRequirements } from '../../src/intake/load.js';
import { overlayRequirementsFs } from '../../src/intake/overlay-fs.js';
import { testConfig } from '../helpers.js';

const requirement = (id: string): string => `
version: 1
requirements:
  - id: ${id}
    kind: content
    surface: clusters
    description: heading text
    assertion:
      type: content
      selector: h1
      expectedText: Hello
    approved: true
`;

async function idsOf(fs: FsGlob, folder: string): Promise<string[]> {
  const result = await loadRequirements(fs, testConfig({ requirements: folder }));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.ok ? result.bundle.requirements.map((entry) => entry.id).sort() : [];
}

describe('a requirements folder named with glob syntax', () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function disk(files: Record<string, string>): Promise<FsGlob> {
    root = await mkdtemp(join(tmpdir(), 'usabl-reqs-folder-'));
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    return makeFsGlob({ cwd: root });
  }

  it('loads every file in reqs[1] and none from reqs1', async () => {
    const fs = await disk({
      'reqs[1]/a.yaml': requirement('req-a'),
      'reqs[1]/deep/z.yml': requirement('req-z'),
      'reqs1/decoy.yaml': requirement('req-decoy'),
    });
    expect(await idsOf(fs, 'reqs[1]')).toEqual(['req-a', 'req-z']);
  });

  it('loads the files of reqs? at the trusted ref and none from reqs or req', async () => {
    const trusted: Record<string, string> = {
      'reqs?/a.yaml': requirement('req-a'),
      'reqs/decoy.yaml': requirement('req-decoy'),
      'req/decoy.yaml': requirement('req-decoy-two'),
    };
    const git: Pick<GitReader, 'lsFiles' | 'show'> = {
      show: vi.fn(async (_ref: string, path: string) => trusted[path] ?? null),
      lsFiles: vi.fn(async (_ref: string, prefix: string) => Object.keys(trusted).filter((path) => path.startsWith(`${prefix}/`)).sort()),
    };
    const fs = overlayRequirementsFs(await disk({}), git, { requirements: 'reqs?' }, 'trusted');
    expect(await idsOf(fs, 'reqs?')).toEqual(['req-a']);
  });
});
