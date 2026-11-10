import type { InstallGit } from '../../src/install/repo-git.js';

/**
 * A git for install tests that knows origin's default branch and the files on it. defaultBranch
 * null is a repository where git cannot name one. Any other git call answers null, as a git that
 * failed would.
 */
export function fakeGit(defaultBranch: string | null, onBranch: Record<string, string> = {}): InstallGit {
  return {
    run: async (args) => {
      if (args[0] === 'symbolic-ref') return defaultBranch === null ? null : `refs/remotes/origin/${defaultBranch}\n`;
      if (args[0] === 'show' && defaultBranch !== null) {
        const prefix = `refs/remotes/origin/${defaultBranch}:./`;
        const spec = args[1] ?? '';
        return spec.startsWith(prefix) ? (onBranch[spec.slice(prefix.length)] ?? null) : null;
      }
      return null;
    },
  };
}
