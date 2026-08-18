# Contributing to Usabl

Thanks for helping build Usabl — accessibility proof built into how teams ship software.

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

- Open PRs against `main`.
- Use the pull request template. Fill in **Summary** and **Test plan** before requesting review.
- Leave the **AI assistance** note in place if AI tools helped create or edit the changes.
- Prefer small, focused PRs when you can.

## Commits

Usabl uses [Conventional Commits](https://www.conventionalcommits.org/).

```
type(scope): short description
```

Examples:

```
feat: add screen-reader announcement check
fix(ci): validate workflow on pull requests
docs: clarify contributing workflow
```

## Local checks

Install [pre-commit](https://pre-commit.com/) once per clone:

```bash
pip install pre-commit
pre-commit install
pre-commit install --hook-type commit-msg
```

Hooks run on commit and check:

- file hygiene (whitespace, EOF, merge conflicts, secrets)
- YAML/JSON syntax
- GitHub Actions workflow linting
- Markdown/YAML formatting
- conventional commit messages

Run manually on all files:

```bash
pre-commit run --all-files
```

## Code owners

Changes to these files require review from a code owner:

- `.github/workflows/usabl.yml`
- `.github/CODEOWNERS`

Current owners: `@usabl-dev/eparenti`, `@usabl-dev/nitin-dhevar`, `@usabl-dev/vishsanghishetty`.

## CI

Pull requests run the `usabl` GitHub Actions workflow. The required status check name is **`usabl / accessibility`**.

## Security

- Do not commit secrets, tokens, or credentials.
- Do not add `Co-authored-by` trailers for AI tools to commits.
- Pass GitHub event values through `env:` in workflow scripts, not inline in shell commands.

## Questions

Open a discussion or talk to the team in your usual channel before large design changes.
