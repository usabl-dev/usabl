import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFsGlob } from '../../src/deps/fs.js';

describe('makeFsGlob', () => {
  let workspacePath = '';

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'usabl-fs-test-'));
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await mkdir(join(workspacePath, 'src', 'components'), { recursive: true });
    await writeFile(join(workspacePath, 'src', 'App.tsx'), 'export const App = () => null;\n', 'utf8');
    await writeFile(join(workspacePath, 'src', 'components', 'Button.tsx'), 'export const Button = () => null;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('returns file text and null for missing paths', async () => {
    const fsGlob = makeFsGlob({ cwd: workspacePath });

    await expect(fsGlob.readFile('src/App.tsx')).resolves.toContain('export const App');
    await expect(fsGlob.readFile('src/Missing.tsx')).resolves.toBeNull();
  });

  it('returns null when the path is a directory instead of throwing EISDIR', async () => {
    // A guarded-path prefix like .github/workflows resolves to a directory. Reading it
    // must fail closed to null like a missing file, not crash the whole scan with EISDIR.
    const fsGlob = makeFsGlob({ cwd: workspacePath });

    await expect(fsGlob.readFile('src')).resolves.toBeNull();
  });

  it('matches configured globs relative to the adapter cwd', async () => {
    const fsGlob = makeFsGlob({ cwd: workspacePath });
    const matches = await fsGlob.glob(['src/**/*.tsx']);

    expect(matches.sort()).toEqual(['src/App.tsx', 'src/components/Button.tsx']);
  });

  it('never returns directory paths, only files under a matched prefix', async () => {
    // Callers read every globbed path as a file. A directory-style pattern must
    // expand to the files beneath it, never the directory nodes themselves, or a
    // guarded-path expansion would later read a directory and crash with EISDIR.
    const fsGlob = makeFsGlob({ cwd: workspacePath });
    const matches = await fsGlob.glob(['src', 'src/**']);

    expect(matches).toEqual(['src/App.tsx', 'src/components/Button.tsx']);
  });
});
