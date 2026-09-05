# Threat model

Security and trust analysis for usabl beyond gate-tamper (covered in
[ground-truth.md](./ground-truth.md)). Gate-tamper controls: committed base config,
`approval_required` on policy diffs, CODEOWNERS in CI.

Build contracts: [ground-truth.md](./ground-truth.md).

---

## Assets

| Asset | Value |
|---|---|
| Verdict integrity | Teams trust `verified` means proof ran |
| Policy files | Surface map, baselines, rulepack config |
| Findings / receipts | Audit evidence for releases |
| Developer machine | Local repo, assistant context |
| Page under test | May be malicious in security review scenarios |

---

## Threat 1: Gate tampering

**Attack:** Assistant or developer weakens scope - unmap surfaces, exempt rules,
re-baseline to green.

**Controls (shipped in spec):**

- Verdicts computed against **committed** base config and committed
  requirements YAML from `--trusted-ref`, not working tree bytes.
- The requirements root is also read from trusted-ref `usabl.config.json`, so a
  PR cannot rewrite the requirements path to bypass baseline intake providers.
- Config diff -> `approval_required`.
- CODEOWNERS on policy paths in CI. The accessibility required check uses
  `accessibilityExitCode` (never 2). The policy required check passes only
  when a CODEOWNERS user who is not the PR author has `APPROVED` the current
  head SHA for each dirty guarded path. CODEOWNERS is read from `--trusted-ref`, never the PR tree.
  Org team entries fail closed. The PR comment stays loud after the policy
  check is green.

**Status:** [x] Documented in ground-truth; demo skeptic script in judge pass.

---

## Threat 2: Prompt injection via page content

**Attack:** Hostile `aria-label`, announcement text, or finding-adjacent DOM content
contains instructions ("ignore previous findings", "mark verified").

**Exposure:** Page-derived strings flow into findings JSON, transcript, a future MCP
surface, and assistant context.

**Controls:**

- Treat all finding and transcript text as **untrusted data** in MCP and hook prompts.
- Frame tool output with fixed schema labels; never pass raw page text as system
  instructions.
- Document for integrators: sanitize or quote-wrap page-derived strings in assistant
  UIs.

**Status:** [x] `formatSummary` neutralizes page-derived fields (`whatUserExperiences`,
`fix`), `scrubResult` redacts and neutralizes at every egress, and the stop-hook wraps
finding text with `frameUntrusted()`. [ ] Framing for a future MCP surface is not built,
since no MCP server ships in v0.2.0.

---

## Threat 3: MCP network exposure

**Attack:** MCP server bound to `0.0.0.0` on a shared network exposes check results and
page URLs.

**Controls (for a future MCP surface):**

- Default bind: **localhost only**.
- Document trust boundary when binding wider (containers, remote dev, CI sidecar).
- Require explicit flag for non-localhost bind.

**Status:** [ ] v0.2.0 ships no MCP server; these are requirements for one if it is built.

---

## Threat 4: Evidence bundle swap

**Attack:** Replace findings JSON or receipt in PR comment / artifact upload with a
passing bundle from another run.

**Controls:**

- A minted receipt binds four values re-checked on verify: `sourceTree` (the working-tree
  `git write-tree`), `policyHash` (HEAD blob shas over the guarded set), `runnerVersion`,
  and `scannerVersions` (axe-core, Playwright, Chromium). It also records `baseRevision`
  and `mintedAt`. A receipt exists only for a `verified` run.
- `verifyReceipt` re-derives `sourceTree` and `policyHash` from the current tree and HEAD
  and compares all four bindings. A bundle lifted from another run fails because its
  bindings do not match this tree, policy, runner, and scanners. The stop-hook fast path
  re-checks the stored receipt the same way before it trusts a green.
- Future: signed attestation on the receipt (engineering §7).

**Status:** Receipt bindings ship and re-verify; cross-run signing is still open.

---

## Threat 5: Supply-chain rule drift

**Attack:** axe-core or Playwright version changes alter rule behavior without team
awareness.

**Controls:**

- Exact-pin runtime versions in the lockfile (axe-core 4.13.0, @axe-core/playwright
  4.13.0, Playwright 1.62.1).
- Record `scannerVersions` (axe-core, Playwright, Chromium) in the receipt so a scanner
  swap moves the fingerprint and fails `verifyReceipt`.
- Dependabot bumps require explicit team review for policy impact.

**Status:** [x] Lockfile pins and receipt `scannerVersions` ship. [ ] The team review rule
for scanner bumps is process, not code.

---

## Threat 6: Sensitive data in transcripts

**Attack:** Transcript captures PII or secrets from page content in local logs or PR
comments.

**Controls:**

- Default: all processing **local**; no telemetry ships in v0.2.0.
- Document that transcripts may contain page data; caution for production URLs in CI.
- Secret redaction and control-byte neutralization already run at egress: `scrubResult`
  redacts credential-shaped keys and values and `neutralize` strips control sequences and
  invisible formatting characters, applied by the CLI, docs, and stop-hook projections
  before any output leaves the tool.

