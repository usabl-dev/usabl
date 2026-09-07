# UX policy: findings and first-run

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

**Rule:** One finding per identity, where identity is `screen + rule + element key`. The
element key comes from the accessible name or a structural path. Two layers that fire on
the same identity collapse into one finding, and the PatternFly rulepack why and fix win
over axe on the merge.

**Count-based rules:** Rules with no per-element key (identity basis `count`) collapse to
one group per screen and rule. The group carries a count, and a count higher than the
evidence floor gates as a new regression. There is no `nodeCount` field on a finding; the
count lives in the gate's grouping, not on the surfaced record.

**Rationale:** Reviewers see "icon-only buttons on this screen" as one actionable group,
not one card per node.

**Exception:** Different rules on the same node stay separate findings (for example
`button-name` and a keyboard-unreachable walk finding).

**Status:** Identity-based collapsing is implemented in the gate (`buildFindings`).

---

## Severity ordering

Severity is display metadata, not the gate input. The four severities are `critical`,
`serious`, `moderate`, and `minor`. What actually gates is separate: a deterministic
finding with `confidence: 'fail'` at `new` status is a regression, and any coverage gap or
unverified finding is `not_covered`. Severity orders the list; it does not decide the
verdict.

Display order:

1. **Blocking findings** - deterministic fails at `new` status. These are what turn the
   verdict to `regression`, whatever their severity label.
2. **Carried and unverified findings** - shown, contribute to `not_covered` when they leave
   a gap, but are not new regressions.
3. **Waived and fixed findings** - visible for context; they never gate.

Within a group, findings sort by `screen | layer | rule | element key` for stable diffs
across runs.

There is no wired model-judgment lane in v0.2.0. Every provider that runs emits
`deterministic` evidence. The `model-judgment` and `human-confirmed` classes exist in the
type system but no producer feeds them into a run, so no finding currently reaches the
operator as advisory-only.

---

## Noise budget per surface

**Target:** At most **5 distinct findings** shown in overlay and stop-hook summary per
run on a typical touched surface. The full list is available via the CLI `--json` output
and the PR comment expander.

**Calibration:** Initial target; calibrate on an OpenShift measurement pass in build week. If
real surfaces routinely produce >5 findings, raise the threshold or tighten collapse
rules - do not ship a budget that fires on every run.

**If over budget:** Collapse by rule with counts; show top 5 by severity; link to full
JSON.

**Measurement:** Demo app clean pass = 0 findings. Demo broken = exactly 3 (one per
layer). OpenShift measurement pass: track findings per surface for calibration.

**Rip-out tie-in:** Exceeding budget without collapse is a top disable trigger (see
[journeys.md](./journeys.md)).

---

## First-run experience

**Goal:** One command to first finding in **under five minutes**, no custom config.

**Path (target):**

1. Clone the demo repo (it ships `usabl.config.json`), or run `npx usabl init` to scaffold
   `usabl.config.json` and `usabl.routes.json` for a new app.
2. `npm install` (or the documented package manager).
3. `npm run dev` to start the app the config points at, then `npx usabl check`. Targets
   come from `usabl.config.json`; `check` takes no URL argument.

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

## Docs output honesty (three states)

The `usabl docs --html` page renders artifacts; it never mints a verdict. Each artifact
reads as one of three states, and the states are separated in words, not by color:

- **Verified.** The artifact is bound to a minted receipt and its entries carry per-entry
  evidence. Only this state reads as proof.
- **Not proof (expectation).** The artifact is bound to a receipt but no per-entry evidence
  was minted, so its entries are expectations, not per-element proof. The alt-text manifest
  is the current example: it binds to a receipt but mints no per-entry evidence.
- **Not verified (observation).** The artifact is not bound to any receipt, so it is an
  observation of what the interface announced, with no receipt claim.

The overlay and HUD follow the caption rule above: label live output as an accessibility
preview, never as verified proof.

---

## Self-check: dogfooding surfaces

Before submission, run harness on:

- [ ] HUD / overlay page
- [ ] Fleet evidence view
- [ ] PR comment HTML template
- [ ] Deck (done - caught real finding)

Same bar as production demo surfaces.

---

## Accessibility of usabl surfaces

Every shipped surface (HUD, fleet, PR comment, docs output) must meet:

