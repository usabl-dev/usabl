# Contributing to usabl

Thank you for your interest in usabl. Contributions of every size are welcome: a bug
report, a docs fix, a new check, or a review of someone else's change.

## Ways to contribute

- **Report a bug.** Open a [bug report](https://github.com/usabl-dev/usabl/issues/new?template=bug_report.yml).
  A wrong verdict, a missing gap, or a confusing message counts as a bug.
- **Propose a feature.** Open a [feature request](https://github.com/usabl-dev/usabl/issues/new?template=feature_request.yml)
  and describe the problem before the solution.
- **Improve the docs.** Fix a wrong step, an unclear sentence, or a broken link.
- **Fix an issue.** Comment on the issue first so two people do not solve the same
  problem in different ways.
- **Start small.** Issues labeled
  [`good first issue`](https://github.com/usabl-dev/usabl/labels/good%20first%20issue)
  are a good place to begin.

To ask a question, [open an issue](https://github.com/usabl-dev/usabl/issues/new/choose).
To report a security problem, do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Ground rules

- **One outcome per pull request.** If you can describe the change only with "and",
  split it.
- **Test first.** For a behavior change, write a test that fails, then make it pass.
  Show the failing run in the pull request.
- **Use the pull request template.** Fill in every section, including the AI assistance
  section.
- **Use Conventional Commits.** For example `fix: return focus to the trigger after close`
  or `docs: explain the evidence floor`.
- **License.** usabl is licensed under [Apache-2.0](LICENSE). By contributing, you agree
  that your contribution is licensed under the same terms (inbound equals outbound).
- **Code of Conduct.** Everyone who takes part follows the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## How review works

- Every pull request is reviewed and approved by the maintainer, @eparenti, who is the
  only code owner.
- CI must pass before a pull request can merge.
- The first CI run on a pull request from a fork waits until the maintainer approves it.
  This is a GitHub safeguard for first-time contributors, not a judgment of your change.

## Detailed guides

- **Contributing by hand:** [docs/guides/make-a-contribution.md](docs/guides/make-a-contribution.md)
  covers setup, the commands to run, the trust-critical paths, and what reviewers look for.
- **Contributing with an AI coding agent:** [AGENTS.md](AGENTS.md) holds the rules that
  Codex, Cursor, Copilot, Claude Code, and other agents read. The same rules apply to
  you.