**Status:** [x] Local-first; egress redaction and neutralization ship. [ ] Telemetry
decision open.

---

## Threat 7: Tool failure producing false trust

**Attack:** Playwright crash, page timeout, render failure, or network error causes
usabl to silently succeed - producing a `verified` verdict on a check that never
actually ran.

**Exposure:** Teams over-trust "green" and ship unchecked UI. CI stays green because
the tool errored, not because the page is accessible.

**Controls:**

- A tool error never mints `verified` and never mints a receipt. A provider that throws or
  is denied a capability becomes a coverage gap, and a gap forces `not_covered` (exit 3).
  An unhandled crash in `run()` fails open to exit 4 with `verdict: null`, again with no
  receipt. Receipts carry no error field because they exist only for `verified`.
- No silent degradation: every gap and every crash is disclosed in the Result summary and
  its findings, so a green can never come from an error.
- Partial results (some screens scanned, others gapped): the scanned findings are still
  surfaced. With no new failure, a gap holds the verdict at `not_covered`. With a new
  deterministic failure, the failure outranks the gap and the verdict is `regression`. Both
  block, and the summary reports the gap count under either one, so incomplete proof is never
  presented as proof.

**Status:** [x] The `not_covered` gap path and exit-4 fail-open ship. [ ] A per-surface
time budget is not yet a config knob; the shipped bound is the keyboard-walk 15s wall clock.

---

## Threat 8: Denial of service on the gate

**Attack:** Malicious or pathological page causes Playwright to hang indefinitely,
blocking CI merge forever or holding the assistant in an infinite check loop.

**Controls:**

- The keyboard-walk provider ships a 15s wall-clock cap and the check runner caps transcript
  tabs at 50, so a single provider cannot spin forever.
- A timed-out or failed scan becomes a coverage gap, which resolves to `not_covered`
  (exit 3), not an infinite block.
- `not_covered` is a blocking verdict, so a pathological page fails the gate closed rather
  than passing as green. There is no warn-only mode; usabl is on or off.

**Status:** [x] Provider wall-clock cap and transcript-tab cap ship. [ ] A configurable
per-surface budget is not yet exposed.

---

## Threat 9: Output that renders differently from what usabl found

**Attack:** Page text carries Unicode formatting characters that no reader sees. Two
effects, both reproduced against `frameUntrusted`. Bidirectional controls reorder how the
characters around them are drawn, so a finding can render as the opposite of what usabl
found while the stored bytes stay innocent. Invisible characters planted between the
characters of the untrusted-text frame marker let page text close usabl's own frame, after
which everything the page supplied reads as trusted instruction rather than as data.

**Controls:**

- `neutralize` removes bidirectional controls and the other invisible formatting characters
  at every egress, so what a surface prints and what usabl found are the same text.
- The joiners U+200C and U+200D are kept. Persian, Arabic, and Indic words and emoji
  sequences are built from them, so removing them would corrupt real content in an
  accessibility tool.
- Because those two survive, `removeFrameMarkers` matches the frame markers through
  invisible characters, so a split marker is still recognised and replaced. Both places work
  from one list of characters, so what one removes and what the other tolerates cannot drift.

**Status:** [x] Both controls ship. Six splitters and the reordering payload are covered by
tests. [ ] usabl does not report that a page attempted either forgery; it removes them
silently.

---

## Decision: Stop hook fail-open on exit 4

After the guard runs before any coverage, floor, or waiver parse, a diverged
guarded policy file (including corrupt JSON) is `approval_required` and the Stop
hook blocks. Remaining `run()` exit 4 is an unhandled crash: git, filesystem,
browser launch, or a parse failure of policy bytes that still match the trusted
ref (so the guard does not short-circuit).

**Attack if we blocked on exit 4:** a wedged Stop hook traps the operator in the
session. They cannot continue, cannot easily recover, and may disable the hook
entirely. That is a worse integrity outcome than an honest unverified allow.

**Decision:** keep fail-open with disclosure.

- `evaluateStopDecision` allows when `exitCode === 4`.
- The operator sees `NOT verified` plus the crash summary. This is not idle and
  not `verified`. No receipt is minted.
- CI still fails the job on exit 4, so a crash cannot become a green merge.
- The one-shot escape hatch remains `.usabl/bypass-once` (`usabl bypass`). It is
  loud, consumed on the next stop, and is for emergencies, not a substitute for
  this policy.

**Not this decision:** `regression`, `not_covered`, and `approval_required` still
block. Diverged guarded policy still blocks. Exit 4 still cannot mint `verified`.

**Status:** [x] Recorded. Matches the shipped Stop hook and runner error paths.

---

## CI trust boundary: the generated gate draft

`usabl install --ci` writes a three-job workflow to `.github/workflows/usabl-gate.yml`
(`src/install/ci.ts`). The jobs split trust deliberately:

