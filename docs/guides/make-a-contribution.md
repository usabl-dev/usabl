# Make a contribution

Use this guide to turn one accessibility observation or proof gap into a small,
reviewable change.

Read [How usabl works](../how-usabl-works.html) before changing coverage,
evidence, verdicts, receipts, or product surfaces.

## 1. Choose one outcome

Start from a reported accessibility problem, proof gap, or agreed team task.
State the outcome in one sentence.

Examples:

- The modal returns focus to its trigger after close.
- The overlay explains `not_covered` without implying success.
- The proof-loop guide names the command that failed.
- The demo backup includes the verified receipt.

If the sentence contains two independent outcomes, split the work.

## 2. Choose the repository

- **usabl:** evidence, gate, receipt, surfaces, engine tests, and product docs
- **usabl-app:** fixture behavior, demo scenarios, overlay integration, and app tests
- **usabl-plans:** accepted plans, ownership, decisions, and build record

Ask before changing product language, verdict meaning, security policy, or the
architecture.

## 3. Claim the work

Comment on the issue or tell the team which outcome you are taking. Name:

- The repository
- The expected result
- How you will prove it
- Any help you need

This prevents two people from solving the same problem differently.

## 4. Make a focused branch

For code or documentation changes:

```bash
git switch main
git pull --ff-only
git switch -c type/short-description
```

Use a branch type such as `fix`, `feat`, `docs`, or `test`.

For accessibility behavior changes, write a failing test first. For
documentation, identify the specific question the current text does not answer.

## 5. Run the repository gates

In `usabl`:

```bash
python -m pre_commit run --all-files
npm run check
gitleaks detect --verbose --redact --exit-code 1
```

In `usabl-app`:

```bash
npm test
npm run build
```

Do not skip hooks. Do not treat an empty usabl result as a pass.

## 6. Commit clearly

Use Conventional Commits:

```text
fix: restore modal focus after close
docs: explain the proof-loop setup
test: cover the fixed modal route
```

Do not add AI co-author trailers.

## 7. Open the pull request

Complete:

- **Summary:** what accessibility behavior or proof changed and why
- **Test plan:** exact checks and observed results
- **AI assistance:** keep the template note when AI helped

Link the issue. Add screenshots only when they prove visible behavior.

The change needs:

- Green required checks
- Independent engineering review
- Independent security review against `main`
- Founder merge decision

Do not paste the private security review into the pull request.

### Policy and floor changes

A pull request that edits `usabl.config.json`, `usabl.routes.json`,
the configured requirements path, `.usabl-evidence.json`, or
`.usabl-waivers.json` is `approval_required`.
That is not a merge dead-end. This is the consumer gate (the app that
runs `usabl enforce policy`). This repository's org-team CODEOWNERS is
engine governance and is a separate file.

- The accessibility check reports what the gate would have decided without
  the policy diff. It never uses exit 2.
- The policy check stays red until a CODEOWNERS user who is not the author
  approves the current head commit for **each** dirty guarded path.
- Approving your own policy pull request does not count.
- The sticky usabl comment still shows `APPROVAL REQUIRED` after the policy
  check is green.

## Non-code contributions

You can contribute without a branch:

- File a reproducible product or accessibility issue.
- Test an existing pull request and report the exact result.
- Review the orientation as a first-time user.
- Rehearse the demo and record timing or recovery problems.
- Own a checklist or evidence capture task.

Use the [test and report guide](test-and-report.md) so the result is actionable.
