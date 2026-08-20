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

- Verdicts computed against **committed** base config, not working tree.
- Config diff -> `approval_required`.
- CODEOWNERS on policy paths in CI.

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

**Status:** [ ] Implement framing in MCP wrapper when shipped; document in integrator
guide.

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
