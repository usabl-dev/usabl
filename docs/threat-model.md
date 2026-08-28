# Threat model

Security and trust analysis for usabl beyond gate-tamper (covered in ground-truth and
entry-spec). Gate-tamper controls: committed base config, `approval_required` on policy
diffs, CODEOWNERS in CI.

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

**Exposure:** Page-derived strings flow into findings JSON, transcript, MCP tool
responses, and assistant context.

**Controls:**

- Treat all finding and transcript text as **untrusted data** in MCP and hook prompts.
- Frame tool output with fixed schema labels; never pass raw page text as system
  instructions.
- Document for integrators: sanitize or quote-wrap page-derived strings in assistant
  UIs.

**Status:** [ ] Frame MCP and hook prompts as untrusted. [x] `formatSummary` runs page-derived fields (`whatUserExperiences`, `fix`) through `neutralize()` before a live `CheckRunner` can fill them. The CLI is already an egress.

---

## Threat 3: MCP network exposure

**Attack:** MCP server bound to `0.0.0.0` on a shared network exposes check results and
page URLs.

**Controls:**

- Default bind: **localhost only**.
- Document trust boundary when binding wider (containers, remote dev, CI sidecar).
- Require explicit flag for non-localhost bind.

**Status:** [ ] Enforce in MCP server implementation; document in README.

---

## Threat 4: Evidence bundle swap

**Attack:** Replace findings JSON or receipt in PR comment / artifact upload with a
passing bundle from another run.

**Controls:**

- Provenance fields on every bundle: `url`, `commitSha`, `timestamp`, `runnerVersion`,
  `policyHash`.
- CI compares receipt commit to PR head; hook compares to session tree.
- Future: signed attestation on receipt (engineering §7).

**Status:** Partial - schema in ground-truth; signing open.

---

## Threat 5: Supply-chain rule drift

**Attack:** axe-core or Playwright version changes alter rule behavior without team
awareness.

**Controls:**

- Exact-pin versions in lockfile.
- Surface `axe-core` and `@axe-core/playwright` versions in findings JSON metadata.
- Renovate bumps require explicit team review for policy impact.

**Status:** [ ] Implement version fields in findings output.

---

## Threat 6: Sensitive data in transcripts

**Attack:** Transcript captures PII or secrets from page content in local logs or PR
comments.

**Controls:**

- Default: all processing **local**; no telemetry without explicit opt-in decision.
- Document that transcripts may contain page data; caution for production URLs in CI.
- Optional redaction hook for known secret patterns (future).

**Status:** [x] Local-first architecture; telemetry decision open.

---

## Threat 7: Tool failure producing false trust

**Attack:** Playwright crash, page timeout, render failure, or network error causes
usabl to silently succeed - producing a `verified` verdict on a check that never
actually ran.

**Exposure:** Teams over-trust "green" and ship unchecked UI. CI stays green because
the tool errored, not because the page is accessible.

**Controls:**

- Tool errors always produce `not_covered`, never `verified`. Receipt includes
  `reason: "tool_error"` or `reason: "timeout"`.
- CI timeout budget (120s per surface). Exceeded -> `not_covered` with explicit message.
- No silent degradation: every error is surfaced in the verdict summary.
- Partial results (some layers completed): findings surfaced, but verdict remains
  `not_covered` (incomplete proof is not proof).

**Status:** [ ] Implement in harness error paths; document in ux-policy error UX.

---

## Threat 8: Denial of service on the gate

**Attack:** Malicious or pathological page causes Playwright to hang indefinitely,
blocking CI merge forever or holding the assistant in an infinite check loop.

**Controls:**

- Hard timeout per surface check (120s default, configurable).
- On timeout: `not_covered` verdict, not infinite block.
- CI mode: teams configure timeout behavior (block or warn). Default: warn + comment.
- Assistant hook: timeout after configured budget; surface `not_covered` with
  suggestion to debug locally.

**Status:** [ ] Implement timeout in harness runner; expose in config.

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

## Accepted risk: app CI same-job fixture and checker

`usabl-app` CI starts the pull request's `npm run dev` in the same job that runs
the trusted checker. The checker binary is copied to `/opt/usabl-trusted` and
made immutable, and the verdict is the captured process exit code matched to
`Result.exitCode`. That holds the gate answer.

It does not isolate the fixture process from the comment step. A hostile PR can
still try to spoof the sticky comment or race a git ref between checkout and
`--trusted-ref`. Accepted for the private team fixture. If the repository ever
widens, split the trusted check into a job the pull request cannot start, and
keep comment posting on that job's output only.

**Status:** [x] Recorded. Not a contest blocker. Named fix is job separation.

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

**Status:** [x] Build rule in entry-spec and ground-truth.

---

## Open actions

| Item | Target |
|---|---|
| MCP untrusted-data framing | MCP wrapper slice |
| Localhost default bind | MCP server |
| Findings provenance fields | Receipt v1 |
| axe/playwright version in JSON | Harness output |
| Tool-error -> not_covered path | Harness runner |
| Timeout budget (120s default) | Harness runner |
| Telemetry decision | Pre OSS release |
