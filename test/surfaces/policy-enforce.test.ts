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
  const owners = `# policy\n.usabl-evidence.json @alice\nusabl.config.json @alice @bob\n`;

  it('passes when the Result is not approval_required', async () => {
    let shown = false;
    const out = await enforcePolicy(result({ verdict: 'verified', exitCode: 0 }), {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: {
        show: async () => {
          shown = true;
          return owners;
        },
      },
      listReviews: async () => [],
    });
    expect(out.exitCode).toBe(0);
    expect(shown).toBe(false);
  });

  it('fails when approval_required has no qualifying review', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => owners },
      listReviews: async () => [],
    });
    expect(out.exitCode).toBe(2);
  });

  it('passes when a non-author CODEOWNERS user approved the current head', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => owners },
      listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
    });
    expect(out.exitCode).toBe(0);
  });

  it('ignores the PR author approving their own policy change', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'alice', headSha: 'abc' },
      git: { show: async () => owners },
      listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
    });
    expect(out.exitCode).toBe(2);
  });

  it('ignores an approval that does not match the current head SHA', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => owners },
      listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'old' }],
    });
    expect(out.exitCode).toBe(2);
  });

  it('keeps an approval when the same owner later comments', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => owners },
      listReviews: async () => [
        { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
        { userLogin: 'alice', state: 'COMMENTED', commitId: 'abc' },
      ],
    });
    expect(out.exitCode).toBe(0);
  });

  it('retracts an approval when the same owner later requests changes', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => owners },
      listReviews: async () => [
        { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
        { userLogin: 'alice', state: 'CHANGES_REQUESTED', commitId: 'abc' },
      ],
    });
    expect(out.exitCode).toBe(2);
  });

  it('uses the last matching CODEOWNERS rule for a path', async () => {
    const lastMatch = `* @alice\n.usabl-evidence.json @bob\n`;
    const aliceOnly = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => lastMatch },
      listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
    });
    const bobApproved = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => lastMatch },
      listReviews: async () => [{ userLogin: 'bob', state: 'APPROVED', commitId: 'abc' }],
    });
    expect(aliceOnly.exitCode).toBe(2);
    expect(bobApproved.exitCode).toBe(0);
  });

  it('reads CODEOWNERS from the trusted ref, not working-tree bytes', async () => {
    const shown: string[] = [];
    await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: {
        show: async (ref, path) => {
          shown.push(`${ref}:${path}`);
          return owners;
        },
      },
      listReviews: async () => [],
    });
    expect(shown).toEqual(['origin/main:.github/CODEOWNERS']);
  });

  it('fails closed when CODEOWNERS is missing at the trusted ref', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => null },
      listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
    });
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('missing');
  });

  it('fails closed when CODEOWNERS uses a team owner', async () => {
    const out = await enforcePolicy(policyResult, {
      trustedRef: 'origin/main',
      pr: { authorLogin: 'carol', headSha: 'abc' },
      git: { show: async () => '.usabl-evidence.json @usabl-dev/owners\n' },
      listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
    });
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('user login');
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
