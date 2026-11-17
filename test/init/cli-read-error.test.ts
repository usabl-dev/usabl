/**
 * When `usabl init` cannot read a file, the CLI prints the reader's error. That error names the
 * path, and the path comes from the repository, so it can hold a terminal control sequence. The
 * CLI prints it with each control character labelled by its code point, the way init prints every
 * other repository string.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';

const ESC = '\u001b';
const BEL = '\u0007';
const RLO = '‮';

// The bidirectional controls: the embeddings, overrides, and isolates, and the marks.
const BIDI_CONTROL = /[‎‏‪-‮⁦-⁩]/;

// Any C0 or C1 control character other than the line break that separates printed lines.
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

describe('usabl init --docs when a file read fails', () => {
  let workspace: string;
  let originalCwd: string;
  let stderr: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'usabl-init-read-error-'));
    await mkdir(join(workspace, 'titles/guide'), { recursive: true });
    process.chdir(workspace);
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
    await rm(workspace, { recursive: true, force: true });
  });

  it('labels the control characters in an include target too long for the file system', async () => {
    // No file needs to exist. The reader throws ENAMETOOLONG with the name in its message.
    const target = `${ESC}]0;owned${BEL}${'a'.repeat(300)}.adoc`;
    await writeFile(join(workspace, 'titles/guide/master.adoc'), `= Guide\ninclude::${target}[]\n`);

    expect(await main(['init', '--docs'])).toBe(2);
    const printed = stderr.join('');
    expect(printed).toContain('ENAMETOOLONG');
    expect(printed).toContain('<U+001B>]0;owned<U+0007>');
    expect(RAW_CONTROL.test(printed)).toBe(false);
  });

  it('labels the control characters in an include target that is a link to itself', async () => {
    // git commits such a link. The reader throws ELOOP with the name in its message.
    const name = `loop${ESC}]0;owned${BEL}.adoc`;
    await symlink(name, join(workspace, 'titles/guide', name));
    await writeFile(join(workspace, 'titles/guide/master.adoc'), `= Guide\ninclude::${name}[]\n`);

    expect(await main(['init', '--docs'])).toBe(2);
    const printed = stderr.join('');
    expect(printed).toContain('ELOOP');
    expect(printed).toContain('loop<U+001B>]0;owned<U+0007>.adoc');
    expect(RAW_CONTROL.test(printed)).toBe(false);
  });

  it('strips a right-to-left override from the path, so the printed path cannot read as another path', async () => {
    // U+202E makes the terminal draw the rest of the line in reverse.
    const name = `loop${RLO}cod.adoc`;
    await symlink(name, join(workspace, 'titles/guide', name));
    await writeFile(join(workspace, 'titles/guide/master.adoc'), `= Guide\ninclude::${name}[]\n`);

    expect(await main(['init', '--docs'])).toBe(2);
    const printed = stderr.join('');
    expect(printed).toContain('ELOOP');
    expect(printed).not.toContain(RLO);
    expect(BIDI_CONTROL.test(printed)).toBe(false);
  });

  it('prints the whole path of a long read error, with no length cap', async () => {
    const target = `${RLO}${'a'.repeat(300)}.adoc`;
    await writeFile(join(workspace, 'titles/guide/master.adoc'), `= Guide\ninclude::${target}[]\n`);

    expect(await main(['init', '--docs'])).toBe(2);
    const printed = stderr.join('');
    expect(printed).toContain('ENAMETOOLONG');
    expect(printed).toContain(`${'a'.repeat(300)}.adoc`);
    expect(printed).not.toContain(RLO);
  });
});
