# Changelog

## Unreleased

### Fixed

- The gate no longer reports green when several new barriers hide behind one
  accepted floor entry. Barriers on different nodes can neutralize to the same
  name or structural identity and collapse into a single finding. The floor
  recorded a placeholder count of 1 for those entries and the gate compared
  counts only for identity-weak rules, so adding barriers at an accepted
  identity passed silently. The floor now records the observed count for every
  entry and the gate compares it for every basis. More barriers than the floor
  accepted is `new`; equal or fewer stays `carried`.
- The evidence floor is now version 2. A version 1 floor cannot prove that no
  barrier is hiding behind an accepted identity, so a run that reads one reports
  a coverage gap and `not_covered` rather than an unprovable green. Run
  `usabl baseline` to regenerate the floor at version 2. Version 1 files still
  parse, and they still gate on new identities and identity-weak counts.
- usabl can scan a login-gated application. The browser adapter already accepted a
  Playwright storage state, but no operator entry point supplied one, so a run
  against an application behind a login scanned signed out and could mint a verdict
  from the pages a signed-out visitor sees. `USABL_STORAGE_STATE` now names a
  storage state file, and the composition root every surface funnels through reads
  it, so the CLI, the Vite overlay, and the Claude Stop hook all reach the same
  signed-in screens. A path passed directly in code still wins over the variable.
  An empty value means no session. A path usabl cannot read, or one that is not
  JSON, stops the run rather than producing another signed-out scan. Neither the
  path nor the file contents are ever printed, because the file holds live session
  tokens.
- Page-derived text can no longer make usabl's own output read differently from
  what usabl found. Unicode bidirectional controls tell a terminal, a pull
  request comment, or the overlay to draw characters in a different order than
  they are stored, so a crafted label could render as the opposite of the finding
  behind it. The egress neutralizer now removes all twelve of them, and the
  DELETE control byte it used to miss. Ordinary right-to-left text is unaffected,
  because Hebrew and Arabic letters carry their own direction and need no control
  character. Mixed-direction text is a real trade: Unicode recommends the isolates
  for keeping a number or an embedded Latin phrase in the right place inside a
  right-to-left sentence, so page text that used them correctly can come out
  looking wrong in usabl's surfaces. A verdict that renders as its own opposite is
  the worse failure, so the controls go.
- Invisible characters that carry meaning are preserved rather than removed.
  usabl reports the text that is really on the page, so deleting a character
  because a reader cannot see it would misrepresent the evidence. Tag characters
  spell the region in a flag emoji, variation selectors choose how a glyph is
  drawn, invisible operators are real notation in mathematics, and joiners build
  words in Persian, Arabic, and Indic scripts.
- Page text can no longer close usabl's own untrusted-text frame. That frame tells
  an agent-facing reader that everything inside it is data and never instructions.
  A marker with an invisible character planted between two of its characters still
  reads as a marker, because the planted character draws nothing, but it did not
  match the literal, so it survived into the framed body and everything after it
  read as trusted. The marker search now looks through invisible characters, so a
  split marker is recognised and replaced like any other. The characters it looks
  through come from Unicode properties rather than a hand-written list, so the
  defense does not fall behind as Unicode grows. Ordinary text is untouched,
  because looking through applies only inside a run that turns out to be a marker.
- Credentials are no longer printed when an invisible character splits the key
  name. Redaction matches literal text, so `token=` with a zero width space, a
  joiner, a soft hyphen, or a variation selector inside it matched no credential
  pattern while still reading as a token to anyone looking at it. Credential
  anchors are now read from the text with the invisible characters taken out, and
  the span that gets replaced is the real span in the original, so surrounding
  text keeps every character it arrived with. Redaction also runs on both sides of
  control stripping, because stripping joins text and the bare-JWT pattern needs a
  word boundary that stripping can remove.
- A line break or a tab inside an accessible name is no longer deleted. Deleting
  it welded the words on either side into one, so a label that wraps onto a second
  line was reported as "Savebutton" rather than "Save button", which is not the
  name the page has. Each run of separator controls becomes a single space.
- Page text in a pull request comment is escaped for the renderer. Markdown is not
  a plain-text container: an HTML comment disappears when rendered, a character
  reference becomes a different character, an emphasis pair wrapped around part of
  a word disappears and leaves the word, and a backslash disappears before
  punctuation. Any of those puts characters on screen that are not in the string,
  which was enough to draw usabl's own untrusted-text frame marker out of page
  text that is not the marker. Every character a renderer could read as inline
  markup is now written as a character reference, which renders as the character
  it names. The first character of a block marker at the start of a page text
  line, the colon of `://`, and the dot of `www.` are written the same way, so
  page text cannot render as a heading, list item, thematic break, setext
  underline, HTML block, code block, or scheme or `www.` link. GitHub still
  applies its own post-render autolinks to email addresses, `mailto:` and
  `xmpp:` forms, `@user` mentions, `#123` issue references, and commit SHAs,
  because those run on decoded text after character references resolve, so page
  text can still produce a clickable mailto, a notification to a user with
  repository access, or a link to a repository object. None of these can forge a
  verdict, close the untrusted-text frame, or leak engine data.
- Long page text costs far less memory. Both the neutralizer and the frame marker
  search copy text in runs and return the original string when they have nothing
  to change, instead of rebuilding it one character at a time. On a four million
  character accessible name containing one emoji joiner, peak heap growth drops
  from about 362 MiB to about 11 MiB. Text with removals scattered all the way
  through it still builds its result in pieces and costs several times its own
  size.

### Added

- `usabl doctor` reports the authenticated session as a surface of its own. Unset
  reads as missing and names the consequence: usabl will scan signed out, so a
  login-gated screen is measured as whatever a signed-out visitor sees. Set but
  absent or unparseable reads as drifted, never wired. Doctor says whether a
  session is configured, never what it is.

### Changed

- `usabl check` opens with a verdict line: a symbol, the verdict word, and the exit
  code, followed by one sentence saying what the verdict means for the change. The
  gate's own summary, the barriers, the gaps, and the receipt follow under labels.
  Idle and a failed run both print `NO VERDICT`, then `IDLE` or `RUN FAILED`, so
  neither can be read as a pass. Every meaning is carried in text; no state
  depends on colour.
- The Stop hook message and the `/usabl-check` self-check open the same way: the
  verdict word and exit code, what it means for the change, the gate summary,
  then the next step. A block now tells the assistant what to do before it lists
  barriers. A failed run reads `NO VERDICT: RUN FAILED (exit 4)` on both
  surfaces; the self-check used to label it `IDLE`.
- Every free-text field a surface prints is bounded in length: a finding's
  experience and fix, a gap's ref and reason, a rule or screen name, a source
  location, and the gate summary. The surfaces already bounded how many entries
  they print, but one provider error the size of a stack trace could still fill
  an assistant's context on its own. A shortened field ends with
  `[shortened, N characters omitted]` so the cut is visible, and a page-supplied
  copy of that note is rewritten so only the engine can emit the real one.
  Verdict words, exit codes, and counts are never shortened. The whole Stop hook
  and self-check message is then held to 13,000 characters: whole lines are
  dropped from the end, never the verdict line, the summary, or the next step,
  and never inside the untrusted frame, with a closing note saying how many
  lines went. At the default noise budget nothing is dropped.
- The self-check prints a finding's source location inside the untrusted frame.
  A renderer-tier source mapping reads its file and line from attributes on the
  page, so the page can choose that text, and it was printed as trusted scaffold.

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
