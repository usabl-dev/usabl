/**
 * The file reader's pathKind says what is at a path without reading it and without following a
 * link at the last part. On a file system that ignores case, it finds a name written in another
 * case, as every other read there does.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFsGlob } from '../../src/deps/fs.js';
import { caseInsensitiveFolder } from '../support/case-insensitive-folder.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const folded = await caseInsensitiveFolder();
const onFoldedVolume = folded.base === null || process.platform === 'win32' ? it.skip : it;
const roots: string[] = [];

async function folder(base: string): Promise<string> {
  const root = await mkdtemp(join(base, 'usabl-path-kind-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('pathKind', () => {
  posixOnly('names a file, a folder, a link, a pipe, and nothing', async () => {
    const root = await folder(tmpdir());
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir/file.txt'), 'x');
    await symlink('dir', join(root, 'to-dir'));
    await symlink('missing', join(root, 'dangling'));
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const fs = makeFsGlob({ cwd: root });
    await expect(fs.pathKind!('dir')).resolves.toBe('folder');
    await expect(fs.pathKind!('dir/file.txt')).resolves.toBe('file');
    await expect(fs.pathKind!('to-dir')).resolves.toBe('link');
    await expect(fs.pathKind!('dangling')).resolves.toBe('link');
    await expect(fs.pathKind!('pipe')).resolves.toBe('other');
    await expect(fs.pathKind!('missing')).resolves.toBeNull();
    await expect(fs.pathKind!('dir/file.txt/below')).resolves.toBeNull();
  });

  onFoldedVolume(`finds a name written in another case${folded.reason === null ? '' : ` (skipped: ${folded.reason})`}`, async () => {
    const root = await folder(folded.base ?? tmpdir());
    await mkdir(join(root, 'stuff'));
    await symlink('stuff', join(root, 'POLICY'));
    await expect(makeFsGlob({ cwd: root }).pathKind!('policy')).resolves.toBe('link');
  });
});
