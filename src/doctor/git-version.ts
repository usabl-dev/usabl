/**
 * Read-only probe for the git version, for `usabl doctor`. usabl runs
 * `git rev-parse --verify --quiet --end-of-options <ref>` so a ref that starts with a dash is never
 * read as an option. git learned `--end-of-options` for rev-parse in 2.30, so that is the oldest
 * version usabl needs. With an older git those reads fail.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const MIN_GIT_VERSION = '2.30';
const MIN_MAJOR = 2;
const MIN_MINOR = 30;

// What `git --version` printed, that git is not installed, or that it ran and failed.
export type GitVersionProbe = { kind: 'output'; text: string } | { kind: 'missing' } | { kind: 'failed' };

export interface GitVersion {
  major: number;
  minor: number;
  // The numeric part only, such as 2.39.3, so nothing else git printed reaches the report.
  text: string;
}

/** The version in `git --version` output, or null when the output is not in a form usabl knows. */
export function parseGitVersion(output: string): GitVersion | null {
  const match = /^git version (\d{1,4})\.(\d{1,4})(\.\d{1,4})?/.exec(output);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return { major, minor, text: `${String(major)}.${String(minor)}${match[3] ?? ''}` };
}

export function isOlderThanMinimum(version: GitVersion): boolean {
  return version.major < MIN_MAJOR || (version.major === MIN_MAJOR && version.minor < MIN_MINOR);
}

const execFileAsync = promisify(execFile);

export async function probeGitVersion(): Promise<GitVersionProbe> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return { kind: 'output', text: stdout };
  } catch (error) {
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed' };
  }
}
