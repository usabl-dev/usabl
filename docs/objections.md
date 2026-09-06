# Objection handlers

Prepared responses for skeptic questions about the product itself - not competitors
(see [battlecards.md](./battlecards.md)) but pushback on our claims, scope, and
approach. Use in judge Q&A, demo rehearsal, and alliance conversations.

---

## "It's just axe with extra steps"

**Acknowledge:** axe-core is one of our check layers - we build on it, not against it.

**Redirect:** axe finds issues on a page snapshot. usabl adds what axe cannot do alone:
keyboard interaction walk, PatternFly composition rules, deterministic screen-reader
announcement and accessible-name checks, fix re-verification, and a Stop hook that blocks
the AI's first stop on a blocking verdict unless a one-use bypass was issued. One finding from axe becomes a verified fix in the same
session.

**Proof point:** Demo violation #2 (missing `aria-sort`) is invisible to axe. Violation
#3 (modal focus return) requires the keyboard walk. axe alone passes on both.

---

## "False positives will make teams disable it"

**Acknowledge:** This is the real adoption risk. Every quality gate dies if it blocks
incorrectly.

**Redirect:** Three defenses: (1) if usabl cannot identify which screens changed, it
says `not_covered` with a reason - honest "I don't know" rather than a false pass or
a false fail; (2) we measure false positive rate on a real PF surface before submission
and report the number honestly; (3) the ratchet and waiver system lets teams manage
existing debt without being punished for history.

**Proof point:** Verified-verdict rate and false positive rate on the proof slide,
measured on OpenShift console, not our planted demo.

---

## "Screen reader simulation isn't real AT testing"

**Acknowledge:** Correct, and usabl does not simulate a screen reader. We say this in
the limitation slide, in the tool output labels, and in the legal wording.

**Redirect:** usabl's shipped screen-reader signal is a set of deterministic checks. It
verifies the accessible names and announcement expectations screen reader users depend
on and reports what is missing or broken. It does not speak the UI and does not replace
human AT testing, which remains required and is stated in the output. Real NVDA opens
and closes the demo to establish ground truth.

**Proof point:** Cold open = real NVDA recording. Bookend = same flow, clean. usabl's
own signal is labeled as a deterministic check, never as screen-reader output.

---

## "PatternFly-only means it's niche"

**Acknowledge:** Contest scope is PatternFly. That's intentional - first instantiation
on a real design system with a real user base.

**Redirect:** The architecture is check-agnostic. Providers return `Draft[]`; the gate,
verdict, receipt, and surface model work with any rulepack. PatternFly is proof the
pattern works. The engine generalizes - one roadmap sentence in the pitch, not a pivot.

**Proof point:** axe-core layer is already design-system-agnostic. Keyboard walk is
generic. Only the PF rulepack is PF-specific, and it's one provider among three.

---

## "The AI can just bypass the hook"

**Acknowledge:** In an unguarded session, yes. Stop hooks are not sandboxed jails.

**Redirect:** Two-tier enforcement: (1) the stop hook in configured assistant workflows
catches the common case; (2) CI with branch protection is the backstop that covers
every contributor regardless of tooling. The assistant cannot merge the PR without CI
passing. We say "configured workflows" and "CI for everyone" before a judge asks.

**Proof point:** Skeptic demo - try to unmap, exempt, re-baseline. Guard holds locally
(approval_required) and CI blocks the PR.

---

## "What about existing accessibility debt?"

**Acknowledge:** Real repos are not green on day one. A tool that blocks everything on
legacy code is useless.

**Redirect:** Three mechanisms: (1) ratchet - only new violations block, existing debt
is in the evidence floor; (2) waiver ledger - known debt tracked with expiry, not hidden;
(3) brownfield adoption path - install, accept the floor for legacy surfaces, and the
tool gates only new regressions from day one. Teams are not punished for history.

**Proof point:** Onboarding journey in personas: Morgan installs usabl, accepts the
evidence floor on legacy surfaces, and ratchets from there. No legacy surface blocks
on day one.

---

## "How is this different from a PR review bot?"

**Acknowledge:** The CI/PR evidence surface looks similar from the reviewer's chair.

**Redirect:** A PR bot comments after the code is written. usabl prevents the defect
in the assistant loop before the PR exists, then the same verdict becomes PR evidence.
Upstream prevention + downstream proof, same engine.

**Proof point:** THE MOMENT happens inside the assistant session - the PR has no
regression to comment on because it was caught and fixed before commit.

---

## "You're replacing the accessibility team"

**Acknowledge:** Never. The accessibility team's guidance is our rulepack source. Their
judgment is our escalation path.

**Redirect:** usabl handles the mechanical, repeatable checks - the same audit Alex
does 50 times a quarter on icon-only buttons. Alex gets escalations with repro scripts
and evidence instead of "please test the whole page." Integration-and-acceleration,
not replacement.

**Proof point:** Findings that need human judgment arrive with repro steps and an
evidence bundle for Alex, not a "please test the whole page" dump. Alliance framing in
every pitch.

---

## "What if the tool is wrong and blocks a ship?"

**Acknowledge:** Any gate that can block has this risk. The question is: what happens
next?

**Redirect:** (1) Findings include full evidence - the developer can see exactly what
triggered the block and verify it's real. (2) Waiver path exists for known issues
that cannot be fixed this cycle. (3) When usabl cannot check a surface, it reports
`not_covered` with a reason rather than a false pass or false fail, and if the engine
itself crashes it fails open instead of fabricating a block. (4) The ratchet means the
tool only gates new violations,
so teams already trust the signal before it blocks anything they did not just introduce.

**Proof point:** Error UX policy: a surface usabl cannot check becomes `not_covered`
with a reason; an engine crash fails open, never a false red. Waiver ledger with expiry.
Brownfield adoption model.

---

## Pattern for new objections

When a new objection surfaces in rehearsal or Q&A, add it here with:

1. **Acknowledge** - never dismiss; name what's true.
2. **Redirect** - where does usabl's design already address this?
3. **Proof point** - what artifact or demo beat proves the redirect?
