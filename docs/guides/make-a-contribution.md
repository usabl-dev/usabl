# Make a contribution

This guide takes you from a fork to a merged pull request when you write the change
yourself. If an AI coding agent writes the change, give it [AGENTS.md](../../AGENTS.md)
as well. The rules are the same.

Read [How usabl works](../how-usabl-works.html) before you change coverage, evidence,
verdicts, receipts, or product surfaces. Read the
[ground truth](../ground-truth.md) before you change behavior.

## 1. Choose one outcome

Start from an issue. State the outcome in one sentence.

Examples:

- The overlay explains `not_covered` without implying success.
- The keyboard walk reports a trap inside a nested dialog.
- The proof-loop guide names the command that failed.

If the sentence has two independent outcomes, split the work into two pull requests.
Comment on the issue to say you are taking it, how you will prove it, and any help you
need.

## 2. Set up the repository

You need Node.js 22, npm, Git, and Python 3 for pre-commit.

1. Fork `usabl-dev/usabl` on GitHub.
2. Clone your fork and install:

   ```bash
   git clone https://github.com/<your-user>/usabl.git
   cd usabl
   npm ci
   npx playwright install chromium
   ```

   On Linux, if Playwright reports missing system libraries, run
   `npx playwright install --with-deps chromium` instead.

3. Install pre-commit, then install the hooks:

   ```bash
   pip install pre-commit
   npm run prepare
   ```

   The repository uses `.pre-commit-config.yaml`. The hooks check whitespace, YAML,
   JSON, large files, private keys, leaked secrets (gitleaks), GitHub Actions syntax,
   Markdown and YAML formatting outside `docs/`, and the Conventional Commits message
   format. Without pre-commit, your commits skip these checks locally. CI runs the same
   hooks, so the problems show up later as a red pull request instead.

4. Create a branch named `type/short-description`, where the type is `fix`, `feat`,
   `docs`, `test`, or `chore`:

   ```bash
   git switch -c fix/overlay-not-covered-text
   ```

### Run your change against an app

To try your local engine in an app, build it and point the app at the folder:

```bash
npm run build
cd ../your-app
npm install --save-dev ../usabl
```

The [usabl-app](https://github.com/usabl-dev/usabl-app) sample app has known
accessibility barriers and is a good place to test.

## 3. Write the test first

For a behavior change, write a test that fails before you change the code. Run it and
keep the failing output. You will paste it into the pull request. Then make the change
and run the test again.

For a docs change, name the question the current text does not answer, and check that
your text answers it.

Never weaken an existing test to make your change pass. If a test is wrong, say why in
the pull request and fix it on its own.

## 4. Commands to know

| Command | What it does |
| --- | --- |
| `npm run check` | Typecheck, unit tests, build, and a package smoke test. Run it before every push. |
| `npm run test:integration` | Integration tests against a real Chromium. Run it when you change scanning, readiness, or the Playwright page check. |
| `npm run docs:linkcheck` | Checks every link in the docs and in the published pages. |
| `npm run docs:a11y` | Runs axe on every HTML page under `docs/` in a real Chromium. |
| `npm run docs:badges` | Checks that the README version badge matches `package.json`. |

CI runs all of these, plus gitleaks, pre-commit, and Semgrep.

## 5. Trust-critical paths

These paths are listed in `.github/CODEOWNERS`. A change to any of them can weaken the
gate, so it gets extra care:

- `src/gate/`: the only part of usabl that decides a verdict.
- `src/trust/`: the guard that stops a pull request from changing the policy it is
  checked against.
- `src/run.ts`: the sequencer that connects the guard, coverage, scan, and gate.
- `.github/workflows/` and `.github/CODEOWNERS`: CI and the list of approvers.
- `usabl.config.json`, `usabl.routes.json`, `usabl.docs.json`, `.usabl-evidence.json`,
  and `.usabl-waivers.json`: policy and accepted debt.

If you change one of these paths:

- Say so in the pull request summary, and say why the change is safe.
- Add a test that shows the gate still refuses what it refused before.
- Expect a slower, more detailed review.
- A policy file change makes usabl's own check on this repository return
  `approval_required`. That is expected. It clears only when a code owner who is not
  the author approves the current head commit.

## 6. Writing style

Every comment, message, doc, and commit follows the same rules:

- Plain English. Short sentences. Common words.
- No em dashes, and no doubled hyphens used as punctuation.
- No marketing words, praise, or slogans.
- A code comment says what the code does and why. It does not cite issue or pull
  request numbers. Describe the failure instead.

## 7. Commit

Use Conventional Commits:

```text
fix: restore modal focus after close
docs: explain the proof-loop setup
test: cover the fixed modal route
```

The commit body is two or three sentences on what changed and why.

## 8. Open the pull request

Push your branch to your fork and open a pull request against `main`. Fill in the
template:

- **Summary:** what changed and why. Name any trust-critical path you touched.
- **Test plan:** the exact commands you ran and what they printed, including the
  failing test run from step 3.
- **AI assistance:** if AI helped with any part of the change, keep the template text
  exactly as written. If no AI helped, replace it with one line that says so.

Link the issue. Add screenshots only when they prove visible behavior.

The first CI run on a pull request from a fork waits until the maintainer approves it.

### What reviewers look for

- One outcome, with a test that failed before and passes now.
- No new path to a false green. A result that reads as verified when it is not is the
  worst bug usabl can have.
- Page text treated as untrusted data.
- No timing or ordering dependence in anything that reaches the gate.
- No secrets in code, tests, fixtures, or output.
- Docs updated when behavior or commands change.

## Contributions without code

You can help without a branch:

- File a reproducible bug with the [test and report guide](test-and-report.md).
- Test an open pull request and report the exact result.
- Read the [usabl walkthrough](../usabl-walkthrough.html) as a first-time user and
  report what was unclear.
- Generate the accessible documentation page with `usabl docs --html` and review it
  for accuracy and accessibility.
