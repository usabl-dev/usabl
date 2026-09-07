# Why now

Evidence sheet for pitch, deck, and judge Q&A. Every claim has a citation or primary
source. Legal-safe framing: usabl supports evidence for accessibility work; it does not
claim compliance.

---

## 1. Regulation and procurement pressure

### European Accessibility Act (enforceable 2025)

- **What:** EU Directive 2019/882 requires in-scope digital products and services sold
  to EU consumers to meet accessibility requirements. EN 301 549 is the European ICT
  accessibility standard; its current version is harmonized for the Web Accessibility
  Directive and is being updated to support Directive 2019/882.
- **When:** Application date **28 June 2025** - enforcement is live, not upcoming.
- **Why usabl:** Teams need continuous proof of accessibility work on shipped UI, not
  annual audit snapshots.

**Sources:**

- [EUR-Lex: Directive (EU) 2019/882](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32019L0882)
- [European Disability Forum: products and services list (28 June 2025)](https://www.edf-feph.org/accessibility-act-enters-into-force-products-and-services-must-be-accessible/)
- [A11yFlow: EAA developer guide (2026)](https://www.a11yflow.dev/blog/european-accessibility-act-developer-guide)

### Section 508 and VPAT deal-gating (US federal and enterprise)

- **What:** US federal ICT must meet Section 508; enterprise vendors routinely provide
  VPAT/ACR evidence in procurement.
- **When:** Ongoing; federal refresh and buyer scrutiny continue through 2025–2026 cycles.
- **Why usabl:** A re-checkable receipt on each verified change supports VPAT
  evidence packs without claiming certification.

**Sources:**

- [Section508.gov: Laws and policies](https://www.section508.gov/manage/laws-and-policies/)
- [ITI VPAT overview](https://www.itic.org/policy/accessibility/vpat)

---

## 2. AI-generated UI is the new default - and the new risk

### WebAIM Million 2026

- **Finding:** 95.9% of home pages have detectable WCAG failures (up from 94.8% in
  2025). The web is getting less accessible by measurable metrics, even as tooling
  and awareness grow.
- **Quote use:** The problem is getting worse, not better - more code ships faster
  with less checking.

**Source:** [WebAIM Million 2026](https://webaim.org/projects/million/)

### CodeA11y (CHI 2025)

- **Finding:** Developers using AI assistants often skip accessibility prompts, omit
  manual steps (labels, alt text), and **cannot verify compliance** after generation.
- **Quote use:** "Inability to verify compliance" is the gap usabl narrows: it verifies by
  machine that a change added no new unwaived detectable barrier on the screens it scanned. It
  does not verify compliance.

**Source:** [CodeA11y, CHI 2025 (arXiv:2502.10884)](https://arxiv.org/abs/2502.10884)

### A11YRepair (ASE 2026)

- **Finding:** Tooling **overwhelmingly focuses on detecting** accessibility violations
  rather than repairing them; LLM repair without verification still risks unproven fixes.
- **Quote use:** Detection tooling is mature; **verified repair in the dev loop** is the
  open problem.

**Source:** [A11YRepair (arXiv:2606.21926)](https://arxiv.org/abs/2606.21926)

### Pedal Point: AI-generated code is inaccessible by default (2026)

- **Finding:** AI-assisted coding adoption is rising fast while detectable WCAG failures
  on the web remain ~96%; generated UI must be treated as draft until reviewed and
  tested.
- **Quote use:** Speed without proof ships inaccessible patterns at scale.

**Source:** [Pedal Point Solutions (May 2026)](https://pedalpoint.com/2026/05/ai-generated-code-is-inaccessible-by-default/)

### Stack Overflow Developer Survey (context)

- **Finding:** Majority of professional developers use or plan to use AI coding tools
  daily or near-daily - accessibility must move into that loop.

**Source:** [Stack Overflow Developer Survey 2025](https://survey.stackoverflow.co/2025/)

---

## 3. Category literature agrees on the gap

usabl's design goal, stated as a goal and not as a fact about other tools: verify that the
fix worked, not only find the issue.

usabl's timing: the advisory MCP layer commoditized in under a year; the **proof loop**
is the next layer teams will ask for.

**Source:** internal market-landscape research (August 2026, maintained outside this repository)

---

## Pitch lines (citation-backed)

| Line | Backed by |
|---|---|
| "95.9% of web pages still fail basic accessibility checks." | WebAIM Million 2026 |
| "Accessibility law is enforceable now, not next year." | EAA June 2025 |
| "AI writes UI faster than teams can audit it." | CodeA11y, Pedal Point, SO Survey |
| "Finding bugs is not enough - teams need proof the fix worked." | A11YRepair, category reviews |
| "Proof belongs in the same session as the code." | CodeA11y G3 (complete and verify) |

---

## Re-sweep reminder

Schedule a landscape re-sweep **within two weeks of submission**. Update this doc and
[battlecards.md](./battlecards.md) if a competitor ships fix verification or SR diff in
the assistant loop.

**Last sweep:** 2026-08-04 (`market-landscape-2026-08.md`). **Next due:** TBD from
submission date.
