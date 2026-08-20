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
3. `npm run check`

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
