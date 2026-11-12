/**
 * `usabl init --app` takes a folder written relative to the repository root. A folder whose real
 * path, through symbolic links, is outside the repository would draft a config that reads files
 * the repository does not hold, so init refuses it with exit 2 and writes nothing.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { inferInit, type InitFs } from '../../src/init/index.js';
import { matchGlob } from '../../src/primitives/match-glob.js';

const APP_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'web', dependencies: { react: '18.0.0' } }),
  'src/App.tsx': 'export const App = () => null;\n',
};

describe('usabl init --app with a folder that resolves outside the repository', () => {
  let base: string;
  let originalCwd: string;
  let stderr: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    base = await realpath(await mkdtemp(join(tmpdir(), 'usabl-init-realpath-')));
    await mkdir(join(base, 'repo', 'apps'), { recursive: true });
    for (const [name, text] of Object.entries(APP_FILES)) {
      await mkdir(join(base, 'outside', name, '..'), { recursive: true });
      await writeFile(join(base, 'outside', name), text, 'utf8');
    }
    await symlink(join(base, 'outside'), join(base, 'repo', 'apps', 'web'), 'dir');
    process.chdir(join(base, 'repo'));
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(base, { recursive: true, force: true });
  });

  it('refuses a symbolic link that points outside, exit 2, and writes nothing', async () => {
    const code = await main(['init', '--app', 'apps/web']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('usabl init refused --app apps/web');
    expect(stderr.join('')).toContain('outside this repository');
    expect(existsSync(join(base, 'repo', 'usabl.config.json'))).toBe(false);
    expect(existsSync(join(base, 'repo', 'usabl.routes.json'))).toBe(false);
  });
});

describe('inferInit --app through the realpath port', () => {
  function memoryFs(files: Record<string, string>, real: (path: string) => string | null): InitFs {
    return {
      readFile: async (path) => files[path] ?? null,
      glob: async (patterns) => Object.keys(files).filter((file) => patterns.some((pattern) => matchGlob(pattern, file))),
      writeFile: async () => {},
      realpath: async (path) => real(path),
    };
  }
  const files = Object.fromEntries(Object.entries(APP_FILES).map(([name, text]) => [`apps/web/${name}`, text]));

  it('refuses a folder whose real path leaves the repository', async () => {
    for (const real of ['../outside', '../../etc', '/srv/outside']) {
      await expect(inferInit(memoryFs(files, () => real), { appDir: 'apps/web' })).rejects.toThrow(/outside this repository/);
    }
  });

  it('drafts a folder whose real path is another folder inside the repository from the real path', async () => {
    // git lists the files at their real path and tracks the link as one entry, so the draft must
    // name the real folder or no changed file would ever match it.
    const realFiles = Object.fromEntries(Object.entries(APP_FILES).map(([name, text]) => [`packages/web/${name}`, text]));
    const draft = await inferInit(
      memoryFs(realFiles, (path) => (path === 'apps/web' ? 'packages/web' : path)),
      { appDir: 'apps/web' },
    );
    expect(draft.config.uiFileGlobs.some((glob) => matchGlob(glob, 'packages/web/src/App.tsx'))).toBe(true);
    expect(draft.config.uiFileGlobs.some((glob) => glob.startsWith('apps/web/'))).toBe(false);
    expect(draft.notes.join('\n')).toMatch(/apps\/web is a symbolic link.*packages\/web/);
  });
});

describe('usabl init --app with a symbolic link to another folder inside the repository', () => {
  let base: string;
  let originalCwd: string;
  let stdout: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    base = await realpath(await mkdtemp(join(tmpdir(), 'usabl-init-inside-link-')));
    await mkdir(join(base, 'repo', 'apps'), { recursive: true });
    for (const [name, text] of Object.entries(APP_FILES)) {
      await mkdir(join(base, 'repo', 'packages', 'web', name, '..'), { recursive: true });
      await writeFile(join(base, 'repo', 'packages', 'web', name), text, 'utf8');
    }
    await symlink(join(base, 'repo', 'packages', 'web'), join(base, 'repo', 'apps', 'web'), 'dir');
    process.chdir(join(base, 'repo'));
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(base, { recursive: true, force: true });
  });

  it('drafts uiFileGlobs that match a changed file as git names it, and says the folder is a link', async () => {
    const code = await main(['init', '--app', 'apps/web']);
    expect(code).toBe(0);
    const config = JSON.parse(await readFile(join(base, 'repo', 'usabl.config.json'), 'utf8')) as { uiFileGlobs: string[] };
    // git reports an edit to the app as packages/web/src/App.tsx, never under the link.
    expect(config.uiFileGlobs.some((glob) => matchGlob(glob, 'packages/web/src/App.tsx'))).toBe(true);
    expect(config.uiFileGlobs.some((glob) => glob.startsWith('apps/web/'))).toBe(false);
    expect(stdout.join('')).toContain('Review: apps/web is a symbolic link');
    expect(stdout.join('')).toContain('packages/web');
  });
});

describe('usabl init --app with a folder whose real path cannot be read', () => {
  let base: string;
  let originalCwd: string;
  let stderr: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    base = await realpath(await mkdtemp(join(tmpdir(), 'usabl-init-unreadable-link-')));
    await mkdir(join(base, 'repo', 'apps'), { recursive: true });
    await writeFile(join(base, 'repo', 'apps', 'notes.txt'), 'a file, not a folder\n', 'utf8');
    // Two links that point at each other: the real path read gives ELOOP.
    await symlink(join(base, 'repo', 'apps', 'b'), join(base, 'repo', 'apps', 'a'));
    await symlink(join(base, 'repo', 'apps', 'a'), join(base, 'repo', 'apps', 'b'));
    process.chdir(join(base, 'repo'));
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(base, { recursive: true, force: true });
  });

  // A link loop gives ELOOP, and a path through a file gives ENOTDIR.
  for (const [label, appDir] of [
    ['a symbolic link loop', 'apps/a'],
    ['a path through a file', 'apps/notes.txt/web'],
  ] as const) {
    it(`gives the init refusal for ${label}, exit 2, and no raw error`, async () => {
      const code = await main(['init', '--app', appDir]);
      expect(code).toBe(2);
      const text = stderr.join('');
      expect(text).toContain(`usabl init refused --app ${appDir}: that folder has no files in this repository.`);
      expect(text).not.toMatch(/ELOOP|ENOTDIR|realpath/);
      expect(existsSync(join(base, 'repo', 'usabl.config.json'))).toBe(false);
    });
  }
});
