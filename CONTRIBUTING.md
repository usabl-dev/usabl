# Contributing to usabl

Thanks for helping build usabl, accessibility proof built into how teams ship software.

## Getting started

1. Clone the repository.
2. Create a branch from `main`.
3. Make your changes.
4. Open a pull request.

```bash
git clone https://github.com/usabl-dev/usabl.git
cd usabl
```

## Pull requests

- Open PRs against `main`. Direct pushes to `main` are blocked.
- Squash-merge only. The branch must be up to date with `main`.
- The GitHub Actions check named **`check`** must be green. That is a ruleset requirement, including for admins.
- Use the pull request template. Fill in **Summary** and **Test plan** before requesting review.
- Leave the **AI assistance** note in place if AI tools helped create or edit the changes.
- Prefer small, focused PRs when you can.

## Commits

usabl uses [Conventional Commits](https://www.conventionalcommits.org/).

```
type(scope): short description
```

Examples:

```
feat: add screen-reader announcement check
fix(ci): validate workflow on pull requests
docs: clarify contributing workflow
```

Do not add `Co-authored-by` trailers for AI tools. The commit-msg hook strips the known editor-agent trailer if one is injected.

## Local checks

Install [pre-commit](https://pre-commit.com/) once per clone:

```bash
pip install pre-commit
pre-commit install
pre-commit install --hook-type commit-msg
```

If this clone sets `core.hooksPath` to `.githooks`, keep the wrappers in that directory. They call the same config. Do not use `--no-verify` to skip them.

Hooks run on commit and check:

- file hygiene (whitespace, EOF, merge conflicts, private keys)
- gitleaks (staged secrets)
- YAML/JSON syntax
- GitHub Actions workflow linting
- Markdown/YAML formatting
- conventional commit messages
- AI co-author trailer strip

Run manually on all files:

```bash
pre-commit run --all-files
```

Run gitleaks against git history (this is what CI does):

```bash
gitleaks detect --verbose --redact --exit-code 1
```

## Code owners

Changes to these files require review from a code owner when that protection is enabled:

- `.github/workflows/usabl.yml`
- `.github/CODEOWNERS`

Current owners: `@usabl-dev/eparenti`, `@usabl-dev/nitin-dhevar`, `@usabl-dev/vishsanghishetty`.

Code-owner review is **not** a merge requirement today (solo shipping). The files are still owned.

## CI

Pull requests run the `usabl` GitHub Actions workflow. The required status check name is **`check`**.

CI runs gitleaks on git history, the pre-commit suite (except the staged-only gitleaks hook), then `npm run check`.

## Security

- Do not commit secrets, tokens, or credentials.
- Do not add `Co-authored-by` trailers for AI tools to commits.
- Pass GitHub event values through `env:` in workflow scripts, not inline in shell commands.

## Questions

Open a discussion or talk to the team in your usual channel before large design changes.
