# Changelog

## 0.2.1 - 2026-09-01

Version files name 0.2.1. This freeze does not create a git tag or publish to
npm.

This release adds accessibility checking for rendered documentation. A
`usabl.docs.json` manifest activates a docs surface that runs through the same
engine as the app, so one run mints one verdict spanning both.

### Added

- Docs accessibility surface. When a `usabl.docs.json` manifest is present, the
  engine scans the rendered documentation pages it names alongside the app and
  mints a single verdict over both. The manifest is a guarded policy file read
  from the trusted ref, so a pull request cannot diverge it and self-accept.
- Docs findings speak the author's source. Each docs finding carries the source
  file, the AsciiDoc construct that produced the barrier, and a syntax-aware fix,
  so an author corrects the markup rather than the generated HTML. When ownership
  is ambiguous the finding discloses every candidate source instead of guessing.
- Docs coverage narrows to the pages a change touches and reports related pages
  that were not scanned as `not_covered` gaps, rather than silently skipping
  them.
- A docs heading-order rulepack, gated to the docs profile, checks heading nesting
  on documentation pages. Provider profiles are threaded per surface so app and
  docs rules do not bleed into each other.
- `usabl baseline` now captures docs debt as well as app debt. It enumerates every
  docs page source from the manifest and floors each page barrier in the same
  commit, so a baseline is complete across both surfaces.
- `usabl init --docs` drafts a `usabl.docs.json` for a detected documentation
  format (a Pantheon `titles/*/master.adoc` modular guide, or an OpenShift
  AsciiBinder `_topic_maps/_topic_map.yml`). It carries loud review notes for
  anything guessed rather than measured, follows the real include closure for
  each page's sources, and refuses to overwrite a reviewed sidecar without
  `--force`. A format it does not support is a clean no-op, not an error.
- `usabl install --docs-ci` writes the docs gate workflow at
  `.github/workflows/usabl-docs-gate.yml`. It reproduces every fork-safety
  property of the app gate (the two-job model, the pull_request fence on head-code
  execution, pinned action SHAs, and the review-time policy job that reads head as
  git objects only). Because usabl does not serve the built docs itself, the gate
  builds the docs with an operator-supplied command and serves the rendered HTML
  on localhost for the scan. The build command, built-HTML directory, and serve
  port are repository variables, so the workflow file stays byte-stable and the
  engine ref remains the only value `usabl doctor` must reason about.
- `usabl docs --html` renders the docs artifacts as one self-contained,
  accessible HTML page instead of JSON. The page carries the same honesty rule
  as the engine and separates three states in words, never by color alone: an
  artifact reads as verified only when it is bound to a minted receipt and its
  entries carry per-entry evidence; an artifact that is bound but whose entries
  carry no evidence is labelled an expectation, not proof; and an unbound
  artifact is labelled an observation, not proof. The renderer is pure and
  deterministic, escapes all page-derived text, uses the same strict
  content-security policy as the other project pages, and mints no verdict.
  Without the flag, `usabl docs` still emits JSON on stdout.

### Security

- Docs manifest page urls reject path traversal, including percent-encoded
  forms, and enforce base-path containment so a page url cannot escape the docs
  origin.
- The working-tree `usabl.docs.json` is overlaid from the trusted ref when it
  diverges, matching the app policy overlay, so a diverged manifest cannot widen
  or narrow what the gate scans.

## 0.2.0 - 2026-08-30

Release candidate. Version files name 0.2.0. This freeze does not create a git
tag or publish to npm.

Carried from 0.1.0 (already present, listed here for complete command coverage,
not new in 0.2.0): `usabl check` is the core gate command, `usabl comment`
projects a run read from stdin into a pull request comment for CI, and
`usabl bypass` is a one-time, next-stop-only escape hatch that does not verify.
It sets a marker so the next Stop hook skips verification once.

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