- Reduced motion: respect `prefers-reduced-motion`
- Contrast: PatternFly tokens, no hard-coded low-contrast grays
- Keyboard: all actions reachable without pointer

**Status:** Open - track per surface in build week.

---

## Error and failure UX

When usabl itself breaks (Playwright crash, page timeout, render failure, network
error), the developer must see a clear, honest outcome - never a false `verified` or a
silent pass.

**Rules:**

1. **Tool failure never mints `verified` and never mints a receipt.** A provider that
   throws or is denied a capability becomes a coverage gap, which resolves to `not_covered`
   (exit 3). An unhandled crash in `run()` fails open to exit 4 with `verdict: null`.
   Receipts carry no error field, because a receipt exists only for a `verified` run.
2. **Message to the developer:** open with the state and the exit code, say what it means,
   give the next step, then the gate summary with the crash or gap reason. On the Stop hook
   and in the pull request comment the summary sits inside the untrusted frame. The
   self-check prints no next step: it is advisory, and the Stop hook is the gate. A failed
   run reads "NO VERDICT: RUN FAILED (exit 4)" and never names the word "verified" in any
   form, so it cannot be skimmed as a pass. It says to run again or check by hand, then
   gives the reason.
3. **Timeouts:** the shipped bounds are the keyboard-walk 15s wall-clock cap and the 50-tab
   transcript cap. A timed-out scan becomes a gap and lands on `not_covered`, which blocks.
   There is no timeout-as-warn mode and no configurable per-surface budget yet; usabl is on
   or off.
4. **Overlay failure:** if the harness cannot connect to the dev server, the overlay shows
   a single-line banner, for example "Cannot reach [url] - check not running." No phantom
   findings.
5. **Partial results:** if some screens scan and others gap, the scanned findings are still
   surfaced. With no new failure, a gap holds the verdict at `not_covered` (incomplete proof).
   With a new deterministic failure, the failure outranks the gap and the verdict is
   `regression`. A gap is usually infrastructure, and a new failure is usually the change under
   test, so letting an unrelated broken screen hide "you broke this" would quiet usabl exactly
   when it has the most useful thing to say. Both verdicts block, and the summary line reports
   the gap count under either verdict, so a partial run is never presented as a whole one.
6. **Stop hook and self-check always exit 0.** They never block through an exit code. The
   stop hook blocks by emitting a `{ decision: 'block' }` object on stdout, so a wedged
   hook can never trap the operator with a non-zero exit.

**Rip-out tie-in:** Silent failures that look like "everything passed" are worse than
noisy failures. Teams disable tools that lie about success.

---

## Adoption: brownfield path (on/off, not modes)

usabl is on or off. There are no partial modes, no per-surface strictness, and no
lasting observe mode. Teams adopt on brownfield codebases using the ratchet and waivers,
not by weakening the tool.

### How brownfield adoption works

| Step | What happens | Who decides | Rollback |
|---|---|---|---|
| **Install** | usabl on: CLI, stop hook, CI, overlay, docs output. One standard. | Morgan enables | Remove usabl |
| **First run** | Check existing surfaces; accept evidence floor for known debt | Morgan + Alex agree | Re-run with updated floor |
| **Waivers** | Known issues get waivers with owner and expiry. New violations block. | Code owner per waiver | Remove waiver (finding becomes regression again) |
| **Steady state** | Ratchet burns debt via waiver expiry. The fleet-insights view (measurement-only) shows the trend. Policy changes require `approval_required`. | Team | - |

### Key points

- **No observe mode.** When usabl is on, `not_covered` blocks and regressions block.
  Existing known debt is in the evidence floor, not silently passing.
- **There is no advise mode.** No switch turns gating off. The `model-judgment` evidence
  class exists in the type system for a future advisory lane, but v0.2.0 wires no
  model-judgment producer, so nothing currently surfaces as advisory-only. Every provider
  that runs emits deterministic evidence, and deterministic findings gate.
- **Waivers are the debt path.** One finding, one owner, one expiry. Not "this page
  is advisory." An expired waiver covers nothing; the finding becomes a regression again.
- **Config changes are guarded.** Changing policy triggers `approval_required` - the
  tool's own guard prevents silent weakening.
- **Coverage grows as the team works.** It does not require Design to declare epic scope.
  Most PRs that do not touch UI get "nothing to check" (idle). First UI PR on an
  unmapped page gets `not_covered` until the surface is discoverable.
