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
  isRequiredCheckPresent,
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
    expect(setting).toContain(`contexts: ["${REQUIRED_CHECK}"]`);
    // The setting must name the aggregate, and must say why usabl-policy alone is not it.
    expect(setting).toContain('usabl-required');
    expect(setting).toContain('accessibility');
    expect(setting.toLowerCase()).toContain('pull request');
  });
});

describe('verifyBranchRule', () => {
  it('reports verified when the aggregate is a required check, using one read-only GET', async () => {
    const gh = recordingGh(() => ({ code: 0, stdout: protectionJson([REQUIRED_CHECK]), stderr: '' }));
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
    const gh = recordingGh((endpoint) =>
      endpoint.includes('/rulesets')
        ? { code: 0, stdout: '[]', stderr: '' }
        : { code: 0, stdout: protectionJson(['other-check']), stderr: '' },
    );
    const result = await verifyBranchRule(gh.reader);

    // Load-bearing: with the rule absent it must NOT claim verified. If the verified
    // guard were removed and always returned verified, this flips red.
    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('not-applied');
    expect(result.message).toContain(REQUIRED_CHECK);
    expect(result.message.toLowerCase()).not.toContain('verified:');
  });

  it('treats no classic protection and no ruleset as not applied', async () => {
    // "Branch not protected" is a confident no-classic-rule; an empty rulesets list is a confident
    // no-ruleset. Together they are a confident not-applied.
    const gh = recordingGh((endpoint) =>
      endpoint.includes('/rulesets')
        ? { code: 0, stdout: '[]', stderr: '' }
        : { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' },
    );
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('not-applied');
    expect(result.exitCode).toBe(2);
  });

  // Builds a gh mock: no classic protection, one active branch ruleset (id 7) whose full body is
  // rulesetBody. Any other endpoint (the repo, extra pages) 404s.
  function ghWithRuleset(rulesetBody: unknown): ReturnType<typeof recordingGh> {
    return recordingGh((endpoint) => {
      if (endpoint.endsWith('/rulesets/7')) {
        return { code: 0, stdout: JSON.stringify(rulesetBody), stderr: '' };
      }
      if (endpoint.includes('/rulesets')) {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: 7, name: 'Protect main', target: 'branch', enforcement: 'active' }]),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
    });
  }

  const requiredCheckRule = {
    type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: REQUIRED_CHECK }] },
  };

  it('reports verified when a ruleset requires the check even with no classic protection', async () => {
    const gh = ghWithRuleset({
      name: 'Protect main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'pull_request', parameters: {} }, requiredCheckRule],
    });
    const result = await verifyBranchRule(gh.reader);
    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('verified');
    expect(result.message).toContain('ruleset');
    expect(result.message).toContain('Protect main');
  });

  it('does not verify from a ruleset whose branch targeting it cannot evaluate', async () => {
    // include ~DEFAULT_BRANCH: main may not be the default, so usabl cannot confirm coverage.
    const gh = ghWithRuleset({
      name: 'Protect default',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [requiredCheckRule],
    });
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('cannot-verify');
    expect(result.message.toLowerCase()).not.toContain('verified:');
  });

  it('does not verify when a ruleset covers all branches but excludes one it cannot evaluate', async () => {
    // False-verify guard: include ~ALL with an exclude usabl cannot evaluate might exclude main.
    const gh = ghWithRuleset({
      name: 'All but some',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/ma*'] } },
      rules: [requiredCheckRule],
    });
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('cannot-verify');
    expect(result.message.toLowerCase()).not.toContain('verified:');
  });

  it('ignores a disabled ruleset and one scoped to another branch', async () => {
    const gh = ghWithRuleset({
      name: 'Disabled',
      target: 'branch',
      enforcement: 'disabled',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [requiredCheckRule],
    });
    const result = await verifyBranchRule(gh.reader);
    // Disabled ruleset does not require it, classic is absent, no other ruleset: confident not-applied.
    expect(result.action).toBe('not-applied');
  });

  it('reads later ruleset pages so a protecting ruleset past page one still verifies', async () => {
    const fullFirstPage = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      name: `filler-${i}`,
      target: 'tag',
      enforcement: 'active',
    }));
    const gh = recordingGh((endpoint) => {
      if (endpoint.endsWith('/rulesets/7')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            name: 'Protect main',
            target: 'branch',
            enforcement: 'active',
            conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
            rules: [requiredCheckRule],
          }),
          stderr: '',
        };
      }
      if (endpoint.endsWith('&page=2')) {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: 7, name: 'Protect main', target: 'branch', enforcement: 'active' }]),
          stderr: '',
        };
      }
      if (endpoint.endsWith('&page=1')) {
        return { code: 0, stdout: JSON.stringify(fullFirstPage), stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
    });
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('verified');
    expect(gh.calls.some((c) => c.endsWith('&page=2'))).toBe(true);
  });

  it('refuses when a ruleset summary is valid but its detail body is malformed', async () => {
    const gh = recordingGh((endpoint) => {
      if (endpoint.endsWith('/rulesets/7')) {
        return { code: 0, stdout: '{}', stderr: '' };
      }
      if (endpoint.includes('/rulesets')) {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: 7, name: 'x', target: 'branch', enforcement: 'active' }]),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
    });
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('cannot-verify');
    expect(result.message.toLowerCase()).not.toContain('verified:');
  });

  it('does not verify when an exclusion list has a non-string entry', async () => {
    // False-verify guard: a null in exclude must not be dropped, leaving include ~ALL reading as
    // full coverage. The malformed condition is ambiguous.
    const gh = ghWithRuleset({
      name: 'Malformed exclude',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~ALL'], exclude: [null] } },
      rules: [requiredCheckRule],
    });
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('cannot-verify');
    expect(result.message.toLowerCase()).not.toContain('verified:');
  });

  it('does not conclude not-applied when a ruleset that requires the check has no conditions', async () => {
    const gh = ghWithRuleset({
      name: 'No conditions',
      target: 'branch',
      enforcement: 'active',
      rules: [requiredCheckRule],
    });
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('cannot-verify');
  });

  it('refuses rather than claims not-applied when classic is absent but rulesets are unreadable', async () => {
    // A ruleset could require the check; if the rulesets read fails, usabl must not call it missing.
    const gh = recordingGh((endpoint) =>
      endpoint.includes('/rulesets')
        ? { code: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' }
        : { code: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' },
    );
    const result = await verifyBranchRule(gh.reader);
    expect(result.action).toBe('cannot-verify');
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

describe('isRequiredCheckPresent', () => {
  it('reads both the modern checks list and the legacy contexts list', () => {
    expect(isRequiredCheckPresent(JSON.parse(protectionJson([REQUIRED_CHECK])))).toBe(true);
    expect(
      isRequiredCheckPresent({ required_status_checks: { contexts: [REQUIRED_CHECK] } }),
    ).toBe(true);
    expect(isRequiredCheckPresent(JSON.parse(protectionJson(['other'])))).toBe(false);
    expect(isRequiredCheckPresent({})).toBe(false);
    expect(isRequiredCheckPresent(null)).toBe(false);
  });

  it('does not accept usabl-policy as the required check', () => {
    // The defect this change closes. A ruleset that requires only usabl-policy can be
    // satisfied while the accessibility scan is red, so it must not read as verified.
    expect(isRequiredCheckPresent(JSON.parse(protectionJson(['usabl-policy'])))).toBe(false);
    expect(isRequiredCheckPresent(JSON.parse(protectionJson(['check', 'usabl-policy'])))).toBe(
      false,
    );
    expect(
      isRequiredCheckPresent(JSON.parse(protectionJson(['check', 'usabl-policy', REQUIRED_CHECK]))),
    ).toBe(true);
  });
});

// Keep GhResult imported as a value-shaped type check so the fake stays in sync.
const _sampleResult: GhResult = { code: 0, stdout: '', stderr: '' };
void _sampleResult;
