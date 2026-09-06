/**
 * A configuration usabl cannot read must never present as an accessibility pass.
 *
 * When usabl.config.json diverges on a branch, the scan configuration is re-read from the trusted
 * ref so a policy pull request cannot point the CI browser at a new origin. If that trusted
 * document cannot be parsed, the run has no surfaces and no UI globs. Zero planned screens is also
 * what a genuinely quiet pull request looks like, and the two used to reach the gate as the same
 * fact: nothingToCheck, no accessibility verdict, accessibility exit 0. The overall verdict was
 * still approval_required, but CI enforces the accessibility half separately, so the required
 * aggregate reported both halves passing while a changed UI file was never scanned.
 *
 * These tests assert on the exit code CI actually enforces, not only on Result fields. A test that
 * checked the verdict alone would have passed throughout the defect, because the verdict was
 * correct and the accessibility exit code was the lie.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { REQUIRED_GATE_SCRIPT } from '../src/install/ci.js';
import { run } from '../src/run.js';
import { enforceAccessibility } from '../src/surfaces/policy-enforce.js';

// Spawning a real node process is slow on a busy machine, and the 5s default trips on it.
const SPAWN_TIMEOUT_MS = 60_000;

const TRUSTED_REF = 'origin/main';
const UNPARSEABLE_CONFIG = '{not-json';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: [
    { id: 'clusters', url: 'http://127.0.0.1:5173/clusters', files: ['fixtures/app/src/ClustersPage.tsx'] },
  ],
  guardedPaths: ['usabl.config.json'],
};

const configBytes = JSON.stringify(config);
// A valid but different working-tree document, so the guard sees divergence rather than corruption
// in the working tree. The unreadable bytes are the ones at the trusted ref.
const branchConfigBytes = JSON.stringify({ ...config, appBaseUrl: 'http://127.0.0.1:4000' });

/**
 * What the required aggregate does with this Result, running the exact bytes the workflow runs.
 *
 * The workflow publishes the accessibility verdict as "pass" only when `usabl enforce
 * accessibility` exits 0, and blocks on anything else. That translation is reproduced here so the
 * test covers the whole path from Result to merge decision, which is where the defect lived.
 */
function requiredAggregate(accessibilityExitCode: number): { code: number; output: string } {
  const outcome = spawnSync(process.execPath, ['-e', REQUIRED_GATE_SCRIPT], {
    env: {
      EVENT_NAME: 'pull_request',
      SCAN_RESULT: 'success',
      POLICY_RESULT: 'success',
      ACCESSIBILITY_VERDICT: accessibilityExitCode === 0 ? 'pass' : 'fail',
    },
    encoding: 'utf8',
  });
  if (outcome.error !== undefined) {
    throw outcome.error;
  }
  return { code: outcome.status ?? 1, output: `${outcome.stdout}${outcome.stderr}` };
}

describe('a scan configuration usabl cannot read', () => {
  it(
    'fails the accessibility half of CI when the trusted document will not parse',
    async () => {
      const deps = makeFakeDeps({
        files: { 'usabl.config.json': branchConfigBytes },
        headContents: { 'usabl.config.json': UNPARSEABLE_CONFIG },
        refContents: { [TRUSTED_REF]: { 'usabl.config.json': UNPARSEABLE_CONFIG } },
        changed: [
          { code: 'M', path: 'usabl.config.json' },
          { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
        ],
      });

      const result = await run(deps, config, { trustedRef: TRUSTED_REF });

      // The claim under test: the exit code CI enforces is not a pass.
      const enforced = enforceAccessibility(result);
      expect(enforced.exitCode).not.toBe(0);
      expect(enforced.exitCode).toBe(3);

      const aggregate = requiredAggregate(enforced.exitCode);
      expect(aggregate.code).toBe(1);
      expect(aggregate.output).toContain('NOT verified');

      // The Result itself must carry the same fact, because receipts, the overlay, the pull
      // request comment, and the stop hook all read it rather than the CI exit code.
      expect(result.coverage.nothingToCheck).toBe(false);
      expect(result.accessibilityVerdict).toBe('not_covered');
      expect(result.accessibilityExitCode).toBe(3);
      expect(result.receipt).toBeNull();

      // The divergence is still an approval question, and the guarded path is still named.
      expect(result.verdict).toBe('approval_required');
      expect(result.exitCode).toBe(2);
      expect(result.dirtyGuardedPaths).toContain('usabl.config.json');

      // A reader has to learn why nothing was checked, not just that nothing was.
      const gap = result.coverage.gaps.find((entry) => entry.ref === 'usabl.config.json');
      expect(gap).toBeDefined();
      expect(gap?.reason).toContain(TRUSTED_REF);
      expect(gap?.reason).toContain('does not know which screens');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'fails the accessibility half of CI when the trusted ref has no configuration at all',
    async () => {
      const deps = makeFakeDeps({
        files: { 'usabl.config.json': branchConfigBytes },
        headContents: {},
        refContents: { [TRUSTED_REF]: {} },
        changed: [
          { code: 'A', path: 'usabl.config.json' },
          { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
        ],
      });

      const result = await run(deps, config, { trustedRef: TRUSTED_REF });
      const enforced = enforceAccessibility(result);

      expect(enforced.exitCode).toBe(3);
      expect(requiredAggregate(enforced.exitCode).code).toBe(1);
      expect(result.coverage.nothingToCheck).toBe(false);
      expect(result.accessibilityVerdict).toBe('not_covered');
      expect(
        result.coverage.gaps.some((entry) => entry.ref === 'usabl.config.json'),
      ).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('a run with nothing UI-touching in it', () => {
  it(
    'still passes the accessibility half of CI',
    async () => {
      const deps = makeFakeDeps({
        files: { 'usabl.config.json': configBytes },
        headContents: { 'usabl.config.json': configBytes },
        refContents: { [TRUSTED_REF]: { 'usabl.config.json': configBytes } },
        changed: [{ code: 'M', path: 'README.md' }],
      });

      const result = await run(deps, config, { trustedRef: TRUSTED_REF });
      const enforced = enforceAccessibility(result);

      expect(result.verdict).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.coverage.nothingToCheck).toBe(true);
      expect(enforced.exitCode).toBe(0);
      expect(enforced.message).toBe('accessibility idle (0)');
      expect(requiredAggregate(enforced.exitCode).code).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'is still idle when the configuration diverged but the trusted document reads cleanly',
    async () => {
      // The quiet policy pull request. Divergence alone must not turn the accessibility half red,
      // because usabl read the configuration fine and it really did say there was nothing to check.
      const deps = makeFakeDeps({
        files: { 'usabl.config.json': branchConfigBytes },
        headContents: { 'usabl.config.json': configBytes },
        refContents: { [TRUSTED_REF]: { 'usabl.config.json': configBytes } },
        changed: [{ code: 'M', path: 'usabl.config.json' }],
      });

      const result = await run(deps, config, { trustedRef: TRUSTED_REF });
      const enforced = enforceAccessibility(result);

      expect(result.verdict).toBe('approval_required');
      expect(result.coverage.nothingToCheck).toBe(true);
      expect(result.accessibilityVerdict).toBeNull();
      expect(enforced.exitCode).toBe(0);
      expect(requiredAggregate(enforced.exitCode).code).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});
