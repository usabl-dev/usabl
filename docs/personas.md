# Personas

Who usabl is for, who it is not for, and what each person needs to trust the project.
These are open-source adopters (Apache-2.0). usabl is a team preview today, not yet
published to npm, so adopters run it from the repo, contribute on GitHub, and decide
adoption on merit, not procurement.

Journey detail: [journeys.md](./journeys.md). Adoption funnel:
[adoption-model.md](./adoption-model.md). Challenge brief personas: Priya and James
below.

---

## Primary personas (challenge brief)

### Priya - product UI engineer

**Role:** Builds PatternFly screens with an AI coding assistant. Strong intent; no
real-time accessibility signal while coding.

**Goal:** Ship features fast with confidence that keyboard and screen reader users can
use what she built.

**Pain:** Finds out about barriers in QA or from James, weeks later. AI says "done" but
she has no way to hear what changed.

**usabl value:** Real-time proof in the assistant loop, overlay while hand-coding, and
clear findings with fix guidance. Stop hook blocks "done" until verified.

**Success looks like:** First finding in minutes; fix verified in the same session; PR
evidence bundle ready for review.

---

### James - developer who uses a screen reader

**Role:** Ships code and uses NVDA daily. Experiences accessibility failures as blocked
work, not abstract audit items.

**Goal:** Barriers fixed in the same release cycle, not three releases later.

**Pain:** Multi-release latency; teams do not hear what he hears until late.

**usabl value:** Deterministic announcement and accessible-name checks surface broken
or missing announcements early, so non-AT teammates see the barriers in the loop.
Verified fix loop shortens time-to-ship.

**Success looks like:** Reports one barrier; team reproduces via harness; fix verified
and shipped in days, not quarters.

**Voice rule:** We never speak for James. usabl's announcement checks are deterministic
expectations, not a recording of what he hears; any claim about real screen-reader
behavior needs SME validation, and we use real NVDA for ground truth. "Early preview,"
not "James-approved."

---

## Extended personas (brief implies)

### Morgan - engineering lead

**Role:** Owns delivery, tech debt, and rollout of quality gates.

**Goal:** Adopt accessibility proof without revolt - install, manage existing debt via
waivers, gate new violations from day one.

**Pain:** Another noisy linter; false positives erode trust; unclear ROI.

**usabl value:** Ratchet blocks only new violations; evidence floor for existing debt;
waiver ledger with expiry for accepted debt; policy changes require human approval.

**Needs to feel safe:** Noise budget (see [ux-policy.md](./ux-policy.md)); waiver ledger;
honest coverage reporting; brownfield adoption path handles legacy without punishment.

---

### Alex - accessibility SME

**Role:** Deep WCAG and AT expertise; escalation path for human review.

**Goal:** Spend time on judgment calls, not repeating the same kebab-button audit.

**usabl value:** Deterministic layers handle mechanical issues; escalations arrive with
repro steps and an evidence bundle. Not replaced - focused.

**Needs to feel safe:** Escalation volume capped by dedupe and severity ordering; tool
does not claim to replace AT testing.

---

### Riley - compliance and release owner

**Role:** VPAT, Section 508 packages, customer security questionnaires.

**Goal:** Traceable evidence that accessibility was checked on shipped changes.

**usabl value:** A re-checkable receipt on each verified change, PR evidence bundles,
and a version-pinned tool chain (engine plus axe, Playwright, and Chromium) recorded in
the receipt JSON.

**Needs to feel safe:** Evidence-support language only; no "compliant" claims from the
tool; human review remains stated.

---

### The judge

**Role:** Mixed technical, business, and accessibility expertise in one room.

**Goal:** See a real problem, a real solution, and honest scope in three minutes.

**usabl value:** THE MOMENT (blocked done -> verified fix); real NVDA bookend; proof
slide; self-check story (deck failed our own product).

**Survives if:** Demo is live or filmed; claims match artifacts; limitation slide reads
as confidence (ground truth already heard NVDA).

---

## Anti-persona

**Buyers of end-user overlay widgets** (accessibility overlays on the live site).

usabl operates in the **development workflow** - editor, assistant, CI, PR - not on the
shipped page for end users. We do not replace overlays, cookie banners, or post-hoc
widget fixes.

**Also not the target:** Teams looking for a compliance certification service. usabl
provides evidence that supports compliance work, but does not certify, audit, or
issue conformance statements.

---

## Validation plan

| Activity | Who | Question | Status |
|---|---|---|---|
| 2–3 engineer interviews | Red Hat UI engineers | Does the loop fit real workflow? | Open |
| 1 AT user interview | Daily screen reader user (SME recruit) | Do our announcement claims respect reality? | Open - depends on SME recruitment |
| Stranger quickstart | Not on team | Time to first finding < 5 min? | Open |

Record notes in `usabl/.work/validation/` when interviews run.
