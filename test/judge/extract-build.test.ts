/**
 * extract-build unpacks the untrusted build archive for the judge. The archive comes from a job
 * that ran pull request code, so before a single byte is written the whole member list is read
 * and checked: regular files and directories only, no absolute path, no `..` segment. Then the
 * files are written by this code into a fresh, empty directory, so a link can never be created
 * and a write can never follow one. The archives here are made with the system tar, the same
 * tool the build job uses.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractBuildArchive, runExtractBuild } from '../../src/judge/extract-build.js';

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usabl-extract-'));
  cleanups.push(dir);
  return dir;
}

function tar(cwd: string, args: string[]): void {
  const outcome = spawnSync('tar', args, { cwd, encoding: 'utf8' });
  if (outcome.status !== 0) {
    throw new Error(`tar ${args.join(' ')} failed: ${outcome.stderr}`);
  }
}

// The shape the build job produces: the build directory packed from inside, so members are
// named ./index.html, ./assets/app.js, and so on.
function goodBuild(base: string): string {
  const dist = join(base, 'dist');
  mkdirSync(join(dist, 'assets', 'deep', 'er'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<p>index</p>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(join(dist, 'assets', 'deep', 'er', 'x.css'), 'p{}');
  const longName = `${'n'.repeat(120)}.js`;
  writeFileSync(join(dist, 'assets', longName), 'long');
  const archive = join(base, 'build.tar');
  tar(dist, ['--create', '--file', archive, '.']);
  return archive;
}

describe('extractBuildArchive', () => {
  it('writes every regular file and directory of a clean build', async () => {
    const base = scratch();
    const archive = goodBuild(base);
    const into = join(base, 'out');
    const outcome = await extractBuildArchive(archive, into);
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(into, 'index.html'), 'utf8')).toBe('<p>index</p>');
    expect(readFileSync(join(into, 'assets', 'app.js'), 'utf8')).toBe('console.log(1);');
    expect(readFileSync(join(into, 'assets', 'deep', 'er', 'x.css'), 'utf8')).toBe('p{}');
    expect(readFileSync(join(into, 'assets', `${'n'.repeat(120)}.js`), 'utf8')).toBe('long');
  });

  it('reads a pax archive with a long path the same way', async () => {
    const base = scratch();
    const dist = join(base, 'dist');
    const deep = join(dist, ...Array.from({ length: 12 }, (_, i) => `segment-number-${i}-of-a-long-path`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.html'), 'leaf');
    const archive = join(base, 'build.tar');
    tar(dist, ['--create', '--format=pax', '--file', archive, '.']);
    const into = join(base, 'out');
    expect((await extractBuildArchive(archive, into)).ok).toBe(true);
    const relative = deep.slice(dist.length + 1);
    expect(readFileSync(join(into, relative, 'leaf.html'), 'utf8')).toBe('leaf');
  });

  it('refuses a symlink member and writes nothing', async () => {
    const base = scratch();
    const dist = join(base, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), 'x');
    symlinkSync('/etc/passwd', join(dist, 'passwd'));
    const archive = join(base, 'build.tar');
    tar(dist, ['--create', '--file', archive, '.']);
    const into = join(base, 'out');
    const outcome = await extractBuildArchive(archive, into);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('link');
    // Checked before anything is written, so the good member before it is not on disk either.
    expect(existsSync(join(into, 'index.html'))).toBe(false);
  });

  it('refuses a hard link member', async () => {
    const base = scratch();
    const dist = join(base, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'a.html'), 'x');
    spawnSync('ln', [join(dist, 'a.html'), join(dist, 'b.html')]);
    const archive = join(base, 'build.tar');
    tar(dist, ['--create', '--file', archive, '.']);
    const outcome = await extractBuildArchive(archive, join(base, 'out'));
    expect(outcome.ok).toBe(false);
  });

  it('refuses a member that climbs out with ..', async () => {
    const base = scratch();
    const dist = join(base, 'work', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(base, 'work', 'outside.txt'), 'escape');
    const archive = join(base, 'build.tar');
    tar(dist, ['--create', '--absolute-names', '--file', archive, '../outside.txt']);
    const into = join(base, 'out');
    const outcome = await extractBuildArchive(archive, into);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('..');
    expect(existsSync(join(base, 'outside.txt'))).toBe(false);
  });

  it('refuses an absolute member path', async () => {
    const base = scratch();
    writeFileSync(join(base, 'abs.txt'), 'abs');
    const archive = join(base, 'build.tar');
    tar(base, ['--create', '--absolute-names', '--file', archive, join(base, 'abs.txt')]);
    const outcome = await extractBuildArchive(archive, join(base, 'out'));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('absolute');
  });

  it('refuses a destination that already has files in it', async () => {
    // A fresh, empty directory is the only safe target. Files already there could be links.
    const base = scratch();
    const archive = goodBuild(base);
    const into = join(base, 'out');
    mkdirSync(into);
    writeFileSync(join(into, 'planted'), 'x');
    const outcome = await extractBuildArchive(archive, into);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('empty');
  });

  it('refuses a file that is not an archive', async () => {
    const base = scratch();
    const archive = join(base, 'build.tar');
    writeFileSync(archive, 'this is not a tar archive at all, just text that runs long enough'.repeat(20));
    const outcome = await extractBuildArchive(archive, join(base, 'out'));
    expect(outcome.ok).toBe(false);
  });

  it('refuses a truncated archive', async () => {
    const base = scratch();
    const archive = goodBuild(base);
    const bytes = readFileSync(archive);
    writeFileSync(archive, bytes.subarray(0, 700));
    const outcome = await extractBuildArchive(archive, join(base, 'out'));
    expect(outcome.ok).toBe(false);
  });
});

// A hand-written tar header, for archives the system tar will not make: one whose header claims
// more than any limit allows, so a test can show the refusal comes before the allocation.
function header(name: string, type: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write(type, 156, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

describe('extractBuildArchive resource limits', () => {
  it('refuses an archive larger than the archive limit before reading a header', async () => {
    const base = scratch();
    const archive = goodBuild(base);
    const into = join(base, 'out');
    const outcome = await extractBuildArchive(archive, into, { maxArchiveBytes: 1024 });
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('archive limit') });
    expect(existsSync(into)).toBe(false);
  });

  it('refuses a long-name record over the metadata limit without allocating it', async () => {
    const base = scratch();
    const archive = join(base, 'build.tar');
    // The header claims a 1 GiB long name. The file is small, but the size check must come first,
    // so the refusal names the metadata limit rather than a short read.
    writeFileSync(archive, Buffer.concat([header('././@LongLink', 'L', 1024 ** 3), Buffer.alloc(1024)]));
    const alloc = vi.spyOn(Buffer, 'alloc');
    try {
      const outcome = await extractBuildArchive(archive, join(base, 'out'), { maxMetadataBytes: 4096 });
      expect(outcome).toEqual({ ok: false, message: expect.stringContaining('metadata limit') });
      expect(alloc.mock.calls.every(([size]) => size <= 4096)).toBe(true);
    } finally {
      alloc.mockRestore();
    }
  });

  it('refuses a pax record over the metadata limit', async () => {
    const base = scratch();
    const dist = join(base, 'dist');
    const deep = join(dist, ...Array.from({ length: 12 }, (_, i) => `segment-number-${i}-of-a-long-path`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.html'), 'leaf');
    const archive = join(base, 'build.tar');
    tar(dist, ['--create', '--format=pax', '--file', archive, '.']);
    const into = join(base, 'out');
    const outcome = await extractBuildArchive(archive, into, { maxMetadataBytes: 64 });
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('metadata limit') });
    expect(existsSync(into)).toBe(false);
  });

  it('refuses more members than the member limit and writes nothing', async () => {
    const base = scratch();
    const archive = goodBuild(base);
    const into = join(base, 'out');
    const outcome = await extractBuildArchive(archive, into, { maxMembers: 3 });
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('member limit') });
    expect(existsSync(into)).toBe(false);
  });

  it('refuses files that add up past the extracted-size limit and writes nothing', async () => {
    const base = scratch();
    const archive = goodBuild(base);
    const into = join(base, 'out');
    const outcome = await extractBuildArchive(archive, into, { maxExtractedBytes: 20 });
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('extracted-size limit') });
    expect(existsSync(into)).toBe(false);
  });

  it('has default limits a web build fits under', async () => {
    const base = scratch();
    expect((await extractBuildArchive(goodBuild(base), join(base, 'out'))).ok).toBe(true);
  });
});

describe('runExtractBuild', () => {
  function io(): { err: string[]; stdout: (s: string) => void; stderr: (s: string) => void } {
    const err: string[] = [];
    return { err, stdout: () => undefined, stderr: (s) => err.push(s) };
  }

  it('exits 0 on a clean archive', async () => {
    const base = scratch();
    const archive = goodBuild(base);
    const outcome = await runExtractBuild(['--archive', archive, '--into', join(base, 'out')], io());
    expect(outcome).toBe(0);
  });

  it('exits 1 on a refused archive and says why', async () => {
    const base = scratch();
    const dist = join(base, 'dist');
    mkdirSync(dist);
    symlinkSync('/etc/passwd', join(dist, 'passwd'));
    const archive = join(base, 'build.tar');
    tar(dist, ['--create', '--file', archive, '.']);
    const streams = io();
    expect(await runExtractBuild(['--archive', archive, '--into', join(base, 'out')], streams)).toBe(1);
    expect(streams.err.join('')).toContain('link');
  });

  it('exits 2 on bad arguments', async () => {
    expect(await runExtractBuild(['--archive'], io())).toBe(2);
    expect(await runExtractBuild(['--archive', 'a.tar'], io())).toBe(2);
    expect(await runExtractBuild(['--archive', 'a.tar', '--into', 'b', '--x'], io())).toBe(2);
  });
});

describe('usabl extract-build through the CLI', () => {
  it('dispatches to the extractor and exits 2 on bad arguments', async () => {
    const { main } = await import('../../src/cli.js');
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(await main(['extract-build', '--archive'])).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).toContain('extract-build takes --archive');

    // Importing the whole CLI is slow on a loaded machine; the check itself is instant.
  }, 60_000);
});
