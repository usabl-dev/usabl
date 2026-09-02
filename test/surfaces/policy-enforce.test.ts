import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import {
  collectReviews,
  enforceAccessibility,
  enforcePolicy,
  GITHUB_REVIEWS_PAGE_SIZE,
  parseGithubReviews,
  parsePullRequestEvent,
  parseResultJson,
  type PolicyEnforceDeps,
  type PolicyReview,
} from '../../src/surfaces/policy-enforce.js';

const result = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: 'verified',
  accessibilityExitCode: 0,
  paidDownCount: 0,
  ...over,
});

const policyResult = result({
  verdict: 'approval_required',
  exitCode: 2,
  dirtyGuardedPaths: ['.usabl-evidence.json'],
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
});

describe('enforceAccessibility', () => {
  it('exits with the gate-minted accessibilityExitCode', () => {
    expect(
      enforceAccessibility(
        result({
          verdict: 'approval_required',
          exitCode: 2,
          accessibilityVerdict: 'regression',
          accessibilityExitCode: 1,
        }),
      ).exitCode,
    ).toBe(1);
  });

  it('fails closed on crash', () => {
    expect(
      enforceAccessibility(result({ verdict: null, exitCode: 4, accessibilityVerdict: null, accessibilityExitCode: 4 }))
        .exitCode,
    ).toBe(4);
  });
});