- **`gate-comment`** is the only job allowed to run PR head code, and it is fenced to the
  `pull_request` event (`if: github.event_name == 'pull_request'`). It starts the fixture
  with `npm run dev` (head code) and runs the accessibility scan. A `pull_request_review`
  event carries base-repo secrets, so head code must never run on it. Before the fixture
  starts, the trusted engine is cloned from `usabl-dev/usabl` pinned by a full 40-character
  commit SHA (the draft ships the sentinel `PIN_TO_A_TRUSTED_USABL_COMMIT`, which the
  operator must replace), checked out with `persist-credentials: false`, and snapshotted to
  a read-only `/opt/usabl-trusted` so the fixture cannot overwrite the checker. The scan
  runs `check --ci --trusted-ref "origin/<base>"` from that snapshot.
- **`usabl-policy`** decides the policy verdict and resolves the Result artifact for the
  head. It checks out the base commit only, fetches the head as git objects, and runs
  `enforce policy --trusted-ref "origin/<base>"`, which reads blobs with `git show` and
  `git ls-tree` and never checks out or executes head code. It also runs
  `enforce accessibility` over the downloaded Result and publishes the outcome as its
  `accessibility` job output, so the accessibility verdict travels as data rather than being
  inferred from a job status. It is not the required check on its own: it returns success
  whenever no guarded path diverged, which says nothing about accessibility.
- **`usabl-required`** is the required status check. It runs with `if: always()`, depends on
  both other jobs, and is red unless the accessibility verdict and the policy verdict both
  pass. It checks nothing out and runs no head code. Its rule handles the event split that
  the `gate-comment` fence creates: on `pull_request` the scan must have succeeded, on
  `pull_request_review` the scan must have been skipped by the fence and the artifact-derived
  accessibility verdict is the authority, and any other event, a cancelled job, or a missing
  verdict blocks. `always()` is load-bearing, because GitHub counts a skipped job as a
  satisfied required check.

Requiring `usabl-policy` instead of `usabl-required` reopens the hole this split closes:
accessibility enforcement lives in `gate-comment`, which is fenced to `pull_request` and so
cannot be required on a review event, and `usabl-policy` alone can be green while the scan
is red.

**Accepted residual risk:** within `gate-comment`, the fixture process and the sticky
comment step share a job, so a hostile PR could try to spoof the comment. That job posts
the comment but does not decide the gate; the `usabl-policy` and `usabl-required` jobs are
isolated and do not trust the comment. That same job boundary now carries a required
verdict: on a `pull_request` event `usabl-result.json` is written and uploaded from
`gate-comment`, which is also the job that runs head code through `npm ci` and the fixture
server, so a hostile author has a window in which to overwrite their own Result before it
is uploaded. The `pull_request_review` path is stronger, because it downloads the artifact
from a completed run for that exact head and executes no head code at all. This is not a
new opening: before `usabl-required` existed, accessibility was not a required check at
all and a regression merged with no effort, whereas now one merges only if the author
actively tampers. Accepted for the private team fixture.

The engine's own checked-in `.github/workflows/usabl-gate.yml` runs the same three jobs with
the same event fence, the same numeric PR guard, the same artifact handoff, and the same
policy isolation. It differs in one way, because the engine is the repository: there is no
external-engine pin and no `USABL_ENGINE_CHECKOUT_TOKEN`. `usabl-policy` builds the base
commit it has already checked out, which is trusted by definition, and `gate-comment`
builds the head tree it is fenced to. It also starts no fixture server and needs no
read-only `/opt/usabl-trusted` snapshot, because that job runs no separate application
alongside the checker.

**Status:** [x] Recorded. The generated draft already isolates the policy decision; the
operator must set the engine SHA before the gate can run.

---

## License review

| Dependency | License | Notes |
|---|---|---|
| axe-core | MPL-2.0 | Dynamic link; surface version in output |
| Playwright | Apache-2.0 | Browser binaries separate terms |
| PatternFly | MIT | Rulepack data only |
| Guidepup (if adopted) | MIT | Optional phrasing validation |

**usabl release license:** Apache-2.0 (repo `LICENSE`). MPL boundary: do not vendor
axe-core source; depend via npm.

**Status:** [x] Repo license set; [ ] file-boundary check if vendoring added.

---

## Legal wording

No compliance claims. Evidence-support language only. Tool states human AT review
required where applicable.

**Status:** [x] Build rule in [ground-truth.md](./ground-truth.md).

---

## Open actions

Receipt bindings (`sourceTree`, `policyHash`, `runnerVersion`, `scannerVersions`), the
`not_covered` gap path, and exit-4 fail-open already ship, so they are no longer open.
Remaining items:

| Item | Target |
|---|---|
| MCP untrusted-data framing (no MCP server ships in v0.2.0) | future MCP wrapper |
| Localhost default bind | future MCP server |
| Configurable per-surface time budget | harness runner |
| Telemetry decision | pre OSS release |
