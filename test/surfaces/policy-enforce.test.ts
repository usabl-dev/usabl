import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { buildGuardedSet } from '../../src/trust/guard.js';
import {
  collectReviews,
  enforceAccessibility,
  enforcePolicy,
  GITHUB_REVIEWS_PAGE_SIZE,
  GithubAnswerError,
  isAskableLogin,
  parseGithubReviews,
  parsePullRequestEvent,
  parseResultJson,
  parseResultText,
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
  floorHeadroom: [],
  floorUnconfirmed: [],
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

  const noVerdict = (nothingToCheck: boolean, over: Partial<Result> = {}): Result =>
    result({
      verdict: null,
      exitCode: 0,
      accessibilityVerdict: null,
      accessibilityExitCode: 0,
      coverage: { changedFiles: ['src/App.tsx'], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck },
      ...over,
    });

  it('passes an idle run, where nothing was to check', () => {
    const outcome = enforceAccessibility(noVerdict(true));

    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toContain('idle');
  });

  it('does not read no verdict with exit 0 as idle when something was to check', () => {
    // The engine writes no verdict with exit 0 only when no UI file changed. A Result that says a
    // UI file changed and still carries no verdict proved nothing, so it must block, the way the
    // pull request comment and the Stop hook read it.
    const outcome = enforceAccessibility(noVerdict(false));

    expect(outcome.exitCode).toBe(4);
    expect(outcome.message).not.toContain('idle');
    expect(outcome.message).toContain('no verdict');
  });

  it('blocks the same Result read from a document, as CI reads it', () => {
    const document = JSON.stringify(noVerdict(false));

    expect(enforceAccessibility(parseResultText(document)).exitCode).toBe(4);
  });

  it('keeps an approval hold over an idle scan as idle on the accessibility side', () => {
    const outcome = enforceAccessibility(noVerdict(true, { verdict: 'approval_required', exitCode: 2 }));

    expect(outcome.exitCode).toBe(0);
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
      lsFilesUnder: async (ref, prefixes) => {
        const bases = prefixes.map((prefix) => (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix));
        return Object.keys(table(ref))
          .filter((path) => {
            const value = table(ref)[path];
            if (value === null) {
              return false;
            }
            return bases.some((base) => base === '' || path === base || path.startsWith(`${base}/`));
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
      readPermission: async () => ({ permission: 'write' }),
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

  // On a public repository anyone can submit an approving review. A login in CODEOWNERS that lost
  // its access, or a name someone else registered, would otherwise pass this check. So an approval
  // counts only when GitHub reports the code owner's permission on the repository as write or admin.
  describe('the code owner permission', () => {
    const aliceApproves = async (): Promise<PolicyReview[]> => [
      { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
    ];
    const permissionIs = (permission: unknown) => async (): Promise<unknown> => ({ permission });

    for (const permission of ['write', 'admin']) {
      it(`counts an approval from a code owner with ${permission} permission`, async () => {
        const out = await enforcePolicy(
          policyResult,
          deps({ listReviews: aliceApproves, readPermission: permissionIs(permission) }),
        );
        expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
      });
    }

    for (const permission of ['read', 'none']) {
      it(`does not count an approval from a code owner with ${permission} permission, and says why`, async () => {
        const out = await enforcePolicy(
          policyResult,
          deps({ listReviews: aliceApproves, readPermission: permissionIs(permission) }),
        );
        expect(out.exitCode).toBe(2);
        expect(out.message).toContain('approved this head for .usabl-evidence.json');
        expect(out.message).toContain(
          `the approval from @alice does not count, because GitHub reports that user's permission on this repository as ${permission}, and an approval counts only with write or admin`,
        );
      });
    }

    // Each failure gets the reason a person can act on. None of them counts as write.
    const notRead = "usabl could not read that user's permission on this repository";
    const tokenHint = `${notRead} (the job's token needs read access to repository metadata)`;
    const noUser = 'GitHub has no readable user by that login on this repository';
    const failures: Array<[string, () => Promise<unknown>, string]> = [
      ['a network error', async () => Promise.reject(new Error('fetch failed')), notRead],
      ['a 401 answer', async () => Promise.reject(new GithubAnswerError(401)), tokenHint],
      ['a 403 answer', async () => Promise.reject(new GithubAnswerError(403)), tokenHint],
      ['a 404 answer', async () => Promise.reject(new GithubAnswerError(404)), noUser],
      ['a 500 answer', async () => Promise.reject(new GithubAnswerError(500)), notRead],
      ['a body that is not an object', async () => 'write', notRead],
      ['a body with no permission field', async () => ({ role_name: 'write' }), notRead],
      ['a value outside the four', async () => ({ permission: 'maintain' }), notRead],
      ['a value that is not a string', async () => ({ permission: 7 }), notRead],
    ];
    for (const [label, readPermission, reason] of failures) {
      it(`does not count an approval when the permission read fails with ${label}, and says why`, async () => {
        const out = await enforcePolicy(policyResult, deps({ listReviews: aliceApproves, readPermission }));
        expect(out.exitCode).toBe(2);
        expect(out.message).toContain(`the approval from @alice does not count, because ${reason}`);
        if (reason !== tokenHint) {
          expect(out.message).not.toContain('token');
        }
      });
    }

    it('retracts an approval on a later request for changes, also when the permission read fails', async () => {
      const asked: string[] = [];
      const out = await enforcePolicy(
        policyResult,
        deps({
          listReviews: async () => [
            { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
            { userLogin: 'alice', state: 'CHANGES_REQUESTED', commitId: 'abc' },
          ],
          readPermission: async (login) => {
            asked.push(login);
            throw new Error('fetch failed');
          },
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).not.toContain('does not count');
      expect(asked).toEqual([]);
    });

    it('reads the permission once per login, and never for a reviewer who is not a code owner', async () => {
      const asked: string[] = [];
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: {
            codeowners: '.usabl-evidence.json @alice\nusabl.config.json @alice\n',
            head: { 'usabl.config.json': '{"guardedPaths":[],"tampered":true}' },
          },
          listReviews: async () => [
            { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
            { userLogin: 'mallory', state: 'APPROVED', commitId: 'abc' },
          ],
          readPermission: async (login) => {
            asked.push(login);
            return { permission: 'read' };
          },
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(asked).toEqual(['alice']);
      expect(out.message.split('the approval from @alice does not count')).toHaveLength(2);
    });

    it('asks nothing for a code owner whose login form usabl does not read, and does not count it', async () => {
      const asked: string[] = [];
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @bad.login\n' },
          listReviews: async () => [{ userLogin: 'bad.login', state: 'APPROVED', commitId: 'abc' }],
          readPermission: async (login) => {
            asked.push(login);
            return { permission: 'write' };
          },
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(asked).toEqual([]);
      expect(out.message).toContain('the approval from @bad.login does not count, because usabl does not read this login form');
    });

    it('counts an approval from a managed user login, which holds an underscore', async () => {
      const asked: string[] = [];
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @mona_acme\n' },
          listReviews: async () => [{ userLogin: 'mona_acme', state: 'APPROVED', commitId: 'abc' }],
          readPermission: async (login) => {
            asked.push(login);
            return { permission: 'write' };
          },
        }),
      );
      expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
      expect(asked).toEqual(['mona_acme']);
    });

    it('asks about a login only in a form GitHub uses', () => {
      for (const login of ['mona', 'mona-lisa', 'mona_acme', 'm0n4', 'A1']) {
        expect(isAskableLogin(login), login).toBe(true);
      }
      for (const login of ['a/b', 'a.b', 'a b', '', '_mona', '-mona', 'a'.repeat(101)]) {
        expect(isAskableLogin(login), login).toBe(false);
      }
    });

    it('passes when another code owner with write permission approved the head', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @alice @bob\n' },
          listReviews: async () => [
            { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
            { userLogin: 'bob', state: 'APPROVED', commitId: 'abc' },
          ],
          readPermission: async (login) => ({ permission: login === 'bob' ? 'write' : 'read' }),
        }),
      );
      expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
    });
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
          lsFilesUnder: (ref, prefixes) => git.lsFilesUnder(ref, prefixes),
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

  it('says no rule covers a dirty guarded path that CODEOWNERS never names', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        gitOver: { codeowners: 'usabl.config.json @bob\n' },
        listReviews: async () => [{ userLogin: 'alice', state: 'APPROVED', commitId: 'abc' }],
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toBe('no CODEOWNERS rule covers .usabl-evidence.json');
    expect(out.message).not.toContain('approval required');
  });

  it('separates an unowned path from an unapproved one in the same run', async () => {
    const out = await enforcePolicy(
      policyResult,
      deps({
        gitOver: {
          codeowners: 'usabl.config.json @bob\n',
          head: { 'usabl.config.json': '{"guardedPaths":[],"tampered":true}' },
        },
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toBe(
      'no CODEOWNERS rule covers .usabl-evidence.json; approval required: no CODEOWNERS user other than the PR author approved this head for usabl.config.json',
    );
  });

  describe('code owners by the last matching rule', () => {
    const aliceApproved = async (): Promise<PolicyReview[]> => [
      { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
    ];

    it('passes when a team line matches no diverged guarded path', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: 'docs/ @usabl-dev/docs\n.usabl-evidence.json @alice\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
    });

    it('passes when a later user line replaces an earlier team line', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '* @usabl-dev/everyone\n.usabl-evidence.json @alice\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(0);
    });

    it('passes when an email line matches no diverged guarded path', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: 'docs/ docs@example.com\n.usabl-evidence.json @alice\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(0);
    });

    it('passes when an owner-less line matches no diverged guarded path', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @alice\ndocs/generated/\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(0);
    });

    it('still refuses when the last matching rule names a team', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @alice\n.usabl-evidence.json @usabl-dev/owners\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out).toEqual({
        exitCode: 2,
        message:
          'the last CODEOWNERS rule that matches .usabl-evidence.json names a team or an email, and usabl enforce policy accepts approval only from a user login',
      });
    });

    it('still refuses when the last matching rule names a user and a team', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @alice @usabl-dev/owners\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('names a team or an email');
    });

    it('still refuses when the last matching rule names an email', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @alice\n*.json owners@example.com\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('names a team or an email');
    });

    it('still refuses when the last matching rule names no owner', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @alice\n/.usabl-evidence.json\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out).toEqual({
        exitCode: 2,
        message: 'the last CODEOWNERS rule that matches .usabl-evidence.json names no owner',
      });
    });

    // A gate change, with the guarded folder owned by a team and a later wildcard rule for its
    // parent folder. GitHub documents that docs/* does not match nested files, so the last match
    // for src/gate/index.ts is the team rule, and alice's approval cannot clear it.
    const gateChange = (codeowners: string): Parameters<typeof policyGit>[0] => ({
      codeowners,
      trusted: { 'usabl.config.json': '{"guardedPaths":["src/gate/"]}', 'src/gate/index.ts': 'gate\n' },
      head: {
        'usabl.config.json': '{"guardedPaths":["src/gate/"]}',
        '.usabl-evidence.json': '{"version":1,"entries":[]}',
        'src/gate/index.ts': 'changed gate\n',
      },
    });

    it('refuses when a later wildcard rule for a parent folder does not reach the team-owned file', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({ gitOver: gateChange('/src/gate/ @org/gate-team\nsrc/* @alice\n'), listReviews: aliceApproved }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('src/gate/index.ts');
      expect(out.message).toContain('names a team or an email');
    });

    it('refuses when the last rule that could match uses a form GitHub does not document for that path', async () => {
      // A slash-free name with no trailing slash, such as `gate`, may or may not own the files
      // in a folder of that name. GitHub's examples do not settle it, so the last match is unknown.
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: gateChange('/src/gate/ @alice\ngate @bob\n'),
          listReviews: async () => [
            { userLogin: 'alice', state: 'APPROVED', commitId: 'abc' },
            { userLogin: 'bob', state: 'APPROVED', commitId: 'abc' },
          ],
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('src/gate/index.ts');
      expect(out.message).toContain('gate');
      expect(out.message).toContain('cannot tell');
    });

    it('refuses when a later slash-free wildcard rule may own a folder whose name it matches', async () => {
      // GitHub's documentation does not say whether *.js owns src/lib.js/index.ts. gitignore says
      // it does, and then the team owns the file, so alice's approval cannot clear it.
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: {
            codeowners: '/src/ @alice\n*.js @org/js\n',
            trusted: { 'usabl.config.json': '{"guardedPaths":["src/"]}', 'src/lib.js/index.ts': 'one\n' },
            head: {
              'usabl.config.json': '{"guardedPaths":["src/"]}',
              '.usabl-evidence.json': '{"version":1,"entries":[]}',
              'src/lib.js/index.ts': 'changed\n',
            },
          },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('src/lib.js/index.ts');
      expect(out.message).toContain('cannot tell');
    });

    it('passes when the form GitHub does not document comes before the last match', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({ gitOver: gateChange('gate @bob\n/src/gate/ @alice\n'), listReviews: aliceApproved }),
      );
      expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
    });

    const hashChange = (codeowners: string): Parameters<typeof policyGit>[0] => ({
      codeowners,
      trusted: { 'usabl.config.json': '{"guardedPaths":["src/"]}', 'src/file#1.ts': 'one\n' },
      head: {
        'usabl.config.json': '{"guardedPaths":["src/"]}',
        '.usabl-evidence.json': '{"version":1,"entries":[]}',
        'src/file#1.ts': 'changed\n',
      },
    });

    it('refuses the whole file when a # sits inside a pattern', async () => {
      // Cutting the line at that # would read `/src/file` with no owner, which matches nothing, and
      // leave `/src/ @alice` as the last match. GitHub may read the # as part of the pattern.
      const out = await enforcePolicy(
        policyResult,
        deps({ gitOver: hashChange('/src/ @alice\n/src/file#1.ts @org/team\n'), listReviews: aliceApproved }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('#');
      expect(out.message).toContain('/src/file#1.ts');
    });

    it('reads a # after whitespace as a comment, as in GitHub\'s example', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({ gitOver: hashChange('*.js @bob\n/src/ @alice #This is an inline comment.\n'), listReviews: aliceApproved }),
      );
      expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
    });

    it('still refuses the whole file on a pattern it cannot parse, even after a matching user line', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: '.usabl-evidence.json @alice\ndocs/**/*.md @usabl-dev/docs\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('docs/**/*.md');
    });

    it('still refuses the whole file on an owner that is not a user, a team, or an email', async () => {
      const out = await enforcePolicy(
        policyResult,
        deps({
          gitOver: { codeowners: 'docs/ alice\n.usabl-evidence.json @alice\n' },
          listReviews: aliceApproved,
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.message).toContain('alice');
      expect(out.message).toContain('not a @user login, an @org/team, or an email');
    });
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
    };
    // Ensure the dirty path exists at the trusted ref, but do not clobber the real config or
    // CODEOWNERS when one of them is the dirty file: enforcePolicy resolves owners from the trusted
    // ref, so the trusted CODEOWNERS must stay valid even when CODEOWNERS itself is the change.
    if (!(over.dirty in trusted)) {
      trusted[over.dirty] = 'trusted bytes';
    }
    const headTable: Record<string, string> = { ...trusted, [over.dirty]: 'head bytes' };
    const table = (ref: string): Record<string, string> => (ref === 'origin/main' ? trusted : headTable);
    return {
      trustedRef: 'origin/main',
      pr: { authorLogin: over.author ?? 'eparenti', headSha: head },
      git: {
        show: async (ref, path) => table(ref)[path] ?? null,
        lsFilesUnder: async (ref, prefixes) => {
          const bases = prefixes.map((prefix) => (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix));
          return Object.keys(table(ref))
            .filter((path) => bases.some((base) => base === '' || path === base || path.startsWith(`${base}/`)))
            .sort();
        },
      },
      listReviews: async () => over.reviews ?? [],
      readPermission: async () => ({ permission: 'write' }),
    };
  }

  it('accepts a real owner approval of the current head on a guarded path', async () => {
    const out = await enforcePolicy(
      policyResult,
      await repoDeps({
        dirty: 'src/gate/index.ts',
        author: 'outside-contributor',
        reviews: [{ userLogin: 'eparenti', state: 'APPROVED', commitId: head }],
      }),
    );
    expect(out).toEqual({ exitCode: 0, message: 'policy owner approved current head' });
  });

  it('still refuses a guarded path whose owners have not approved this head', async () => {
    const out = await enforcePolicy(
      policyResult,
      await repoDeps({
        dirty: 'src/trust/guard.ts',
        author: 'outside-contributor',
        reviews: [{ userLogin: 'eparenti', state: 'APPROVED', commitId: 'stale' }],
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.message).toContain('approval required');
    expect(out.message).not.toContain('no CODEOWNERS rule covers');
  });

  /**
   * The gate is only satisfiable if every guarded path has an owner who can clear it, so
   * that is the invariant, not the wording of any one refusal. This trips when a guarded
   * path is added without a rule, when a rule stops covering the path it was written for,
   * and when CODEOWNERS gains a pattern the matcher refuses to interpret.
   */
  it('gives every guarded path an owner who can clear it', async () => {
    const config: unknown = JSON.parse(
      await readFile(new URL('../../usabl.config.json', import.meta.url), 'utf8'),
    );
    const guarded = buildGuardedSet(config as Parameters<typeof buildGuardedSet>[0]);
    expect(guarded.length).toBeGreaterThan(0);

    const codeowners = await readFile(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8');
    // Every login the file names anywhere, so the check is about coverage of the path and
    // not about which of the owners happens to be listed for it.
    const logins = [
      ...new Set(
        codeowners
          .split('\n')
          .flatMap((line) => line.replace(/#.*$/, '').match(/@[\w.-]+/g) ?? [])
          .map((owner) => owner.slice(1)),
      ),
    ];
    const reviews = logins.map((login) => ({ userLogin: login, state: 'APPROVED', commitId: head }));

    const unclearable: { path: string; message: string }[] = [];
    for (const entry of guarded) {
      // A directory entry is expanded to files before enforcePolicy sees a dirty path, so probe a
      // representative file under it. CODEOWNERS must own that file, or the directory has a gap.
      const path = entry.endsWith('/') ? `${entry}probe-file` : entry;
      const out = await enforcePolicy(
        policyResult,
        await repoDeps({ dirty: path, author: 'outside-contributor', reviews }),
      );
      if (out.exitCode !== 0) {
        unclearable.push({ path, message: out.message });
      }
    }
    expect(unclearable).toEqual([]);
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