describe('enforcePolicy', () => {
  const owners = `# policy\n.usabl-evidence.json @alice\nusabl.config.json @bob\n`;
  const trustedConfig = '{"guardedPaths":[]}';

  function policyGit(over: {
    codeowners?: string | null;
    trusted?: Record<string, string | null>;
    head?: Record<string, string | null>;
  } = {}): PolicyEnforceDeps['git'] {
    const trusted: Record<string, string | null> = {
      'usabl.config.json': trustedConfig,
      '.github/CODEOWNERS': over.codeowners === undefined ? owners : over.codeowners,
      '.usabl-evidence.json': '{"version":1,"entries":[]}',
      ...over.trusted,
    };
    const head: Record<string, string | null> = {
      'usabl.config.json': trustedConfig,
      '.github/CODEOWNERS': over.codeowners === undefined ? owners : over.codeowners,
      '.usabl-evidence.json':
        '{"version":1,"entries":[{"screenId":"x","layer":"axe","rule":"r","elementKey":null,"identityBasis":"count","count":1}]}',
      ...over.head,
    };
    const table = (ref: string): Record<string, string | null> => (ref === 'origin/main' ? trusted : head);
    return {
      show: async (ref, path) => table(ref)[path] ?? null,
      lsFiles: async (ref, prefix) => {
        const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
        return Object.keys(table(ref))
          .filter((path) => {
            const value = table(ref)[path];
            if (value === null) {
              return false;
            }
            return path === normalized || path.startsWith(`${normalized}/`);
          })
          .sort();
      },
    };
  }

  const deps = (
    over: Partial<PolicyEnforceDeps> & { gitOver?: Parameters<typeof policyGit>[0] } = {},
  ): PolicyEnforceDeps => {
    const { gitOver, ...rest } = over;
    return {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: policyGit(gitOver),
      listReviews: async () => [],
      ...rest,
    };
  };

  it('passes when git shows no guarded divergence', async () => {
    const out = await enforcePolicy(
      result({ verdict: 'verified', exitCode: 0 }),
      deps({
        gitOver: {
          head: { '.usabl-evidence.json': '{"version":1,"entries":[]}' },
        },
      }),
    );
    expect(out.exitCode).toBe(0);
  });

  it('fails when git shows a guarded diff even if the Result claims verified', async () => {
    const out = await enforcePolicy(result({ verdict: 'verified', exitCode: 0 }), deps());
    expect(out.exitCode).toBe(2);
  });

  it('fails when approval_required has no qualifying review', async () => {
    const out = await enforcePolicy(policyResult, deps());
    expect(out.exitCode).toBe(2);
  });

  it('passes when a non-author CODEOWNERS user approved the current head', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    expect(out.exitCode).toBe(0);
  });

  it('ignores the PR author approving their own policy change', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        pr: { authorLogin: 'alice', headSha: 'abc' },
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    expect(out.exitCode).toBe(2);
  });

  it('ignores an approval that does not match the current head SHA', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'old' }],
      }),
    );
    expect(out.exitCode).toBe(2);
  });

  it('keeps an approval when the same owner later comments', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        listReviews: async () => [
          { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
          { userLogin: 'alice', state: 'COMMENTED', commitId: 'abc' },
        ],
      }),
    );
    expect(out.exitCode).toBe(0);
  });

  it('retracts an approval when the same owner later requests changes', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        listReviews: async () => [
          { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
          { userLogin: 'alice', state: 'CHANGES_REQUESTED', commitId: 'abc' },
        ],
      }),
    );
    expect(out.exitCode).toBe(2);
  });

  it('uses the last matching CODEOWNERS rule for a path', async () => {
    const gitOver = { codeowners: `* @alice\n.usabl-evidence.json @bob\n` };
    const aliceOnly = await enforcePolicy(
      policyResult,
      deps({
        gitOver,
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    const bobApproved = await enforcePolicy(
      policyResult,
      deps({
        gitOver,
        listReviews: async () => [{ userLogin: 'bob', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    expect(aliceOnly.exitCode).toBe(2);
    expect(bobApproved.exitCode).toBe(0);
  });

  it('requires a qualifying owner for every dirty guarded path', async () => {
    const gitOver = {
      head: {
        'usabl.config.json': '{"guardedPaths":[],"tampered":true}',
      },
    };
    const aliceOnly = await enforcePolicy(
      policyResult,
      deps({
        gitOver,
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    const both = await enforcePolicy(
      policyResult,
      deps({
        gitOver,
        listReviews: async () => [
          { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
          { userLogin: 'bob', state: 'APPROVED', commitId: 'abc' },
        ],
      }),
    );
    expect(aliceOnly.exitCode).toBe(2);
    expect(both.exitCode).toBe(0);
  });

  it('reads CODEOWNERS from the trusted ref, not the PR head', async () => {
    const shown: string[] = [];
    const git = policyGit();
    await enforcePolicy(
      policyResult,
      deps({
        git: {
          show: async (ref, path) => {
            shown.push(`${ref}:${path}`);
            return git.show(ref, path);
          },
          lsFiles: (ref, prefix) => git.lsFiles(ref, prefix),
        },
      }),
    );
    expect(shown).toContain('origin/main:.github/CODEOWNERS');
    expect(shown.some((entry) => entry.startsWith('abc:') && entry.endsWith('.github/CODEOWNERS'))).toBe(false);
  });

  it('fails closed when CODEOWNERS is missing at the trusted ref', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        gitOver: { codeowners: null },
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('missing');
  });

  it('fails closed when CODEOWNERS uses a team owner', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        gitOver: { codeowners: '.usabl-evidence.json @usabl-dev/owners\n' },
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('user login');
  });

  it('fails closed and names a CODEOWNERS pattern it cannot interpret', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        gitOver: { codeowners: 'src/**/*.ts @alice\n' },
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('src/**/*.ts');
  });
});

/**
 * These cases run this repository's own CODEOWNERS and its own guardedPaths, because a
 * matcher exercised only on invented patterns is what let the leading-slash bug ship.
 */
describe('enforcePolicy against this repository CODEOWNERS', () => {
  const head = 'ac4c2b439d4ca130b07d4c0013fbc036efc61eeb';

  async function repoDeps(over: {
    dirty: string;
    author?: string;
    reviews?: PolicyReview[];
  }): Promise<PolicyEnforceDeps> {
    const codeowners = await readFile(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8');
    const config = await readFile(new URL('../../usabl.config.json', import.meta.url), 'utf8');
    const trusted: Record<string, string> = {
      'usabl.config.json': config,
      '.github/CODEOWNERS': codeowners,
      [over.dirty]: 'trusted bytes',
    };
    const headTable: Record<string, string> = { ...trusted, [over.dirty]: 'head bytes' };
    const table = (ref: string): Record<string, string> => (ref === 'origin/main' ? trusted : headTable);
    return {
      trustedRef: 'origin/main',
      pr: { authorLogin: over.author ?? 'eparenti', headSha: head },
      git: {
        show: async (ref, path) => table(ref)[path] ?? null,
        lsFiles: async (ref, prefix) => {
          const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
          return Object.keys(table(ref))
            .filter((path) => path === normalized || path.startsWith(`${normalized}/`))
            .sort();
        },
      },
      listReviews: async () => over.reviews ?? [],
    };
  }

  it('accepts a real owner approval of the current head on a guarded path', async () => {
    const out = await enforcePolicy(
      policyResult,
      await repoDeps({
        dirty: 'src/gate/index.ts',
        author: 'eparenti',
        reviews: [{ userLogin: 'vishsanghishetty', state: 'APPROVED', commitId: head }],
      }),
    );
    expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
  });

  it('still refuses a guarded path whose owners have not approved this head', async () => {
    const out = await enforcePolicy(
      policyResult,
      await repoDeps({
        dirty: 'src/trust/guard.ts',
        author: 'eparenti',
        reviews: [{ userLogin: 'vishsanghishetty', state: 'APPROVED', commitId: 'stale' }],
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('approval required');
    expect(out.message).not.toContain('no CODEOWNERS rule covers');
  });

  it('says no rule covers a dirty guarded path that CODEOWNERS never names', async () => {
    const out = await enforcePolicy(
      policyResult,
      await repoDeps({
        dirty: '.usabl-evidence.json',
        author: 'eparenti',
        reviews: [{ userLogin: 'vishsanghishetty', state: 'APPROVED', commitId: head }],
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toBe('no CODEOWNERS rule covers .usabl-evidence.json');
    expect(out.message).not.toContain('approval required');
  });
});

describe('parseResultJson', () => {
  it('rejects accessibilityExitCode 2', () => {
    expect(() =>
      parseResultJson({
        schemaVersion: 'usabl.result.v1',
        accessibilityExitCode: 2,
        accessibilityVerdict: null,
      }),
    ).toThrow(/0, 1, 3, or 4/);
  });

  it('rejects accessibilityVerdict approval_required', () => {
    expect(() =>
      parseResultJson({
        schemaVersion: 'usabl.result.v1',
        accessibilityExitCode: 0,
        accessibilityVerdict: 'approval_required',
      }),
    ).toThrow(/must not be approval_required/);
  });

  it('accepts a gated Result with honest accessibility fields', () => {
    expect(parseResultJson(result({ verdict: 'approval_required', exitCode: 2 })).verdict).toBe(
      'approval_required',
    );
  });
});

describe('collectReviews', () => {
  it('concatenates pages until a short page', async () => {
    const pages = [
      Array.from({ length: GITHUB_REVIEWS_PAGE_SIZE }, (_, index) => ({
        user: { login: `u${index}` },
        state: 'COMMENTED',
        commit_id: 'abc',
      })),
      [{ user: { login: 'alice' }, state: 'APPROVED', commit_id: 'abc' }],
    ];
    const reviews = await collectReviews(async (page) => pages[page - 1]);
    expect(reviews).toHaveLength(GITHUB_REVIEWS_PAGE_SIZE + 1);
    expect(reviews.at(-1)).toEqual({ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' });
  });

  it('fails closed when every page is full through the cap', async () => {
    const full = Array.from({ length: GITHUB_REVIEWS_PAGE_SIZE }, () => ({
      user: { login: 'alice' },
      state: 'APPROVED',
      commit_id: 'abc',
    }));
    await expect(collectReviews(async () => full)).rejects.toThrow(/truncated/);
  });
});

describe('parsePullRequestEvent', () => {
  it('reads author, head SHA, and number from a pull_request event', () => {
    expect(
      parsePullRequestEvent({
        pull_request: { user: { login: 'carol' }, head: { sha: 'abc' }, number: 12 },
      }),
    ).toEqual({ authorLogin: 'carol', headSha: 'abc', number: 12 });
  });

  it('returns null when the payload is not a pull request', () => {
    expect(parsePullRequestEvent({ issue: { number: 1 } })).toBeNull();
    expect(parsePullRequestEvent(null)).toBeNull();
  });
});

describe('parseGithubReviews', () => {
  it('keeps reviews with login, state, and commit_id', () => {
    expect(
      parseGithubReviews([
        { user: { login: 'alice' }, state: 'APPROVED', commit_id: 'abc' },
        { user: { login: 'bob' }, state: 'COMMENTED' },
        { state: 'APPROVED', commit_id: 'abc' },
      ]),
    ).toEqual([{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }]);
  });

  it('returns an empty list when the body is not an array', () => {
    expect(parseGithubReviews({ reviews: [] })).toEqual([]);
  });
});
