/**
 * The branch-rule generator is read-only. It prints the exact protection setting and
 * verifies the current state with a single read-only gh call. The port is read-only by
 * construction: it exposes only getJson(endpoint), so a caller cannot pass a method or a
 * mutating body through it. It must also never claim verified when it cannot confirm, and
 * it must not turn a generic 404 into a confident "not applied". Both honesty properties
 * are asserted to be load-bearing here.
 */
import { describe, expect, it } from 'vitest';
import type { GhReader, GhResult } from '../../src/install/branch-rule.js';
import {
  PROTECTED_BRANCH,
  REQUIRED_CHECK,
  branchRuleSetting,
  isUsablPolicyRequired,
  verifyBranchRule,
} from '../../src/install/branch-rule.js';

function recordingGh(reply: (endpoint: string) => GhResult | null): {
  reader: GhReader;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      getJson: async (endpoint) => {
        calls.push(endpoint);
        return reply(endpoint);
      },
    },
  };
}

function protectionJson(contexts: string[]): string {
  return JSON.stringify({
    required_status_checks: { strict: true, checks: contexts.map((context) => ({ context, app_id: -1 })) },
  });
}

describe('branchRuleSetting', () => {
  it('names the exact required check and branch with concrete values', () => {
    const setting = branchRuleSetting();
    expect(setting).toContain(REQUIRED_CHECK);
    expect(setting).toContain(PROTECTED_BRANCH);
    expect(setting).toContain('required_status_checks');
    expect(setting).toContain('contexts: ["usabl-policy"]');
    expect(setting.toLowerCase()).toContain('pull request');
  });
});

describe('verifyBranchRule', () => {
  it('reports verified when usabl-policy is a required check, using one read-only GET', async () => {
    const gh = recordingGh(() => ({ code: 0, stdout: protectionJson(['usabl-policy']), stderr: '' }));
    const result = await verifyBranchRule(gh.reader);

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('verified');
    expect(result.message.toLowerCase()).toContain('verified');

    // Read-only proof: exactly one getJson to the protection endpoint. The port exposes no
    // method or body, so it cannot mutate; the endpoint it was asked for is exact.
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toBe(`repos/{owner}/{repo}/branches/${PROTECTED_BRANCH}/protection`);
  });

  it('reports not applied when the check is absent, and prints the exact setting', async () => {
    const gh = recordingGh(() => ({ code: 0, stdout: protectionJson(['other-check']), stderr: '' }));
    const result = await verifyBranchRule(gh.reader);

    // Load-bearing: with the rule absent it must NOT claim verified. If the verified
    // guard were removed and always returned verified, this flips red.
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('not-applied');
    expect(result.message).toContain(REQUIRED_CHECK);
    expect(result.message.toLowerCase()).not.toContain('verified:');
  });

  it('treats a genuine "Branch not protected" response as not applied', async () => {
    // This is the exact signal GitHub returns for GET .../protection when the branch exists
    // but has no protection, so it is a confident not-applied.
    const gh = recordingGh(() => ({ code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' }));
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('not-applied');
    expect(result.exitCode).toBe(2);
  });

  it('refuses a generic 404 or a permission error rather than call it not applied', async () => {
    // Load-bearing: a bare 404 can be a missing branch, wrong repo, or no permission. None
    // of those prove the rule is absent, so they must fall to cannot-verify, not not-applied.
    const notFound = recordingGh(() => ({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }));
    const nf = await verifyBranchRule(notFound.reader);
    expect(nf.action).toBe('cannot-verify');
    expect(nf.exitCode).toBe(2);
    expect(nf.message.toLowerCase()).toContain('verify by hand');
    expect(nf.message.toLowerCase()).not.toContain('verified:');

    const denied = recordingGh(() => ({
      code: 1,
      stdout: '',
      stderr: 'gh: Must have admin rights to Repository. (HTTP 403)',
    }));
    const d = await verifyBranchRule(denied.reader);
    expect(d.action).toBe('cannot-verify');
    expect(d.exitCode).toBe(2);
  });

  it('refuses when gh is unavailable rather than claim verified', async () => {
    const gh = recordingGh(() => null);
    const result = await verifyBranchRule(gh.reader);

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('cannot-verify');
    expect(result.message.toLowerCase()).not.toContain('verified:');
    expect(result.message).toContain(REQUIRED_CHECK);
  });

  it('refuses when gh fails for a non-404 reason such as auth', async () => {
    const gh = recordingGh(() => ({ code: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' }));
    const result = await verifyBranchRule(gh.reader);
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('cannot-verify');
  });
});

describe('isUsablPolicyRequired', () => {
  it('reads both the modern checks list and the legacy contexts list', () => {
    expect(isUsablPolicyRequired(JSON.parse(protectionJson(['usabl-policy'])))).toBe(true);
    expect(
      isUsablPolicyRequired({ required_status_checks: { contexts: ['usabl-policy'] } }),
    ).toBe(true);
    expect(isUsablPolicyRequired(JSON.parse(protectionJson(['other'])))).toBe(false);
    expect(isUsablPolicyRequired({})).toBe(false);
    expect(isUsablPolicyRequired(null)).toBe(false);
  });
});

// Keep GhResult imported as a value-shaped type check so the fake stays in sync.
const _sampleResult: GhResult = { code: 0, stdout: '', stderr: '' };
void _sampleResult;
