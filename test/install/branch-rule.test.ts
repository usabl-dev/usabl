/**
 * The branch-rule generator is read-only. It prints the exact protection setting and
 * verifies the current state with a single read-only gh call. It must never issue a
 * mutating request and must never claim verified when it cannot confirm. Both of those
 * honesty properties are asserted to be load-bearing here.
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

function recordingGh(reply: (args: string[]) => GhResult | null): {
  reader: GhReader;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    reader: {
      run: async (args) => {
        calls.push(args);
        return reply(args);
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

    // Read-only proof: exactly one GET to the protection endpoint, never a mutation.
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]?.[0]).toBe('api');
    expect(gh.calls[0]).toContain(`repos/{owner}/{repo}/branches/${PROTECTED_BRANCH}/protection`);
    for (const call of gh.calls) {
      expect(call).not.toContain('-X');
      expect(call).not.toContain('--method');
      for (const verb of ['PUT', 'POST', 'PATCH', 'DELETE']) {
        expect(call.some((arg) => arg.toUpperCase().includes(verb))).toBe(false);
      }
    }
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

  it('treats a 404 with no protection as not applied', async () => {
    const gh = recordingGh(() => ({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }));
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('not-applied');
    expect(result.exitCode).toBe(2);
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
    expect(isUsablPolicyRequired(JSON.parse(protectionJson(['other']))).valueOf()).toBe(false);
    expect(isUsablPolicyRequired({})).toBe(false);
    expect(isUsablPolicyRequired(null)).toBe(false);
  });
});

// Keep GhResult imported as a value-shaped type check so the fake stays in sync.
const _sampleResult: GhResult = { code: 0, stdout: '', stderr: '' };
void _sampleResult;
