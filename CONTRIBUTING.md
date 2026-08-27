# Contributing to usabl

Thanks for helping build usabl, accessibility proof built into how teams ship software.

The product name is **usabl** (lowercase). Pronounced "usable."

## Getting started

You need Node.js 22 and [pre-commit](https://pre-commit.com/).

```bash
git clone https://github.com/usabl-dev/usabl.git
cd usabl
pip install pre-commit
npm install
```

`npm install` runs `prepare`, which installs the team's git hooks into `.git/hooks`. Every clone does this. The tracked source of truth is `.pre-commit-config.yaml`.

If `pre-commit` is missing, install it and run `npm install` again. Do not skip hooks with `--no-verify`. CI still runs the same checks and will block merge.

Create a branch from current `main`. Open a pull request against `main`.

## Build

The suggested build is tsup through npm, targeting Node 22, ESM, with types. It writes `dist/` for the library and the `usabl` CLI.

```bash
npm run build
```

Do not add another bundler. Typecheck and tests are `npm run check`. Write a failing test first, then the code that makes it true.

## How we build

A human owns product and UX. Ask before pushing a branch and before merging a pull request.

Implementation, review, and security review use **three different model families**. The family that writes the patch does not review it, does not own the merge security gate, and does not grade its own work. For example: Codex implements, Opus reviews, Gemini does security review.

- **Implement** with one family. TDD. Commit. Report. Do not push. Do not freelance product language.
- **Review** with a second family after every task. Correctness, honesty (providers return drafts, the gate is the only verdict), and would you staff this. That family does not write the product code in review.
- **Security review** with a third family on every pull request versus `main` before merge. Independent of the code review. Do not merge on Critical or Important findings. Do not paste that review into the pull request.

CI green does not skip review or security review. Other teammates should use this split even if they pick different families than the example.

## Commits

usabl uses [Conventional Commits](https://www.conventionalcommits.org/). The commit-msg hook enforces the subject line.

```
type(scope): short description
```

Examples:

```
feat: add screen-reader announcement check
fix(ci): validate workflow on pull requests
docs: clarify contributing workflow
```

Do not add `Co-authored-by` trailers for AI tools.

## Local checks

On every commit, hooks run:

- file hygiene (whitespace, EOF, merge conflicts, private keys)
- gitleaks on staged changes
- YAML and JSON syntax
- GitHub Actions workflow linting
- Markdown and YAML formatting (not `docs/`, which is product prose)
- conventional commit messages

Run the same file hooks on the tree:

```bash
pre-commit run --all-files
```

Typecheck and tests (this is also CI):

```bash
npm run check
```

Scan git history for secrets (this is also CI):

```bash
gitleaks detect --verbose --redact --exit-code 1
```

Static analysis (this is also CI):

```bash
semgrep scan --config p/typescript --config p/javascript --config p/github-actions --config p/security-audit --error
```

## Pull requests

- Open PRs against `main`. Direct pushes to `main` are blocked.
- Squash-merge only. The branch must be up to date with `main`.
- The GitHub Actions check named **`check`** must be green. That is a ruleset requirement, including for admins.
- Use the pull request template. Fill in **Summary** and **Test plan**.
- Leave the **AI assistance** note in place if AI tools helped create or edit the changes.
- Prefer small, focused PRs.

## CI

Pull requests and pushes to `main` run the `usabl` workflow. The required status check name is **`check`**.

CI runs, in order:

1. gitleaks on git history
2. the pre-commit suite (the staged-only gitleaks hook is skipped here; step 1 is the history scan)
3. Semgrep (`p/typescript`, `p/javascript`, `p/github-actions`, `p/security-audit`)
4. `npm run check`

## Code owners

These paths list owners in `.github/CODEOWNERS`:

- `.github/workflows/usabl.yml`
- `.github/CODEOWNERS`

Owners: `@usabl-dev/eparenti`, `@usabl-dev/nitin-dhevar`, `@usabl-dev/vishsanghishetty`.

Code-owner review is not a merge requirement unless the repository ruleset says so.

## Security

- Do not commit secrets, tokens, or credentials.
- Do not add `Co-authored-by` trailers for AI tools to commits.
- Pass GitHub event values through `env:` in workflow scripts, not inline in shell commands.

## Questions

Open a discussion or talk to the team before large design changes.

## Team preview

Start with the [team orientation](docs/team-orientation.html) for the product model,
workspace map, guided demo, contribution lanes, and three-week finish plan. See
[docs/team-preview.md](docs/team-preview.md) for the compact technical runbook.
