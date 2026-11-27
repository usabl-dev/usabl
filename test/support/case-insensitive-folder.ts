/**
 * A folder on a file system that ignores letter case, for tests of what a macOS or Windows
 * working copy does. It is the folder USABL_CASE_INSENSITIVE_DIR names, or else the system's
 * temporary folder, and it is used only when a probe file written as `Probe` opens as `probe`.
 *
 * On Linux, a folder like that can be made without root: a tmpfs mounted with `casefold` inside
 * `unshare -r -m`, with the casefold flag set on a folder in it (FS_IOC_SETFLAGS with
 * FS_CASEFOLD_FL). The test run then starts inside that namespace with the variable set. On macOS
 * the temporary folder already ignores case.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type CaseInsensitiveFolder = { base: string; reason: null } | { base: null; reason: string };

/** Whether a file written as `Probe` in a new folder under the base opens as `probe`. */
export async function folderIgnoresCase(base: string): Promise<boolean> {
  let probe = '';
  try {
    probe = await mkdtemp(join(base, 'usabl-case-probe-'));
    await writeFile(join(probe, 'Probe'), 'x');
    await stat(join(probe, 'probe'));
    return true;
  } catch {
    return false;
  } finally {
    if (probe !== '') {
      await rm(probe, { recursive: true, force: true });
    }
  }
}

export async function caseInsensitiveFolder(): Promise<CaseInsensitiveFolder> {
  const named = process.env['USABL_CASE_INSENSITIVE_DIR'];
  const base = named === undefined || named === '' ? tmpdir() : named;
  if (await folderIgnoresCase(base)) {
    return { base, reason: null };
  }
  return { base: null, reason: `${base} keeps letter case; set USABL_CASE_INSENSITIVE_DIR to a folder that ignores it` };
}
