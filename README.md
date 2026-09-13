# usabl

![Version](https://img.shields.io/badge/version-0.2.1-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D22-blue?style=flat-square)
![Status](https://img.shields.io/badge/status-team%20preview-orange?style=flat-square)

**Don't ship until it's usabl.**

usabl checks changes to a web app's user interface for accessibility problems while the code is being written. It runs from the command line, a browser overlay, an AI coding assistant, and a pull request check, and all of them use the same engine.

When a check confirms a new problem that no waiver covers, usabl reports a regression. If you install the Claude Code or Cursor stop hook, it stops the assistant from finishing and tells it what to fix, with the exceptions listed under [Where it runs](#where-it-runs). If you make the usabl pull request check required, only people on your ruleset's bypass list can merge while the check fails. Problems that were already in the app are recorded and do not block, so you can add usabl to an existing app without fixing everything first.

Every result comes from repeatable checks. usabl calls no AI model. An AI assistant can suggest and apply fixes, but it cannot decide the result.

## What a result looks like

This is `usabl check` on a real PatternFly app, after a change removed the label from an icon-only button:

```text
usabl: ✖ REGRESSION (exit 1)
  This change adds an accessibility barrier. It is blocked until fixed.
  gate summary: regression: 3 blocking finding(s), 20 recorded
  barriers that block this run: 3 finding(s)
    [new] users · axe/button-name (critical): Ensure buttons have discernible text
        fix: Provide visible text, aria-label, or aria-labelledby. PatternFly icon-only buttons need an aria-label.
    [new] users · pf/pf-icon-button-name (serious): A button action is announced without a usable name.
        fix: Add visible text, aria-label, or aria-labelledby so the button has a stable name.
    [new] users · walk/keyboard-walk-unnamed-interactive (serious): An interactive element has no accessible name; screen-reader users hear only the role.
        fix: Add aria-label or visible text to the element.
  recorded, not blocking: 20 finding(s)
    usabl already recorded these. They do not block this run.
```

All three checks caught the same unnamed button. The 20 recorded problems were already in the app, so they do not block this change.

## How it works

- **Three checks.** On each app screen it scans, usabl runs axe-core for general accessibility rules, PatternFly rules for problems in how PatternFly components are put together, and a keyboard walk. The walk tabs through the page and records the name, role, and state at each stop from the browser's accessibility tree. That is an approximation of what a screen reader says. usabl does not run a real screen reader. Documentation pages skip the PatternFly rules.
- **The screens it can map from a change.** usabl maps changed files to screens using your routes, your imports, the screens you map by hand, and files that affect every screen. If it maps a screen but cannot load it, it reports that screen as not covered. A screen it cannot map is not checked, so keep your mappings current.
- **Existing problems are recorded.** `usabl baseline` records the problems it finds in an evidence floor file, `.usabl-evidence.json`, by screen, rule, and element, with a count. A problem blocks when it is new, or when there are more of it than the floor records. After you fix recorded problems, run `usabl floor prune` so they block if they come back.
- **Exceptions expire.** A waiver in `.usabl-waivers.json` covers one element, or every element, for one rule on one screen. Each waiver names an owner, an approver, a reason, and an expiration date. After that date the waiver stops applying, and the problem blocks again unless the evidence floor records it. Waived problems still appear in the result.
- **The rules are protected.** Policy files are `usabl.config.json`, `usabl.routes.json`, `usabl.docs.json`, the evidence floor, the waivers, your design requirements file if you have one, and any paths you list in `guardedPaths`. A change to any of them returns approval required. In CI, a code owner other than the pull request author must approve it, and the check reads policy from the base branch, so a pull request cannot change the rules it is checked against.
- **Page text is treated as data.** Text from the page can reach an AI assistant, so usabl wraps it in a labeled frame that marks it as untrusted. It removes frame markers from the page text so a page cannot close the frame, strips control sequences, and redacts values that look like credentials.
- **Documentation too.** With a `usabl.docs.json` manifest, the same run also checks your published documentation pages, using rules chosen for docs.

## Results

| Result            | Exit code | Meaning                                                                                                                                                            |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verified          | 0         | No new problem blocks on the screens usabl mapped from this change, and it checked all of them. New problems covered by a waiver can still appear.                 |
| Regression        | 1         | A check confirmed a new problem that no waiver covers.                                                                                                             |
| Approval required | 2         | The change edits policy files, so a code owner has to approve it. This result takes priority over the others.                                                      |
| Not covered       | 3         | usabl could not check a screen it mapped from this change, for example because the page did not load, or a check could not reach a firm answer. It does not guess. |

Two outcomes carry no verdict, and neither one is a pass:

- **Idle** (exit 0): no changed file maps to a screen or documentation page that usabl checks, so there was nothing to check.
- **No verdict** (exit 4): the run could not finish, for example after an unexpected error or when every affected screen failed to render.

Three configuration problems are handled differently. If `usabl.config.json` cannot be read, the command prints the error and exits 4 before anything runs, with no result. In a CI run that reads policy from the base branch, if your config differs from the base branch and the base branch copy is missing or broken, the run returns approval required and reports the accessibility part as not covered. If usabl cannot read the base branch it compares policy against, the run returns no verdict.

[Ground truth](docs/ground-truth.md#9-gate-verdict-authority) explains how the gate decides.

## Receipts

When `usabl check` or the stop hook finishes with a verified result, it writes a receipt to `.usabl/receipt.json`. The receipt records what was checked and the result. Four of its values tie it to your code:

- the source tree, as a Git tree hash of your tracked files and any untracked files Git does not ignore, including uncommitted changes
- a hash of the committed policy files
- the usabl engine version, which includes a hash of the engine's own files
- the versions of axe-core, Playwright, and Chromium

To check a receipt, usabl rebuilds the tree hash from your current files, recomputes the policy hash, and compares all four values with the receipt. If any value differs, the receipt does not match.

The stop hook uses this to avoid scanning twice. When the assistant tries to finish and no policy file has uncommitted changes, the hook checks the receipt first. If it matches, the assistant finishes without a new scan. If it does not match, or a policy file has changed, the hook continues with its normal behavior, described under [Where it runs](#where-it-runs).

## Where it runs

- **Command line.** `usabl check` prints the result and returns its exit code, so any script can act on it.
- **Browser overlay.** `usabl install --overlay` adds the overlay plugin to your Vite config. It shows the current result on the page while you work. The overlay only shows results and never blocks anything. It runs inside your page, so the page's own code can affect what it shows.
- **Claude Code.** `usabl install --claude` adds a stop hook to `.claude/settings.json`. When the assistant tries to finish on a regression, not covered, or approval required result, the hook blocks that first attempt and tells the assistant why. It lets the next attempt through, so the assistant cannot get stuck in a loop. A person can run `usabl bypass` to let one stop through without checking. If the hook itself fails, it lets the assistant stop and says so. `usabl install --claude-skill` adds the `/usabl-check` and `/usabl-fix` skills.
- **Cursor.** `usabl install --cursor` adds a stop hook that sends the agent back when the result blocks, a `/usabl-check` command, and a rule that reminds the agent to check its UI changes. Like the Claude Code hook, it lets the agent stop after one follow-up.
- **Pull requests.** `usabl install --ci` drafts `.github/workflows/usabl-gate.yml`. Before it can run, replace the placeholder with a usabl commit you trust, and add a `USABL_ENGINE_CHECKOUT_TOKEN` secret that can read the usabl repository. The workflow runs the check, comments on the pull request, and reports the `usabl-required` status. To block merges, make that status required in your branch rules. `usabl install --branch-rule` checks your rules and changes nothing. People on your ruleset's bypass list can still merge. `usabl install --docs-ci` drafts a separate workflow for documentation pages.
- **Playwright tests.** `checkPage(page)` from `usabl/playwright` runs the core checks on one page inside your own tests. It does not use the evidence floor, waivers, or checks from design requirements, so its result can differ from `usabl check`.

## Try it on your app

usabl needs Node.js 22. It is not on npm yet, so build it next to your app:

```bash
git clone https://github.com/usabl-dev/usabl.git
cd usabl
npm ci
npm run build
npx playwright install chromium
```

Add it to your app and draft your configuration:

```bash
cd ../your-app
npm install --save-dev file:../usabl
npx usabl init       # drafts usabl.config.json and usabl.routes.json from your code
```

Review both drafts, correct any screen mappings, and commit them. `usabl baseline` refuses to run while other policy files have uncommitted changes. Then start your app's dev server and record the problems that are already there:

```bash
npx usabl baseline   # scans every mapped screen and drafts .usabl-evidence.json
```

Review the evidence floor and commit it too, because usabl does not trust policy files with uncommitted changes. If `usabl baseline` says coverage is incomplete, fix the mappings, or run `usabl baseline --partial` to record only the screens it scanned without a coverage gap.

Now make a UI change and check it, confirm the setup, and set up each place you want usabl to run, one per command:

```bash
npx usabl check
npx usabl doctor
npx usabl install --claude
```

Each `install` writes a new file, updates a file it can safely change, reports that it is already set up, or refuses and prints the manual step. `--branch-rule` only checks. Review what changed before you commit.

A small `usabl.config.json` looks like this:

```json
{
  "appBaseUrl": "http://localhost:5173",
  "uiFileGlobs": ["src/**"],
  "discovery": {
    "routerFile": "src/App.tsx",
    "wideBlastGlobs": ["src/main.tsx", "src/index.css"]
  },
  "surfaces": [
    {
      "id": "users",
      "url": "http://localhost:5173/users",
      "files": ["src/pages/UsersPage.tsx"]
    }
  ],
  "guardedPaths": []
}
```

- `appBaseUrl` is where your dev server runs.
- `uiFileGlobs` says which files count as UI code.
- `discovery.routerFile` is your router. `usabl init` reads it to draft `usabl.routes.json`, and usabl uses that file when it exists. `wideBlastGlobs` lists files that affect every screen, such as global CSS or the app shell.
- `surfaces` lists screens you map by hand. Each one lists the exact file paths that screen depends on. If a surface has the same id as a route in `usabl.routes.json`, add `"overridesDiscoveredRoute": true` to it.
- `guardedPaths` adds more files to treat as policy.

## Apps behind a login

usabl scans signed out unless you give it a session. Save a [Playwright storage state](https://playwright.dev/docs/auth) file and point `USABL_STORAGE_STATE` at it:

```bash
export USABL_STORAGE_STATE="$HOME/.usabl/my-app-session.json"
npx usabl doctor   # confirms a session is configured
npx usabl check
```

The command line, the overlay, and the stop hook all read this variable. The file holds live cookies and tokens, so usabl never writes its path or contents into its config, evidence files, or output.

If the file cannot be read, is not JSON, or has clearly expired, usabl stops before it opens a browser and returns no verdict. A session can also end in ways the file does not show. When that happens during a scan, usabl reports the screen as not covered instead of scoring your sign-in page. It watches for 401 responses from your app, a password field on the page, or a browser that ended up on another page asking for a password. It can miss a sign-in page that makes no requests and shows no password field, such as a passkey prompt.

To confirm the right screen loaded, add a `reachedWhen` CSS selector to the surface. Pick something only that screen has, such as its own table or heading, because a selector for the header or navigation also matches the sign-in page.

Do not put a password or token in a surface URL. usabl prints surface URLs in its output.

[Ground truth](docs/ground-truth.md#limits-of-detecting-that-a-screen-was-not-reached-signed-in) lists exactly what usabl detects and what it misses.

## Commands

Only the gate decides a result. The commands that scan run the gate, and the other commands draft files, report, or show a result.

| Command                               | What it does                                                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usabl check`                         | Checks the screens usabl maps from your change and returns a result. This is the default command. `--self-check` prints a short advisory summary for an AI assistant and exits 0 once it has a result.                                       |
| `usabl init`                          | Drafts `usabl.config.json` and `usabl.routes.json` from your code.                                                                                                                                                                           |
| `usabl baseline`                      | Scans every mapped screen and drafts the evidence floor.                                                                                                                                                                                     |
| `usabl install --<target>`            | Sets up one place usabl runs: `--overlay`, `--claude`, `--claude-skill`, `--cursor`, `--ci`, `--docs-ci`, or `--branch-rule`.                                                                                                                |
| `usabl doctor`                        | Reports what is set up, missing, or out of date, including the login session. It changes nothing.                                                                                                                                            |
| `usabl floor prune`                   | Scans again, then removes fixed problems from the evidence floor and lowers counts, so problems block if they come back. It keeps entries for screens it could not check.                                                                    |
| `usabl drift routes`                  | Reports differences between `usabl.routes.json` and your router.                                                                                                                                                                             |
| `usabl docs`                          | Writes the name, role, and state at each keyboard stop on each checked screen, as JSON or, with `--html`, as one accessible page. With design requirements, it also writes an alt text list. It always exits 0 and does not decide a result. |
| `usabl comment`                       | Turns a result from standard input into a pull request comment.                                                                                                                                                                              |
| `usabl enforce accessibility\|policy` | Reads a result from standard input and returns the CI check status. It does not rerun the checks.                                                                                                                                            |
| `usabl stop-hook`                     | The entry point that the assistant stop hooks call.                                                                                                                                                                                          |
| `usabl bypass`                        | Lets the assistant's next stop through once, without checking.                                                                                                                                                                               |

## What usabl does not do

- It does not claim an app is accessible or compliant. Its checks follow WCAG 2.2 AA, and some problems need a person to judge.
- It does not replace expert audits or testing with people who use assistive technology.
- The voicing check, which predicts screen reader output from the accessibility tree, is built but not part of the result yet. It is planned for v0.3.0.
- The fleet insights script scans a list of URLs for measurement. It never decides a result.

## Learn more

- [Team orientation](https://usabl-dev.github.io/usabl/team-orientation.html): start here.
- [How usabl works](https://usabl-dev.github.io/usabl/how-usabl-works.html): results, the trust model, and where usabl runs.
- [Code walkthrough](https://usabl-dev.github.io/usabl/code-walkthrough.html): the source in the order it runs.
- [Team demo](https://github.com/usabl-dev/usabl-app/blob/main/README.md): a hands-on walkthrough on a small PatternFly app that takes about 20 minutes.
- [Ground truth](docs/ground-truth.md): the design, contracts, and documented limits.

## Status

Team preview, version 0.2.1. This version is not tagged or published to npm. See [CHANGELOG.md](CHANGELOG.md) for changes since 0.1.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, commit style, and how pull requests are reviewed. Developers add new checks by implementing the provider interface. A check returns draft findings, and only the gate turns findings into a result.

## License

Apache License 2.0. See [LICENSE](LICENSE).

---

**Don't ship until it's usabl.**
