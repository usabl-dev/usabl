/**
 * Whether a branch name is a plain name: letters, digits, and . _ - /. A name in any other form is
 * treated as not found, never escaped and written. Every place usabl writes a branch name it read
 * from git takes it through this one rule.
 */
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

export function isSafeBranchName(name: string): boolean {
  return SAFE_BRANCH.test(name);
}
