# Changelog

## 0.2.0 - 2026-08-27

Release candidate. Version files name 0.2.0. This freeze does not create a git
tag or publish to npm.

### Added

- `usabl init` drafts coverage and related policy from the application tree. It
  does not run the gate and does not write waivers or evidence.
- `usabl baseline` runs a full UI scan and drafts `.usabl-evidence.json` from
  deterministic findings as a reviewable working-tree diff.
- `usabl enforce accessibility` and `usabl enforce policy` split CI checks so a
  policy change can merge with a non-author CODEOWNERS approval of the current
  head for each dirty guarded path. Result gains `accessibilityVerdict` and
  `accessibilityExitCode` (never 2).
- Browser inspector: refresh and locate reported findings.
- Overlay projection and accessibility inspector surfaces.
- Team orientation, How usabl works, and code walkthrough pages.
- Installed-package proof (`npm run test:package`) from an empty directory.

### Changed

- Guarded policy files are validated before coverage, floor, and waiver parse.
  A diverged or corrupt guarded file is `approval_required` (exit 2).
- Waiver dates must be ISO-8601 UTC. The token `never` cannot mint a permanent
  waiver.
- Synthesized `fixed` findings use honest placeholder text. PatternFly evidence
  merge keeps axe state and extra fields for the same identity.
- Receipts bind to the working tree, not only the last commit.
- Keyboard walk stops at `document.body`.
- GitHub Pages publication is restricted. Public pages carry noindex metadata
  and no active content.
- Ground truth and threat model match the shipped contracts, including the Stop
  hook fail-open on crash (exit 4) with disclosure. CI still fails.

### Fixed

- Receipts bind the engine build. `runnerVersion` embeds a sha256 prefix over the
  on-disk engine files, so tampering with or upgrading the engine invalidates a
  prior receipt on re-verification, matching ground truth §10.
- Linked Stop hooks execute.
- Tests are ignored when mapping UI coverage.
- Menu state attributes are read for PatternFly checks.
- Package JSON output is preserved through the build.
- Fleet Insights measurement is runnable. It is not a verdict.
- Requirement YAML intake is pinned to `--trusted-ref` so accessibility checks
  cannot self-grade against unapproved PR policy edits.
- Intake provider wiring now resolves the requirements root from trusted-ref
  `usabl.config.json`, which prevents PR-only path rewrites from dropping
  baseline requirement checks.
