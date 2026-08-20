# Success metrics

Metrics are defined before the demo so we can report numbers we actually measured, not
aspirations. Each metric has a definition, measurement method, target, and where the
number will appear.

For product framing see [positioning.md](./positioning.md). For demo script see
`entry-spec.md` at repo root.

---

## 1. Time to first finding (new repo)

**Definition:** Elapsed time from `npm install` (or equivalent) through first
actionable finding on a clean clone, with zero custom config beyond documented defaults.

**Why it matters:** Judges and adopters need proof that usabl delivers value in one
sitting, not after a mapping sprint.

**Measurement:**

1. Stranger test: someone not on the team follows [quickstart target](#quickstart-target)
   only.
2. Record wall-clock time to first finding with rule id, surface, and fix hint.
3. Repeat on two repos: demo app (controlled) and one real PatternFly surface.

**Target:** Under five minutes on the demo app. Under fifteen minutes on a real PF
surface with Storybook or route discovery enabled.

**Where reported:** Quickstart README, proof slide footnote, judge Q&A.

**Status:** Open until quickstart ships. Harness selftest proves engine works; stranger
test not run yet.

---

## 2. Violations prevented per week

**Definition:** Count of new accessibility regressions blocked before merge in a repo
running usabl CI, measured as ratchet-blocked PRs or stop-hook
blocks that would have introduced a new violation against the floor.

**Why it matters:** "At scale" in the challenge title means the loop changes team
behavior, not just one demo moment.

**Measurement:**

- CI: PRs where harness verdict is `regression` and merge was blocked or waived.
- Assistant: stop-hook blocks where re-verify eventually reaches `verified` (count the
  would-have-shipped violation).
- Fleet evidence view: aggregate from committed findings JSON per repo (demo seed data
  for contest; real number post-pilot).

**Target (contest):** Qualitative story plus at least one blocked regression in the
filmed demo. Quantitative weekly rate is a post-contest pilot metric.

**Where reported:** Fleet tile, enforcement segment of demo arc.

**Status:** Demo-scripted; fleet uses seeded honest JSON.

---

## 3. Verified-verdict rate on real surfaces

**Definition:** Of mapped surfaces checked in a full pass, what percentage
receive a `verified` outcome (no findings, full coverage) on first run?

Formula: `verified_surfaces / mapped_surfaces` on the probe set.

**Why it matters:** Proves the engine handles real PatternFly glue, not only our
planted demo violations.

**Measurement:**

1. Run usabl against OpenShift console (or agreed PF OSS surface).
2. Log verdict per mapped surface; record `not_covered` separately (coverage gap, not
   quality fail).
3. Do **not** measure only the demo app (circular).

**Target:** Document the measured rate on the proof slide. No fabricated "good number."
If below expectation, widen probe set or rulepack before submission.

**Where reported:** Proof slide, build-week log.

**Status:** Open - scheduled build-week measurement per entry-spec red-team #17.

---

## 4. Time to accessible (found issue -> verified fix)

**Definition:** Elapsed time from first harness finding on a touched surface to
`verified` verdict after fix, in the assistant loop or overlay loop.

**Why it matters:** James's outcome story - barriers caught and cleared in the same
session, not the next release.

**Measurement:**

- **Demo (primary):** Script THE MOMENT; compare to the brief's "multiple releases"
  baseline narratively. Use wall-clock from first finding to allowed "done" (~2 minutes
  target in rehearsal).
- **Pilot (secondary):** Median over N real fixes in dogfood week.

**Target:** Demo under three minutes for the three-layer violation set. No invented
industry benchmark.

**Where reported:** Bookend of demo arc; not a standalone marketing claim.

**Status:** Demo arc defined in entry-spec; filmed timing open.

---

## 5. False positive rate

**Definition:** Of findings surfaced by usabl, what percentage are
incorrect (the flagged issue does not actually exist, or the fix guidance is wrong)?

**Why it matters:** False blocks are the #1 adoption killer for any quality gate. One
wrong block erodes a week of trust. This is the metric Morgan watches before trusting
the gate to block.

**Measurement:**

1. Run usabl on real PF surface; human-review each finding as true positive,
   false positive, or debatable.
2. Calculate `false_positives / total_findings`.
3. Separately track `not_covered` verdicts (honest "don't know") - these are not false
   positives; they are correctly scoped uncertainty.

**Target:** Under 5% false positive rate on the demo set (planted violations only).
Under 10% on a real PF surface. Report the real number on the proof
slide regardless.

**Where reported:** Build-week log, proof slide footnote, judge Q&A prep.

**Status:** Open - requires a measurement pass on a real surface.

---

## Quickstart target

Placeholder for section 7 quickstart README. Success metric #1 depends on this path:

```bash
# Target shape (exact commands TBD when CLI ships)
git clone <repo>
cd <repo> && npm install
npx usabl check --url http://localhost:5173/demo
# -> first finding in < 5 min from cold clone
```

---

## Scorecard (fill at submission)

| Metric | Measured value | Date | Notes |
|---|---|---|---|
| Time to first finding (demo app) | | | |
| Time to first finding (real PF surface) | | | |
| Verified-verdict rate (observe, real surface) | | | |
| False positive rate (observe, real surface) | | | |
| Demo: finding -> verified fix | | | |
| Regressions blocked (demo / fleet) | | | |
