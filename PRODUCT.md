# Product context

## Product

usabl is an accessibility proof engine for product development workflows. It checks
the user interface affected by a change and reports an honest result before the work
is called done.

Version 0.2.0 is a private team preview and a Red Hat Innovation Days 2026 contest
entry.

## Audience

The primary audience for the team orientation is the mixed project team:

- Engineers who will change the engine, fixture, integrations, or tests.
- Accessibility reviewers who will exercise behavior and judge evidence.
- Product, UX, content, demo, and project contributors who may not write code.

Everyone should be able to understand the product, run or observe the proof loop,
choose a contribution lane, and report useful feedback in one working session.

## Positioning

Most accessibility tools report findings. usabl decides whether the affected work is
verified, has a regression, is not covered, or needs human approval. Idle means no
relevant surface changed and is not a fifth verdict.

The gate is the only verdict authority. Providers return evidence drafts. They do not
grade their own work. Verified results can include a receipt bound to the exact source
tree, policy, and runner.

## Orientation goal

The orientation should move a teammate through this belief sequence:

1. Accessibility checks need an honest completion decision.
2. usabl has a clear result model and re-checkable evidence.
3. Every surface shows the same canonical result.
4. The demo proves a real regression and fix.
5. Every team role has a useful next action.

The primary action is to start the guided walkthrough. The secondary action is to
choose a contribution lane.

## Voice

Use plain English. Be direct, exact, and humane. Prefer evidence over claims. Explain
technical terms when they first appear. Do not use marketing language or claim more
than v0.2.0 proves.

## Visual character

The visual direction is an accessible mission-control handbook with transit-style
wayfinding and mature enterprise accessibility semantics.

- Deep ink and warm paper establish the page.
- Electric cobalt carries navigation and structure.
- Green is reserved for verified proof.
- Red is reserved for regressions.
- Amber is reserved for incomplete coverage.
- Violet is reserved for human approval.
- Strong type, thin rules, and numbered sections guide the reader.

Avoid generic marketing pages, dashboard tile walls, fake terminal windows, gradients,
glass effects, and decorative charts.

## Accessibility requirements

- Target WCAG 2.2 AA.
- Preserve a logical heading order and landmark structure.
- Provide visible keyboard focus.
- Do not rely on color alone for meaning.
- Keep body text readable in a projected desktop presentation.
- Support 200 percent zoom and a clean print layout.
- Respect reduced-motion preferences.
