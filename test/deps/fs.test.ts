import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('returns null for a path under a file instead of throwing ENOTDIR', async () => {
    // src/App.tsx is a file, so nothing can sit below it. The disk refuses the read with ENOTDIR.
    // That is a missing file, the same as ENOENT, never a crash that stops the run.
    const fsGlob = makeFsGlob({ cwd: workspacePath });

    await expect(fsGlob.readFile('src/App.tsx/package.json')).resolves.toBeNull();
  });

  it('readBytes keeps bytes that are not valid UTF-8, and reads null where readFile does', async () => {
    await writeFile(join(workspacePath, 'fe.bin'), Buffer.from([0xfe, 0x41]));
    await writeFile(join(workspacePath, 'ff.bin'), Buffer.from([0xff, 0x41]));
    const fsGlob = makeFsGlob({ cwd: workspacePath });
    expect(await fsGlob.readFile('fe.bin')).toBe(await fsGlob.readFile('ff.bin'));
    const fe = await fsGlob.readBytes?.('fe.bin');
    const ff = await fsGlob.readBytes?.('ff.bin');
    expect(fe?.kind === 'file' ? [...fe.bytes] : fe).toEqual([0xfe, 0x41]);
    expect(ff?.kind === 'file' ? [...ff.bytes] : ff).toEqual([0xff, 0x41]);
    await expect(fsGlob.readBytes?.('src/Missing.tsx')).resolves.toBeNull();
    await expect(fsGlob.readBytes?.('src')).resolves.toEqual({ kind: 'folder' });
    await expect(fsGlob.readBytes?.('src/App.tsx/package.json')).resolves.toBeNull();
  });

  it('readBytes reads the mode from the executable bit, and a link by its text, never by what it points at', async () => {
    await writeFile(join(workspacePath, 'plain.txt'), 'data');
    await writeFile(join(workspacePath, 'run.sh'), 'data');
    await chmod(join(workspacePath, 'run.sh'), 0o755);
    await symlink('plain.txt', join(workspacePath, 'link'));
    await symlink('nowhere', join(workspacePath, 'dangling'));
    await symlink('src', join(workspacePath, 'linked-folder'));
    const fsGlob = makeFsGlob({ cwd: workspacePath });
    const plain = await fsGlob.readBytes?.('plain.txt');
    expect(plain?.kind === 'file' ? plain.mode : plain).toBe('100644');
    const run = await fsGlob.readBytes?.('run.sh');
    expect(run?.kind === 'file' ? run.mode : run).toBe('100755');
    for (const [name, target] of [
      ['link', 'plain.txt'],
      ['dangling', 'nowhere'],
      ['linked-folder', 'src'],
    ]) {
      const read = await fsGlob.readBytes?.(name ?? '');
      expect(read?.kind === 'symlink' ? Buffer.from(read.target).toString('utf8') : read).toBe(target);
    }
    // git stores no file below a link, so a path through a linked folder reads as nothing, though
    // readFile follows the link and finds the file.
    await expect(fsGlob.readFile('linked-folder/App.tsx')).resolves.toContain('export const App');
    await expect(fsGlob.readBytes?.('linked-folder/App.tsx')).resolves.toBeNull();
  });

  it('matches nothing for a glob under a file', async () => {
    const fsGlob = makeFsGlob({ cwd: workspacePath });

    await expect(fsGlob.glob(['src/App.tsx/package.json', 'src/App.tsx/*.json'])).resolves.toEqual([]);
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
