# Changelog

## 0.2.0 - 2026-08-30

Release candidate. Version files name 0.2.0. This freeze does not create a git
tag or publish to npm.

### Added

- `usabl init` drafts coverage and related policy from the application tree. It
  does not run the gate and does not write waivers or evidence.
- `usabl baseline` runs a full UI scan and drafts `.usabl-evidence.json` from
  deterministic findings as a reviewable working-tree diff.
- `usabl floor prune` removes paid-down identities from
  `.usabl-evidence.json` after a full scan so reintroduced barriers gate as
  `new` instead of staying `carried`.
- Resolved floor debt is reported as a paid-down count across the CLI summary,
  the PR comment, and the overlay, each with a reminder to run
  `usabl floor prune` to re-arm the floor. Reporting alone does not re-arm.
- `usabl drift routes` reports drift between the route manifest and the
  application router. It reads only and mints no verdict.
- `usabl install` writes adoption drafts and never enables anything on its own.
  Each target (`--overlay`, `--claude`, `--ci`) writes a draft only or refuses
  with a manual step, and `--branch-rule` is a read-only verify.
- `usabl stop-hook` is the stable Stop hook entry point. It always exits 0, so a
  wedged hook cannot block continuation through an exit code.
- `usabl doctor` is a read-only self-check. It reports each integration surface
  as wired, missing, drifted, or unknown, and mints no verdict.
- `usabl enforce accessibility` and `usabl enforce policy` split CI checks so a
  policy change can merge with a non-author CODEOWNERS approval of the current
  head for each dirty guarded path. Result gains `accessibilityVerdict` and
  `accessibilityExitCode` (never 2).
- `usabl docs` generates accessible documentation artifacts (alt-text manifest,
  announcement snippets, keyboard paths) from a run. It is a generator, not a
  gate: it always exits 0 and binds every artifact to the receipt, so unverified
  surfaces carry no evidence reference. The same projection is available as the
  `usabl/docs` library export (`projectDocs`, `collectDocArtifacts`).
- Fleet Insights measurement is runnable from a repository clone via
  `npm run measure:fleet-insights`, and ships as the `usabl/measure` library
  export (`runMeasurementOnly`). It reports how many screens surfaced draft
  findings and how many drafts in total, without minting a verdict, writing a
  receipt, or gating. It is deliberately not a `usabl` gate subcommand, so
  measurement can never masquerade as a proof.
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

- Receipts bind the engine and its scanner stack. `runnerVersion` embeds a
  sha256 over the on-disk engine files, and `verifyReceipt` now also compares
  `scannerVersions`, so tampering with or upgrading the engine or its scanners
  invalidates a prior receipt on re-verification, matching ground truth §10.
- Linked Stop hooks execute.
- Tests are ignored when mapping UI coverage.
- Menu state attributes are read for PatternFly checks.
- Package JSON output is preserved through the build.
- Requirement YAML intake is pinned to `--trusted-ref` so accessibility checks
  cannot self-grade against unapproved PR policy edits.
- Intake provider wiring now resolves the requirements root from trusted-ref
  `usabl.config.json`, which prevents PR-only path rewrites from dropping
  baseline requirement checks.
