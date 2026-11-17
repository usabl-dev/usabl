/**
 * The rule for one config `localFiles` entry: an exact path from the repository root to a file the
 * app reads that git does not see. The config loader refuses an entry that breaks it, and the
 * receipt binds nothing it can match for one, so a library caller that skips the loader cannot
 * make the receipt read outside the repository. It checks text only and reads no file.
 */

/** The most paths `localFiles` may list. */
export const MAX_LOCAL_FILES = 64;

/** The longest path, in characters, one `localFiles` entry may be. */
export const MAX_LOCAL_FILE_PATH_LENGTH = 512;

// The characters with glob meaning in any glob dialect usabl or Node reads. An entry is an exact
// path, so one of these would name a file nobody meant.
const GLOB_CHARACTERS = /[*?[\]{}!]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * Why an entry cannot be bound, as the end of a sentence that starts with the entry, or null when
 * it can. The words never repeat the entry, so the caller decides how to quote it.
 */
export function localFileProblem(entry: string): string | null {
  if (entry.length === 0) {
    return 'is empty, so it names no file. Remove it, or write a path from the repository root.';
  }
  if (entry.length > MAX_LOCAL_FILE_PATH_LENGTH) {
    return `is longer than ${String(MAX_LOCAL_FILE_PATH_LENGTH)} characters. Write a shorter path from the repository root.`;
  }
  if (entry.trim() !== entry) {
    return 'starts or ends with white space, so it names no file. Remove the white space.';
  }
  if (CONTROL_CHARACTERS.test(entry)) {
    return 'holds a control character, so it names no file you can see. Write the path with plain characters.';
  }
  if (entry.includes('\\')) {
    return 'holds a backslash. Write the path from the repository root with forward slashes.';
  }
  if (/^[A-Za-z]:/u.test(entry)) {
    return 'starts with a drive letter, so it names no path in the repository. Write it as a path from the repository root.';
  }
  if (entry.startsWith('/')) {
    return 'starts with /, so it names no path in the repository. Write it as a path from the repository root without the leading slash.';
  }
  if (GLOB_CHARACTERS.test(entry)) {
    return 'holds a glob character, and localFiles takes exact paths only. List each file on its own.';
  }
  const segments = entry.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'has a . or .. segment, so it can name a path outside the repository. Write it as a path from the repository root without them.';
  }
  if (segments.some((segment) => segment.length === 0)) {
    return 'has an empty segment, such as a doubled or trailing slash, so it names no file. Write it as a path to one file.';
  }
  return null;
}

/** Whether a value is a `localFiles` list the receipt can bind. */
export function isBindableLocalFileList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LOCAL_FILES &&
    value.every((entry) => typeof entry === 'string' && localFileProblem(entry) === null)
  );
}
