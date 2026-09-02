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

A human owns product and UX, and is asked before a branch is pushed and before a pull request is merged.

Work runs in three independent lanes: implement, review, and security review. The lane that writes a change does not review it, does not own the merge security gate, and does not grade its own work.

- **Implement** in the first lane. TDD. Commit. Report. Do not push. Do not freelance product language.
- **Review** in a second lane after every task. It covers correctness, honesty (generators return drafts, the gate is the only verdict), and "would you staff this." The lane that wrote the change does not review it.
- **Security review** in a third lane. It is independent of the code review, runs on every pull request against `main` before merge, and is not pasted into the pull request. Do not merge on Critical or Important findings.

CI being green does not replace review or security review.

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

- `src/trust/`
- `src/gate/`
- `src/run.ts`
- `usabl.config.json`
- `.github/workflows/`
- `.github/CODEOWNERS`
- `.usabl-evidence.json`
- `.usabl-waivers.json`
- `usabl.docs.json`
- `usabl.routes.json`

Owners: `@eparenti`, `@nitin-dhevar`, `@vishsanghishetty`.

Individual logins, never org teams. The usabl-dev org has no teams, so a
`@usabl-dev/<name>` reference resolves to nobody and routes no review, and
`usabl enforce policy` refuses a CODEOWNERS file that names one.

Code owner review is a merge requirement: the `main` ruleset requires it, and
`usabl-policy` is a required status that refuses any guarded path without an owner
approval of the current head.

## Security

- Do not commit secrets, tokens, or credentials.
- Do not add `Co-authored-by` trailers for AI tools to commits.
- Pass GitHub event values through `env:` in workflow scripts, not inline in shell commands.

## Questions

Open a discussion or talk to the team before large design changes.

## Team preview

Start with the [team orientation](docs/team-orientation.html) for the product model,
the workspace map, the adoption commands, the contribution lanes, and the team
handoff. See [docs/team-preview.md](docs/team-preview.md) for the compact technical
runbook.
