# UX policy: findings and first-run

Status: working draft. Author: eparenti. August 2026.

Design policies for finding fatigue, noise budget, and first-run experience. Implements
checklist section 5 items that are spec-ready before code ships.

---

## Surfaced-text principle (shipped in harness v0)

Every finding includes:

1. **What the user experiences** - announcement excerpt or interaction outcome.
2. **Why it matters** - one plain sentence tied to WCAG or PF rule.
3. **The fix** - PF-idiomatic guidance, not generic "add aria-label."

---

## Dedupe policy

**Rule:** One finding per rule id per surface run, with `nodeCount` for additional
instances.

**Rationale:** Reviewers see "3 icon-only buttons" as one actionable item, not three
identical cards.

**Exception:** Different rules on the same node surface as separate findings (e.g.
`button-name` and keyboard unreachable).

**Status:** Implemented in harness v0.

---

## Severity ordering

Display and block order:

1. **Blockers** - violations that fail gate (`regression` layer findings at error severity).
2. **Serious** - WCAG AA failures not yet blocking (advise mode).
3. **Moderate / minor** - visible in full report; collapsed in overlay by default.
4. **Needs human AT review** - escalations to Alex; never silent.

Within a tier: sort by rule id for stable diffs across runs.

---

## Noise budget per surface

**Target:** At most **5 distinct findings** shown in overlay and stop-hook summary per
run on a typical touched surface. Full list available via CLI `--verbose` and PR
comment expand.

**Calibration:** Initial target; calibrate on OpenShift observe pass in build week. If
real surfaces routinely produce >5 findings, raise the threshold or tighten collapse
rules - do not ship a budget that fires on every run.

**If over budget:** Collapse by rule with counts; show top 5 by severity; link to full
JSON.

**Measurement:** Demo app clean pass = 0 findings. Demo broken = exactly 3 (one per
layer). OpenShift observe: track findings per surface for calibration.

**Rip-out tie-in:** Exceeding budget without collapse is a top disable trigger (see
[journeys.md](./journeys.md)).

---

## First-run experience

**Goal:** One command to first finding in **under five minutes**, no custom config.

**Path (target):**

1. Clone repo with demo app or `npx usabl init` scaffold.
2. `npm install` (or documented package manager).
3. `npm run dev` + `npx usabl check <url>` **or** single `npx usabl demo` that starts
   server and runs check.

**Success metric:** [success-metrics.md](./success-metrics.md) §1.

**Stranger test:** Required before submission; record time and blockers in scorecard.

**Status:** Open - depends on quickstart README (engineering §7).

---

## Overlay and HUD (partial)

- Live HUD v1 committed; design pass and caption phrasing open.
- Caption rule: label as **accessibility preview**, not "screen reader output."
- Phrasing spike: table vs Guidepup vs Orca notes - decision open; refuse per-reader
  phrasing product either way.

---

## Self-check: dogfooding surfaces

Before submission, run harness on:

- [ ] HUD / overlay page
- [ ] Fleet evidence view
- [ ] PR comment HTML template
- [ ] Deck (done - caught real finding)

Same bar as production demo surfaces.

---

## Accessibility of Usabl surfaces

Every shipped surface (HUD, fleet, PR comment, docs output) must meet:

- Reduced motion: respect `prefers-reduced-motion`
- Contrast: PatternFly tokens, no hard-coded low-contrast grays
- Keyboard: all actions reachable without pointer

**Status:** Open - track per surface in build week.

---

## Error and failure UX

When Usabl itself breaks (Playwright crash, page timeout, render failure, network
error), the developer must see a clear, honest outcome - never a false `verified` or a
silent pass.

**Rules:**

1. **Tool failure -> `not_covered`**, never `verified`. The receipt explicitly states
   `reason: "tool_error"` with the error class.
2. **Message to the developer:** "Usabl could not complete the check: [reason]. The
   change is not verified. Run again or check manually."
3. **CI timeout budget:** Maximum 120s per surface check. If exceeded, verdict is
   `not_covered` with `reason: "timeout"`. CI reports the timeout but does not block
   merge forever - teams configure timeout-as-block or timeout-as-warn.
4. **Overlay failure:** If the harness cannot connect to the dev server, overlay shows
   a single-line banner: "Cannot reach [url] - check not running." No phantom findings.
5. **Partial results:** If 2 of 3 layers complete before a crash, the partial findings
   are still surfaced but verdict is `not_covered` (incomplete proof).

**Rip-out tie-in:** Silent failures that look like "everything passed" are worse than
noisy failures. Teams disable tools that lie about success.

---

## Adoption ladder: observe -> advise -> gate

Teams adopt at their own pace. Each step has a trigger, an owner, and a rollback.

| Step | What's active | Who decides | Trigger to advance | Rollback |
|---|---|---|---|---|
| **Observe** | CI runs, comments only, no block | Morgan enables | Install complete; first run green or manageable | Remove CI step |
| **Advise** | Overlay + assistant self-check; no enforcement | Morgan + Priya opt in | 1–2 sprints of observe with low noise, false positive rate < 10% | Disable overlay; remove hook |
| **Gate** | Stop hook enforces; CI required check on default branch | Morgan + Alex agree; Riley informed | Advise period stable; waiver ledger handles existing debt; team confidence | Downgrade to advise; keep ratchet running |

**Criteria for each transition:**

- **Observe -> Advise:** Team has seen findings, trusts accuracy, wants real-time signal.
  False positive rate measured and acceptable.
- **Advise -> Gate:** Existing debt is in the waiver ledger or baseline. No surprise
  blocks on legacy surfaces. Alex has reviewed escalation volume and confirms it is
  manageable.
- **Gate -> Steady state:** Ratchet burns down debt over time via waiver expiry. Fleet
  tile shows trend. Policy changes still require `approval_required`.

**Who flips each switch:** Config change in repo (observe/advise/gate mode in
`.usabl/config.yml`). Config changes trigger `approval_required` - the tool's own
guard prevents silent mode changes.

**Status:** Policy defined; implementation in guard kernel phase.
