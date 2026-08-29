# User journeys

Formal journey maps for each daily moment. Stages, emotions, friction points, and
rip-out prevention.

Personas: [personas.md](./personas.md). Daily-moments inventory: `entry-spec.md`
§ "Where it lives in a developer's day."

---

## Journey 1: Priya - assistant loop

**Persona:** Priya (UI engineer with AI assistant).  
**usabl installed:** Yes (CLI + stop hook + CI + overlay).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Prompt | Asks for toolbar + table + row actions | Productive, fast | Assistant edits unmapped file -> `not_covered` instead of proof |
| 2. Build | Assistant edits files; mid-task self-check optional | Flow | Check latency breaks flow if > ~30s |
| 3. Blocked done | Stop hook: `regression` or findings present | Surprise -> curiosity | "Why blocked?" if message unclear |
| 4. Findings | Three findings, one line each + announcement preview | Clarity | Finding fatigue if noisy |
| 5. Fix + re-verify | Assistant fixes; harness runs again | Relief | False positive -> trust loss |
| 6. Done allowed | `verified` verdict; receipt minted | Confidence | - |

**Friction audit:**

- **Latency:** Target fast loop on save (<10s partial), complete loop before done (<60s).
  State both in README when measured.
- **Finding fatigue:** Dedupe, severity order, noise budget ([ux-policy.md](./ux-policy.md)).
- **Gate trust:** Proof slide + guarded config; skeptic demo on camera.

**Rip-out moment:** Assistant disabled or hook bypassed after one false block.  
**Prevention:** Accurate findings on demo set; `not_covered` only with reason; ratchet
ensures existing debt does not block.

---

## Journey 2: Manual coder - dev-server overlay

**Persona:** Engineer coding by hand without assistant.  
**usabl installed:** Yes (overlay active in dev server).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Save | Hot reload; harness runs on mapped surface | Habitual | Unmapped surface -> no feedback |
| 2. Overlay finding | Finding appears beside build errors | Mild annoyance | Overlay clutter |
| 3. Fix | Edits code from surfaced-text guidance | Engaged | Vague fix text |
| 4. Clear | Overlay clears on verified pass | Satisfaction | Flapping on partial saves |

**Rip-out moment:** Overlay dismissed and never reopened.  
**Prevention:** Single-flight runs; deduped findings; dismiss only per-finding not global
kill switch; same severity order as CLI.

---

## Journey 3: Reviewer - PR evidence bundle

**Persona:** Peer reviewer or Morgan (lead).  
**usabl installed:** Yes (CI comment on PRs).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Open PR | Visual diff as usual | Routine | - |
| 2. Evidence comment | Findings + current-run announcements | Insight | Comment noise on large PRs |
| 3. Hear announcements | Current-run transcript for focus path | "Aha" | Preview vs real AT confusion |
| 4. Approve | Merge when ratchet green | Confidence | Block without waiver path |

**Rip-out moment:** Team ignores bot comments.  
**Prevention:** High-signal comments only (regressions + transcript on touched surfaces);
link to receipt; ratchet blocks only when team enables required check.

---

## Journey 4: Team onboarding - brownfield adoption

**Persona:** Morgan (engineering lead).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Install | usabl on: CLI, hook, CI, overlay. One standard. | Curious | "Another bot" |
| 2. First run | usabl runs against existing surfaces; evidence floor accepted for known debt | Cautious | Legacy debt pile visible for first time |
| 3. Waivers | Known issues get waivers with expiry; new violations block | Cautious optimism | Waiver ceremony feels heavy |
| 4. Steady state | Ratchet burns debt via waiver expiry; fleet tile shows trend | Trust | Policy tamper suspicion |

**Who flips each switch:** Morgan + Alex (SME) agree; Riley informed for release evidence.

**Needs to feel safe:** Debt in evidence floor/waiver ledger; ratchet blocks only new
violations; CODEOWNERS on policy files.

**Rip-out moment:** Tool turned off after one bad Monday.  
**Prevention:** Ratchet (new only); waiver with expiry; fleet tile shows trend not shame.

---

## Journey 5: James - outcome loop

**Persona:** James (AT user on the team or customer).

| Stage | What happens | Emotion | Friction risk |
|---|---|---|---|
| 1. Barrier | Hits broken flow in build or dogfood | Frustration | - |
| 2. Report | Files issue with harness repro | Hopeful | No repro attached |
| 3. Fix verified | Team runs loop; James gets build | Relief | "Fixed" without proof |
| 4. Shipped | Same release or next | Validated | Regression in following release |

**Rip-out moment:** James stops reporting; works around in private.  
**Prevention:** Verified verdict on fix; announcement preview in PR; SME voice in validation.

**Demo:** Real NVDA cold open and bookend; in-loop preview labeled as dev-time aid.

---

## Rip-out audit summary

| Journey | Disable trigger | Prevention |
|---|---|---|
| Assistant loop | False block, slow check | Oracle demo set; latency budget; proof slide |
| Overlay | Clutter, flapping | Dedupe; single-flight; severity cap |
| PR reviewer | Bot fatigue | Comment only on touched surfaces + regressions |
| Onboarding | Debt wall | Evidence floor; ratchet; waivers |
| James | Empty "fixed" | Verified + transcript evidence |

---

## Journey map status

| Journey | Documented | Filmed / tested |
|---|---|---|
| Priya assistant loop | Yes | Open (THE MOMENT) |
| Manual overlay | Yes | Open |
| PR reviewer | Yes | Partial (static PR comment in harness) |
| Team onboarding | Yes | Open |
| James outcome | Yes | Open (NVDA session) |
