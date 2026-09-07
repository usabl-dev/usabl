# User journeys

Formal journey maps for each daily moment: stages, emotions, friction points, and
rip-out prevention.

Personas are defined in [personas.md](./personas.md). The command arc a person types to
reach these steady states is in [adoption-model.md](./adoption-model.md).

Every command shown here is real in the current engine (v0.2.1). Only `usabl check`
mints a verdict; it emits `verified`, `regression`, `not_covered`, or
`approval_required`, or `null` for idle or crash. The stop hook and the overlay are
projections of that verdict and never mint their own.

---

## Journey 1: Priya, assistant loop

**Persona:** Priya (UI engineer with an AI assistant).
**usabl installed:** Yes. `usabl init` for policy, then `usabl install --claude` (Stop
hook), `usabl install --claude-skill` (the on-demand `/usabl-check` skill), `usabl install
--ci` (PR gate), and `usabl install --overlay` (dev-server badge).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Prompt | Asks for a toolbar, table, and row actions | Productive, fast | Assistant edits an unmapped file, so the surface reports `not_covered` instead of proof |
| 2. Build | Assistant edits files; `usabl check --self-check` runs mid-task as an advisory pass | Flow | Check latency breaks flow if it runs long |
| 3. Stop | On the Stop event the hook runs `npx usabl stop-hook`; a blocking verdict (regression, approval_required, or not_covered) makes it emit a block decision | Surprise, then curiosity | "Why blocked?" if the message is unclear |
| 4. Findings | Findings print one line each, with a what, why, and fix | Clarity | Finding fatigue if noisy |
| 5. Fix and re-verify | Assistant fixes; the hook runs `check` again | Relief | A false positive costs trust |
| 6. Done allowed | `verified` verdict; a receipt is minted and stored so the next stop can re-check fast without a browser | Confidence | None |

**Friction audit:**

- **Latency:** Target a fast loop on save and a complete loop before done. State the
  numbers in the README once they are measured, not before.
- **Finding fatigue:** Dedupe, order by severity, and hold to a noise budget
  ([ux-policy.md](./ux-policy.md)).
- **Gate trust:** The receipt binds the working tree, committed policy, runner version,
  and scanner versions, so a green result is re-checkable rather than asserted.

**Rip-out moment:** The assistant hook is disabled after one false block.
**Prevention:** Accurate findings on the demo set; `not_covered` only with a reason; the
evidence floor keeps carried debt from blocking so only new violations gate. The
`stop-hook` command always exits 0 and blocks through a stdout decision, so a wedged
hook can never freeze the assistant through an exit code.

---

## Journey 2: Manual coder, dev-server overlay

**Persona:** Engineer coding by hand, no assistant.
**usabl installed:** Yes. `usabl install --overlay` wired the advisory Vite plugin.

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Save | Hot reload; the overlay projects the gate Result for the mapped surface | Habitual | An unmapped surface gives no feedback |
| 2. Overlay finding | A finding appears beside the build errors | Mild annoyance | Overlay clutter |
| 3. Fix | Edits code from the fix text on the finding | Engaged | Vague fix text |
| 4. Clear | The overlay clears when the surface reaches `verified` | Satisfaction | Flapping on partial saves |

The overlay is advisory. Its display exit code is always 0, and it never changes what
the gate decides.

**Rip-out moment:** The overlay is dismissed and never reopened.
**Prevention:** Single-flight runs; deduped findings; per-finding dismiss rather than a
global kill switch; the same severity order as the CLI.

---

## Journey 3: Reviewer, PR evidence

**Persona:** Peer reviewer or Morgan (lead).
**usabl installed:** Yes. `usabl install --ci` wrote the gate workflow, and branch
protection requires the `usabl-required` check (verified with `usabl install --branch-rule`).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Open PR | Visual diff as usual | Routine | None |
| 2. Evidence comment | The `gate-comment` job posts a sticky comment with the findings and the gated verdict | Insight | Comment noise on large PRs |
| 3. Read the verdict | The comment shows verified, regression, not_covered, or approval_required, with the findings behind it | Understanding | Reading a raw finding without context |
| 4. Approve | Merge when the `usabl-required` check is green | Confidence | A block with no waiver path |

