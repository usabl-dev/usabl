# Competitive battlecards

One card per rival **class** - not a feature matrix. Use in pitch Q&A, community
conversations, and judge follow-ups. This is competitive positioning for an OSS
project: we acknowledge what others do well, explain where we go further, and note
where tools are complementary rather than zero-sum.

Full landscape: internal market-landscape research (August 2026, maintained outside
this repository). User-facing positioning: [positioning.md](./positioning.md).

---

## Advisory MCP (Deque axe MCP, community axe wrappers)

**What they do well:** Drop into Claude Code, Cursor, or Copilot today; familiar axe
findings; Deque adds remediate guidance and training content.

**What we add:** The full proof loop - fix re-verification, keyboard walk,
deterministic screen-reader announcement checks, differential ratchet, and a stop gate
that blocks an assistant's first stop on a blocking verdict unless a one-use bypass was issued.

**Complementary?** Yes - Deque's remediate guidance and usabl's proof gate can coexist.
axe-core is one of our check layers.

**One-liner:** "They advise from the chat. We re-check the fix and block the assistant's
first stop on a blocking verdict unless a one-use bypass was issued."

---

## LLM-review agents (Community-Access/accessibility-agents)

**What they do well:** Deep WCAG specialist personas, SARIF output, real community
credibility, edit locks until an accessibility lead agent runs.

**What we add:** Per-change deterministic verdicts from Playwright + axe + keyboard
walk + PF rules; the gate decides and the AI only proposes.

**Complementary?** Potentially - their specialist prompts could inform fix suggestions
while our gate holds the verdict. Different architectural bets (LLM review vs
deterministic proof).

**One-liner:** "They review once per session. usabl runs its gate on every change and discloses every gap it detected."

---

## Output preview (JAWS Inspect, Tactual, Speakable)

**What they do well:** Strong announcement preview; JAWS Inspect uses the real engine;
Tactual and Speakable add diff and CI-friendly workflows.

**What we add:** Deterministic announcement and accessible-name checks embedded in the
assistant and PR proof loop, with fix verification, PatternFly rules, and team
enforcement on one Result.

**Complementary?** Yes - Tactual or Speakable could be adopted as a provider behind the
usabl gate for richer phrasing validation. Guidepup is a candidate too.

**One-liner:** "They let you hear the UI. We prove the change added no new unwaived
machine-checkable barrier on the screens we scanned."

---

## Enterprise flows (Evinced, Level Access integrations)

**What they do well:** Production journey analysis, governance, and programs for large
enterprises with budget and procurement process.

**What we add:** Open, developer-native proof at edit time and in the AI session -
before enterprise process, on the engineer's machine and in the PR.

**Complementary?** Different audience and lifecycle stage. Enterprise tools govern
programs; usabl blocks new machine-checkable regressions at creation on the screens it
scans. They can coexist; a barrier blocked at creation never reaches an enterprise
dashboard.

**One-liner:** "They govern the program. We check each change, in the workflow where it
is written, for new machine-checkable barriers, and report the gaps."

---

## Scan-and-dashboard (Lighthouse, WAVE, enterprise dashboards)

**What they do well:** Broad reach, executive visibility, familiar audit reports.

**What we add:** Start at creation, verify fixes, and ratchet regressions with the same
evidence the developer and the AI already saw.

**Complementary?** Yes - Lighthouse and WAVE remain useful for ad-hoc audits and
broader page health. usabl adds a change-level gate with a receipt on verified runs.

**One-liner:** "They report after the fact. We run the check before the assistant's first
stop, and block that stop on a blocking verdict unless a one-use bypass was issued."

---

## PR review bots (Accessible PR Copilot pattern)

**What they do well:** Meet teams at merge time with comments and suggestions.

**What we add:** Prevent upstream in the assistant loop and produce the same PR
evidence bundle from a stronger verdict source.

**Complementary?** Partially - if a team already has a PR bot, usabl's CI leg can run
beside it; usabl's verdict is read from the Result, never from a comment. The upstream
prevention in the assistant loop is additive.

**One-liner:** "They comment on the PR. usabl blocks the assistant's first stop on a blocking verdict, before the PR exists, unless a one-use bypass was issued."

---

## Fix-verification commercial (Jeikin)

**What they do well:** Market fix verification and a persistent dashboard for teams
buying an enforcement story.

**What we add:** Full multi-layer proof (keyboard walk, PF rules, deterministic
screen-reader announcement checks), OSS, PatternFly-native, integrated with the assistant
Stop hook and CI. No subscription, no vendor lock.

**Complementary?** No - different philosophical bets. Jeikin is closed-source SaaS;
usabl is open and local-first.

**One-liner:** "They verify fixes in a dashboard. We verify in the dev loop and ship
the receipt."

---

## PatternFly / design-system team entry

**What they do well:** Own the components and the official guidance.

**What usabl adds:** Encode their guidance in an extensible rulepack inside
a proof engine whose Stop hook blocks an assistant's first stop on a blocking verdict
unless a one-use bypass was issued - alliance, not rivalry.

**One-liner:** "They build accessible components. We check that each change composes
them without a new unwaived machine-checkable barrier on the screens we scan."
