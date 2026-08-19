# Message house

Status: working draft. Author: eparenti. August 2026.

One line per audience for pitch, deck, and community communication. Usabl is an
open-source project - messaging reflects that: no paid tier, no vendor lock, community
contribution is part of the value.

Expanded messaging in [positioning.md](./positioning.md). Competitive positioning:
[battlecards.md](./battlecards.md).

---

## Core promise (all audiences)

**Usabl makes every UI change complete accessibility proof before it ships.**

Supporting: *Usable by default.* / *Don't ship until it's Usabl.*

**Lead order for pitch:** Open with the tagline (outcome, emotional), then explain with
the mechanism ("AI suggests, rules decide, done waits for proof"). Tagline sets the
promise; differentiator #1 message explains how we keep it.

---

## By audience

| Audience | One line |
|---|---|
| **Judge (general)** | The first open proof engine that stops AI from calling inaccessible UI done - with evidence you can re-check on the PR. |
| **Judge (technical)** | Deterministic Playwright + axe + keyboard walk + PatternFly rules; AI proposes fixes, the gate decides pass/fail. |
| **Judge (business)** | Catches accessibility regressions before VPAT evidence and customer escalations - without claiming compliance. |
| **Judge (accessibility expert)** | Mechanical layers handle the repeatable checks; your expertise stays on judgment calls, with repro scripts attached. |
| **Priya (engineer)** | Real-time findings with fix guidance, and the assistant cannot say done until the harness verifies the change. |
| **James (AT user)** | Barriers become audible to the team before merge, and fixes are verified in the same workflow that introduced them. |
| **Morgan (eng lead)** | Start in observe mode, gate when ready - ratchet blocks only new debt, with a waiver ledger for the rest. |
| **Alex (a11y SME)** | Fewer repeated audits; escalations arrive with evidence, not "please test the whole page." |
| **Riley (compliance)** | Receipt-backed findings on each change for evidence packs - the tool states human review is still required. |
| **PatternFly / upstream** | An open rulepack that encodes your guidance inside the proof loop teams already run. Proposed upstream, co-maintained. |
| **OSS contributor** | Provider interface is the contribution seam - add a check, return `Draft[]`, ship a rule. |

---

## Differentiator -> message (ranked)

| Rank | Differentiator | Message |
|---|---|---|
| 1 | Verified-fix assistant loop | "AI suggests. Rules decide. Done waits for proof." |
| 2 | Announcement preview in loop | "Hear the change before merge - in the PR and in the session." |
| 3 | CI ratchet + PR evidence | "Same proof at scale: block new debt, ship the receipt." |

Teaching artifact supports #3; not a fourth pillar.

---

## Proof points (show, don't tell)

| Claim | Demo artifact |
|---|---|
| Gate works | THE MOMENT - blocked done -> verified |
| Ground truth | Real NVDA cold open + bookend |
| AI does not judge | Proof slide: verdict source list |
| Policy integrity | Skeptic tries unmap/exempt - guard holds |
| We eat our own cooking | Deck failed harness; finding fixed |
| Real code | OpenShift observe pass (verified-verdict rate) |

---

## Prior-art sentence (required slide)

> What is new is not another scanner: it is an assistant-time accessibility loop where
> AI proposes fixes, PatternFly composition rules and rendered checks verify them, and
> the same evidence ratchets in PRs without claiming compliance.

---

## Self-check story (pitch beat)

Our own deck failed our own product. We have the finding and the fix. Judges remember
that more than a feature list.

---

## Status

- [x] Differentiators mapped to judge types (entry-spec "Why this wins")
- [x] Compressed to one line per audience (this doc)
- [x] Lead order declared: tagline opens, mechanism supports
- [ ] Edgar voice and taste pass on deck narration
- [ ] Limitation slide phrased as confidence (see demo arc in entry-spec)

---

## Demo narrative

The scripted demo arc lives in `entry-spec.md` § "Demo arc." This doc owns the
**messaging frame**; the entry-spec owns the **beat-by-beat script**. When rehearsing,
use the proof points table above as a checklist: every claim in the narration must map
to a demo artifact.
