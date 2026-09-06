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
 *
 * The configuration plans app screens only. Docs screens come from usabl.docs.json, which the run
 * still reads, so a changed docs page is still scanned while the app half is disclosed as not
 * covered. The gap text has to be true in that case too, which is why one test pairs an unreadable
 * configuration with a changed docs page.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { UsablConfig } from '../src/contracts/index.js';
import { makeFakeDeps } from '../src/deps/fakes.js';
import { REQUIRED_GATE_SCRIPT } from '../src/install/ci.js';
import { run } from '../src/run.js';
import { enforceAccessibility } from '../src/surfaces/policy-enforce.js';

// Spawning a real node process is slow on a busy machine, and the 5s default trips on it.
const SPAWN_TIMEOUT_MS = 60_000;

const TRUSTED_REF = 'origin/main';
const CONFIG_PATH = 'usabl.config.json';
// The one sentence the gap may say about docs. It has to be true whether the docs page was
// scanned or not, so it points at the Result instead of asserting what happened.
const DOCS_SENTENCE =
  "Docs coverage is planned separately under usabl.docs.json; see this run's docs screens and gaps " +
  'for what was actually checked.';
const UNPARSEABLE_CONFIG = '{not-json';
// Valid JSON with the wrong shape. The guard can read it (it only needs guardedPaths), but the
// configuration parser rejects it, so the run has to disclose it the same way as broken JSON.
const SCHEMA_INVALID_CONFIG = JSON.stringify({
  appBaseUrl: 'http://127.0.0.1:5173',
  discovery: { routerFile: 'fixtures/app/src/App.tsx', wideBlastGlobs: [] },
  surfaces: 'not-a-list',
});

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