The comment is a projection of the same gated Result; it invents no verdict. Policy
enforcement runs in the second job (`usabl-policy`) against the base commit, so head
code never decides its own gate. The third job, `usabl-required`, is the one branch
protection waits on: it is red unless the accessibility verdict and the policy verdict
both pass. Changing a guarded policy file yields `approval_required` until it is
reviewed.

**Rip-out moment:** The team ignores the bot comment.
**Prevention:** High-signal comments (regressions and the screens the change mapped to); a link to the
receipt; the gate blocks a merge only once the team makes `usabl-required` a required
check.

---

## Journey 4: Team onboarding, brownfield adoption

**Persona:** Morgan (engineering lead).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Install | `usabl init` scaffolds policy, then `--overlay`, `--claude`, `--ci`, and `--branch-rule` wire one surface each. `usabl doctor` confirms what is wired. | Curious | "Another bot" |
| 2. First run | `usabl check` reveals existing barriers; `usabl baseline` drafts the evidence floor to accept known debt as a reviewable diff | Cautious | The legacy debt pile is visible for the first time |
| 3. Waivers | Known issues get entries in `.usabl-waivers.json`, each with an `expires` date; new violations gate | Cautious optimism | Waiver ceremony feels heavy |
| 4. Steady state | `usabl floor prune` re-arms the floor as barriers are fixed; waiver expiry burns down the rest; `usabl drift routes` catches route drift | Trust | Suspicion that policy was tampered with |

**Who wires each surface:** Morgan and Alex (SME) agree; Riley is informed for release
evidence.

**Needs to feel safe:** Debt lives in the evidence floor and the waiver ledger; only new
violations gate; CODEOWNERS covers the guarded policy files, and editing them so they
diverge from the trusted ref forces `approval_required`.

**Rip-out moment:** The tool is turned off after one bad Monday.
**Prevention:** The evidence floor gates new only; waivers carry expiry; `usabl doctor`
and `usabl floor prune` show progress rather than shame.

---

## Journey 5: James, outcome loop

**Persona:** James (a screen reader user on the team or a customer).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Barrier | Hits a broken flow in the build or in dogfooding | Frustration | None |
| 2. Report | Files an issue with a repro | Hopeful | No repro attached |
| 3. Fix verified | The team runs the loop; the deterministic providers (axe, the PatternFly rulepack, the keyboard walk) confirm the fix, and a `verified` receipt backs it | Relief | "Fixed" with no proof |
| 4. Shipped | Same release or the next | Validated | A regression in a following release |

**Rip-out moment:** James stops reporting and works around barriers in private.
**Prevention:** A `verified` verdict on the fix, backed by a re-checkable receipt.
Deterministic evidence is what gates; human assistive-technology review by Alex (SME) is
still required, and usabl states that plainly rather than claiming to speak for James. A
spoken-output preview module exists in the codebase but is dormant: it is not in the run
or gate path and does not affect any verdict.

**Demo:** A real NVDA cold open and bookend. Any spoken-output preview shown in the loop
is labeled as a dev-time aid, not as evidence and not as James's approval.

---

## Rip-out audit summary

| Journey | Disable trigger | Prevention |
|---|---|---|
| Assistant loop | False block, slow check | Accurate demo set; latency budget; re-checkable receipt |
| Overlay | Clutter, flapping | Dedupe; single-flight; severity cap |
| PR reviewer | Bot fatigue | Comment only on mapped screens and regressions |
| Onboarding | Debt wall | Evidence floor; new-only gating; waivers with expiry |
| James | Empty "fixed" | Verified verdict plus a receipt; human AT review still required |

---

## Journey map status

| Journey | Documented | Filmed / tested |
|---|---|---|
| Priya assistant loop | Yes | Open (THE MOMENT) |
| Manual overlay | Yes | Open |
| PR reviewer | Yes | Partial (static PR comment in the harness) |
| Team onboarding | Yes | Open |
| James outcome | Yes | Open (NVDA session) |