const docsManifestBytes = JSON.stringify({
  format: 'asciidoc-modular',
  docsBaseUrl: 'http://localhost:8080/docs',
  builtRoot: 'build/html',
  buildCommand: null,
  pages: [
    {
      pageId: 'getting-started',
      url: '/getting-started.html',
      assemblyFile: 'modules/getting-started.adoc',
      sources: ['modules/getting-started.adoc'],
    },
  ],
  sharedGlobs: [],
});

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
        files: { [CONFIG_PATH]: branchConfigBytes },
        headContents: { [CONFIG_PATH]: UNPARSEABLE_CONFIG },
        refContents: { [TRUSTED_REF]: { [CONFIG_PATH]: UNPARSEABLE_CONFIG } },
        changed: [
          { code: 'M', path: CONFIG_PATH },
          { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
        ],
      });
      const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

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
      expect(result.dirtyGuardedPaths).toContain(CONFIG_PATH);

      // No docs manifest here, so nothing at all was scanned. The gap must not be a story told
      // over a scan that quietly happened anyway.
      expect(scanSpy).not.toHaveBeenCalled();

      // A reader has to learn why nothing was checked, not just that nothing was.
      const gap = result.coverage.gaps.find((entry) => entry.ref === CONFIG_PATH);
      expect(gap).toBeDefined();
      expect(gap?.reason).toContain(TRUSTED_REF);
      expect(gap?.reason).toContain('does not know which app screens');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'fails the accessibility half of CI when the trusted ref has no configuration at all',
    async () => {
      const deps = makeFakeDeps({
        files: { [CONFIG_PATH]: branchConfigBytes },
        headContents: {},
        refContents: { [TRUSTED_REF]: {} },
        changed: [
          { code: 'A', path: CONFIG_PATH },
          { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
        ],
      });
      const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

      const result = await run(deps, config, { trustedRef: TRUSTED_REF });
      const enforced = enforceAccessibility(result);

      expect(enforced.exitCode).toBe(3);
      expect(requiredAggregate(enforced.exitCode).code).toBe(1);
      expect(result.coverage.nothingToCheck).toBe(false);
      expect(result.accessibilityVerdict).toBe('not_covered');
      expect(result.receipt).toBeNull();
      expect(scanSpy).not.toHaveBeenCalled();
      expect(
        result.coverage.gaps.some((entry) => entry.ref === CONFIG_PATH),
      ).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'fails the accessibility half of CI when the trusted document is valid JSON of the wrong shape',
    async () => {
      const deps = makeFakeDeps({
        files: { [CONFIG_PATH]: branchConfigBytes },
        headContents: { [CONFIG_PATH]: SCHEMA_INVALID_CONFIG },
        refContents: { [TRUSTED_REF]: { [CONFIG_PATH]: SCHEMA_INVALID_CONFIG } },
        changed: [
          { code: 'M', path: CONFIG_PATH },
          { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
        ],
      });
      const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

      const result = await run(deps, config, { trustedRef: TRUSTED_REF });
      const enforced = enforceAccessibility(result);

      expect(enforced.exitCode).toBe(3);
      expect(requiredAggregate(enforced.exitCode).code).toBe(1);
      expect(result.verdict).toBe('approval_required');
      expect(result.coverage.nothingToCheck).toBe(false);
      expect(result.accessibilityVerdict).toBe('not_covered');
      expect(result.accessibilityExitCode).toBe(3);
      expect(result.receipt).toBeNull();
      expect(scanSpy).not.toHaveBeenCalled();

      const gap = result.coverage.gaps.find((entry) => entry.ref === CONFIG_PATH);
      expect(gap).toBeDefined();
      expect(gap?.reason).toContain(TRUSTED_REF);
      expect(gap?.reason).toContain('surfaces must be an array');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('a trusted configuration git cannot read at all', () => {
  const eacces = () => Object.assign(new Error(`EACCES: permission denied, open '${CONFIG_PATH}'`), { code: 'EACCES' });

  it('fails closed as a crash when the read fails at the guard, before the scan configuration is resolved', async () => {
    const deps = makeFakeDeps({
      files: { [CONFIG_PATH]: branchConfigBytes },
      headContents: { [CONFIG_PATH]: configBytes },
      refContents: { [TRUSTED_REF]: { [CONFIG_PATH]: configBytes } },
      changed: [
        { code: 'M', path: CONFIG_PATH },
        { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
      ],
    });
    const readable = deps.git.show;
    deps.git.show = async (ref, path) => {
      if (ref === TRUSTED_REF && path === CONFIG_PATH) throw eacces();
      return readable(ref, path);
    };
    const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

    const result = await run(deps, config, { trustedRef: TRUSTED_REF });
    const enforced = enforceAccessibility(result);

    // The guard reads the same trusted document first, so the failure surfaces there as a crash.
    // A crash is not a gap, but it is not idle and it is not a pass: no verdict, exit 4, no receipt.
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(4);
    expect(result.summary).toContain('EACCES');
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.accessibilityVerdict).toBeNull();
    expect(result.accessibilityExitCode).toBe(4);
    expect(result.receipt).toBeNull();
    expect(scanSpy).not.toHaveBeenCalled();

    expect(enforced.exitCode).toBe(4);
    expect(enforced.message).not.toContain('idle');
    expect(requiredAggregate(enforced.exitCode).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('discloses a coverage gap when the read fails after the guard has already read the document', async () => {
    const deps = makeFakeDeps({
      files: { [CONFIG_PATH]: branchConfigBytes },
      headContents: { [CONFIG_PATH]: configBytes },
      refContents: { [TRUSTED_REF]: { [CONFIG_PATH]: configBytes } },
      changed: [
        { code: 'M', path: CONFIG_PATH },
        { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
      ],
    });
    // The guard reads the trusted configuration twice: once to decide scope and once in its
    // divergence loop. The next read of it is the scan configuration resolver. Failing from the
    // third read onward exercises that resolver's own handler without touching the guard. If the
    // guard ever reads the document a third time, this test fails as a crash, which is the signal
    // to move the threshold, not a regression in the resolver.
    const readable = deps.git.show;
    let trustedConfigReads = 0;
    deps.git.show = async (ref, path) => {
      if (ref === TRUSTED_REF && path === CONFIG_PATH) {
        trustedConfigReads += 1;
        if (trustedConfigReads >= 3) throw eacces();
      }
      return readable(ref, path);
    };
    const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

    const result = await run(deps, config, { trustedRef: TRUSTED_REF });
    const enforced = enforceAccessibility(result);

    expect(trustedConfigReads).toBeGreaterThanOrEqual(3);
    expect(result.verdict).toBe('approval_required');
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.accessibilityVerdict).toBe('not_covered');
    expect(result.accessibilityExitCode).toBe(3);
    expect(result.receipt).toBeNull();
    expect(scanSpy).not.toHaveBeenCalled();

    const gap = result.coverage.gaps.find((entry) => entry.ref === CONFIG_PATH);
    expect(gap).toBeDefined();
    expect(gap?.reason).toContain('EACCES');

    expect(enforced.exitCode).toBe(3);
    expect(requiredAggregate(enforced.exitCode).code).toBe(1);
  }, SPAWN_TIMEOUT_MS);
});

describe('an unreadable app configuration next to a changed docs page', () => {
  it(
    'still checks the docs page, discloses the app half as not covered, and says so in the gap',
    async () => {
      const deps = makeFakeDeps({
        files: { [CONFIG_PATH]: branchConfigBytes, 'usabl.docs.json': docsManifestBytes },
        headContents: { [CONFIG_PATH]: UNPARSEABLE_CONFIG, 'usabl.docs.json': docsManifestBytes },
        refContents: {
          [TRUSTED_REF]: { [CONFIG_PATH]: UNPARSEABLE_CONFIG, 'usabl.docs.json': docsManifestBytes },
        },
        changed: [
          { code: 'M', path: CONFIG_PATH },
          { code: 'M', path: 'fixtures/app/src/Profile.tsx' },
          { code: 'M', path: 'modules/getting-started.adoc' },
        ],
      });
      const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

      const result = await run(deps, config, { trustedRef: TRUSTED_REF });
      const enforced = enforceAccessibility(result);

      // Exactly one scan, and it is the docs page. No app target was ever planned, so none was
      // scanned. Docs findings are real evidence and the run must not throw them away.
      expect(scanSpy).toHaveBeenCalledTimes(1);
      expect(scanSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'getting-started', profile: 'docs' }));
      expect(scanSpy).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'clusters' }));
      expect(result.coverage.affected.map((screen) => screen.screenId)).toEqual(['getting-started']);
      expect(result.screens.map((screen) => screen.screenId)).toEqual(['getting-started']);

      // A docs scan does not rescue the app half. The run still cannot verify.
      expect(result.verdict).not.toBe('verified');
      expect(result.verdict).toBe('approval_required');
      expect(result.coverage.nothingToCheck).toBe(false);
      expect(result.accessibilityVerdict).toBe('not_covered');
      expect(result.accessibilityExitCode).toBe(3);
      expect(result.receipt).toBeNull();
      expect(enforced.exitCode).toBe(3);
      expect(requiredAggregate(enforced.exitCode).code).toBe(1);

      // The gap is attributed to the configuration and its text is true for this run: it is
      // scoped to app screens and it points at the docs screens rather than claiming them.
      const gap = result.coverage.gaps.find((entry) => entry.ref === CONFIG_PATH);
      expect(gap).toBeDefined();
      expect(gap?.state).toBe('not-covered');
      expect(gap?.reason).toContain(TRUSTED_REF);
      expect(gap?.reason).toContain('app configuration');
      expect(gap?.reason).toContain('no app screen was planned or checked');
      expect(gap?.reason).toContain(DOCS_SENTENCE);
      expect(gap?.reason).not.toContain('checked none of them');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'does not claim the docs page was checked when invalid requirements stop every scan',
    async () => {
      // Every scan waits on valid policy input. With the requirements directory configured but
      // empty, the docs page is planned and never scanned. The gap text must survive that: it may
      // point at the docs screens, it may not assert they were checked.
      const configWithRequirements: UsablConfig = { ...config, requirements: 'requirements/' };
      const deps = makeFakeDeps({
        files: {
          [CONFIG_PATH]: JSON.stringify({ ...configWithRequirements, appBaseUrl: 'http://127.0.0.1:4000' }),
          'usabl.docs.json': docsManifestBytes,
        },
        headContents: { [CONFIG_PATH]: UNPARSEABLE_CONFIG, 'usabl.docs.json': docsManifestBytes },
        refContents: {
          [TRUSTED_REF]: { [CONFIG_PATH]: UNPARSEABLE_CONFIG, 'usabl.docs.json': docsManifestBytes },
        },
        changed: [
          { code: 'M', path: CONFIG_PATH },
          { code: 'M', path: 'modules/getting-started.adoc' },
        ],
      });
      const scanSpy = vi.spyOn(deps.checkRunner, 'scan');

      const result = await run(deps, configWithRequirements, { trustedRef: TRUSTED_REF });
      const enforced = enforceAccessibility(result);

      // Planned, but not scanned. The Result must not carry evidence that does not exist.
      expect(result.coverage.affected.map((screen) => screen.screenId)).toEqual(['getting-started']);
      expect(scanSpy).not.toHaveBeenCalled();
      expect(result.screens).toEqual([]);
      expect(result.dirtyGuardedPaths).toContain('requirements');

      expect(result.verdict).toBe('approval_required');
      expect(result.coverage.nothingToCheck).toBe(false);
      expect(result.accessibilityVerdict).toBe('not_covered');
      expect(result.accessibilityExitCode).toBe(3);
      expect(result.receipt).toBeNull();
      expect(enforced.exitCode).toBe(3);
      expect(requiredAggregate(enforced.exitCode).code).toBe(1);

      const gap = result.coverage.gaps.find((entry) => entry.ref === CONFIG_PATH);
      expect(gap).toBeDefined();
      expect(gap?.reason).toContain(DOCS_SENTENCE);
      expect(gap?.reason).not.toMatch(/docs screens[^.]*were (still )?checked/i);
      expect(gap?.reason).not.toContain('checked none of them');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('a run with nothing UI-touching in it', () => {
  it(
    'still passes the accessibility half of CI',
    async () => {
      const deps = makeFakeDeps({
        files: { [CONFIG_PATH]: configBytes },
        headContents: { [CONFIG_PATH]: configBytes },
        refContents: { [TRUSTED_REF]: { [CONFIG_PATH]: configBytes } },
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
        files: { [CONFIG_PATH]: branchConfigBytes },
        headContents: { [CONFIG_PATH]: configBytes },
        refContents: { [TRUSTED_REF]: { [CONFIG_PATH]: configBytes } },
        changed: [{ code: 'M', path: CONFIG_PATH }],
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
