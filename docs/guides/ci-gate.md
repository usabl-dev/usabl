# Set up the CI gate

`usabl install --ci` writes two GitHub Actions workflows into your app:

- `.github/workflows/usabl-gate.yml`, the pull request gate. Its `usabl-required` job is
  the check to require on your protected branch.
- `.github/workflows/usabl-history.yml`, which scans your default branch after each merge
  and once a day and records what it saw on a `usabl/history` branch.

Run it from your app's root, after `usabl init` has written `usabl.config.json`:

```bash
npx usabl install --ci
```

It writes a file when it is absent, or fills the pin when the file is this version's
unedited draft. It never overwrites a workflow you edited; it says where the file differs
and stops with exit 2.

For a repository of rendered documentation, `npx usabl install --docs-ci` writes
`.github/workflows/usabl-docs-gate.yml` the same way. It takes the default branch the same
way too.

## What it fills in for you

**The engine pin.** Each workflow builds the usabl engine from the public
`usabl-dev/usabl` repository at one commit. The build of usabl records the commit it was
built from in `dist/build-info.json`, and `install --ci` writes that commit into the
`usabl-engine` job. It uses only a full 40-character commit SHA from a clean tree, never a
branch or a tag.

When the record has no such commit, the pin stays the placeholder
`PIN_TO_A_TRUSTED_USABL_COMMIT`. That happens when usabl was built outside git, or from a
tree with uncommitted or untracked changes. The command says which, and names the line to
edit in each file. A release cannot ship that way: `prepublishOnly` fails unless the record
holds a full commit SHA and `clean: true`. Until the line holds a commit, the engine checkout fails and the gate
blocks. The same is true of a commit that cannot be fetched from `usabl-dev/usabl`: the gate fails
closed, never open.

`install --ci` never moves a pin someone already chose. If the workflow is the usabl draft
pinned to another commit, it reports that commit and changes nothing. It writes a file when
it is absent, or fills the pin when the file is this version's unedited draft.

**The default branch.** The gate and the docs gate run on pull requests into your default
branch, and the history workflow runs on pushes to it. The command reads its name from git
(`refs/remotes/origin/HEAD`, which a clone sets), writes it quoted into each trigger, and says
which branch it wrote. If git cannot name it, or the name has a character other than
letters, digits, `.`, `_`, `-`, or `/`, the command writes `main` and prints one step that
names the line to change in each file, if your default branch has another name. Running the
command again keeps the branch each file already names. After install, the branch in each
file is the one that counts. Nothing else in the files changes with the branch.

The branch filter applies to the `pull_request` event. The gate also runs on
`pull_request_review`, and GitHub takes no branch filter on that event, so a review on a pull
request into any branch starts the gate. On a review the gate does not build the app. It
looks for the `pull_request` run that built this exact pull request, head, and base. A pull
request into another branch normally has no such run, so the gate fails closed and
`usabl-required` reports red on it. That red check blocks nothing on a branch that does not
require it.

When the files name different branches, for example a gate on `main` and a history workflow
on `trunk`, the command prints one step that names each file and its branch. It does not
change a file to make them agree.

**A repository named usabl.** The app gate's build job and the history scan place the engine
at `../usabl`, for an app whose lockfile installs usabl from `file:../usabl`. GitHub checks a
repository out into `<name>/<name>`, so in a repository named usabl, `../usabl` is the
checkout itself. The step then prints one line and skips the unpack, so the engine is never
unpacked over your code. An app that installs usabl from `file:../usabl` cannot build in a
repository named usabl, and the line says so: rename the repository to fix it. An app that
does not install usabl from that path needs no change.

**No secrets.** The engine repository is public, so no job needs a token to fetch it. The
only token any job reads is the run's own `GITHUB_TOKEN`. A pull request from a fork runs
the gate the same way. A fork cannot write to its pull request, so its usabl comment
appears in the run summary instead.

**The app's port.** Neither workflow assumes a port. The judge serves the built app on the
origin of `appBaseUrl` in `usabl.config.json` at the base commit. The history scan reads
`appBaseUrl` from the default branch and starts `npm run dev -- --host <host> --port <port>` on it.
`appBaseUrl` must be an http address on loopback (`127.0.0.1`, `localhost`, or `[::1]`)
with an explicit port, or the job stops with a message that says what is wrong.

`install --ci` reads the same value to tell you what it found. Before `usabl init` has run,
it reads the port from your app instead: a `--port` in the `dev` script, then
`server.port` in the Vite config, then `devServer.port` in the webpack dev config. On
patternfly-react-seed it reads 9000 from `webpack.dev.js`. It does not run any of these
files, so a port set by code is not read; the step it prints then lists every place it
looked.

## The steps it prints

The command ends with a numbered list of the steps still needed. When the pin is filled,
`appBaseUrl` can be read, and `package.json` has a `dev` script, the list is:

1. Merge `usabl.config.json` (and `usabl.routes.json` when you use it) to your default
   branch first, in their own pull request. The judge reads them at the base commit of each
   pull request, so a pull request that adds them together with the workflows cannot pass.
   For `install --docs-ci` the files are `usabl.config.json` and `usabl.docs.json` (and
   `usabl.routes.json` when you use it).
2. Review and commit the two workflow files.
3. Add the branch rule. `usabl install --branch-rule` prints the `CODEOWNERS` lines and
   the branch setting, then checks them when you run it again.
4. Open a pull request.

The command leaves out step 1 only when git shows that your default branch already holds
the same bytes of those files as your working tree. When it cannot find the default branch,
or git cannot answer, it prints the step.

Each other thing the run could not settle adds one step in front: pin the engine, run
`usabl init` and set `appBaseUrl`, add a `dev` script for the history scan, check the
branch name the workflows run on, or make the workflows name the same branch. The `dev` script must start the server directly
and accept `--host` and `--port`, for example `webpack serve --config webpack.dev.js`. A
script that calls another npm script, such as `npm run start:dev`, does not pass them on.

The branch rule matters. Any pull request runs the workflow as that pull request changed
it, so a pull request that edits `.github/workflows/` can make `usabl-required` pass. Code
owner review on `.github/workflows/` is what stops it.

`usabl install --branch-rule` and `usabl doctor` check the protection on the branch the gate
workflow names in its trigger. They take the trigger only when the lines usabl writes under the
top-level `on:` and a YAML reading of the whole file name the same one branch. Text shaped like
a trigger elsewhere in the file, such as in a `run-name: |` block or a quoted value, is not read.
A file YAML cannot read, a file that holds U+0085, U+2028 or U+2029 anywhere (even in a comment),
and a file with a top-level `true:`, `yes:`, `y:` or `On:` key (a YAML 1.1 reader reads each as
`on:`) are each a trigger usabl cannot read.
A documentation repository with only the docs gate is checked on the branch the docs gate
names, and the advice names `usabl install --docs-ci`.

With no gate workflow, a trigger usabl cannot read, or a gate file it cannot read (a folder,
or a file it has no permission to read), they check `main` and say in each line that they
assumed it. A check on an assumed `main` passes only when there is no gate file and GitHub
reports `main` as the default branch. When GitHub reports another default branch, or cannot
say which one it is, the check is not verified and exits 2: it names both branches when it
can, and the next step.

A branch a gate names passes only when GitHub reports that branch as the default branch. When
GitHub reports another one, pull requests into the default branch are not gated. When usabl
cannot read GitHub's default branch (the read failed, or its answer named no plain branch),
usabl cannot confirm that pull requests into it are gated. In both cases
`usabl install --branch-rule` exits 2 with "cannot verify", even when the branch the gate
names is fully protected, so a setup script that reads only the exit code does not pass. The
first line says what usabl knows about the default branch, and whether the branch rule on the
gate's branch is set. The next lines say what that protection reads, which line of the gate
file to change (the line in the file on disk), and how to gate both branches instead. When the
docs gate runs on the default branch and the app gate does not, it says the app's pull
requests into the default branch are not gated. `usabl doctor` reports the same facts and the
same next step. Its branch protection line is never wired then: it is drifted when the gate's
branch is protected and GitHub reports another default branch, unknown when it is protected
and usabl cannot read the default branch, missing when it is not protected, and unknown when
usabl cannot read its protection.

The table shows each case with the branch usabl checks fully protected. "The gate" is the app
gate, or the docs gate when there is no app gate. When a part of the protection is off,
`usabl install --branch-rule` says "not applied" (exit 2) and `usabl doctor` says missing,
with two exceptions. In the second and third rows, install says "cannot verify" instead,
whatever the protection reads, and doctor still says missing. When usabl assumed `main` and
GitHub reports another default branch (the fifth row, and the last row in that case), usabl
does not use the protection on `main`, so both say what the row says.

| What usabl reads                                                   | `usabl install --branch-rule`          | `usabl doctor` branch protection |
| ------------------------------------------------------------------ | -------------------------------------- | -------------------------------- |
| The gate names GitHub's default branch                             | exit 0, verified                       | wired                            |
| The gate names a branch that is not the default                    | exit 2, cannot verify                  | drifted                          |
| The gate names a branch, and usabl cannot read the default branch  | exit 2, cannot verify                  | unknown                          |
| No gate file, and GitHub reports `main` as the default             | exit 0, verified (`main` assumed)      | wired                            |
| No gate file, and GitHub reports another default branch            | exit 2, cannot verify (`main` assumed) | unknown                          |
| No gate file, and usabl cannot read the default branch             | exit 2, cannot verify (`main` assumed) | unknown                          |
| A folder, an unreadable file, or a trigger usabl cannot read       | exit 2, cannot verify (`main` assumed) | unknown                          |

## After an earlier 0.3.0 build

An earlier build of 0.3.0 wrote the gates with `branches: [main]` in the trigger, unquoted,
and with some comments and step names that said "main". This version does not read those
files as its own draft, so `usabl doctor` reports them as drifted. Run `usabl install --ci`
again (and `usabl install --docs-ci` if you use the docs gate). When a file is that earlier
draft with no edits, the command rewrites it to this draft, keeps the engine pin it held if
it held one, and says so. An earlier gate, which could only name `main`, gets the default
branch git names. When that is not `main`, the rewrite line says the trigger moved, from
`main` to which branch, and which line to change to put `main` back. Check it: git records
the default branch when you clone, and does not update it when a team renames the branch.
Review the change and commit it; it is only on disk until you do. A file you edited is still
refused: reconcile it by hand.

## Settings you may need

- `USABL_APP_BUILD_COMMAND` and `USABL_APP_BUILD_DIR`, repository variables, when your app
  does not build with `npm run build` into `dist`.
- The history workflow's `history-append` job needs `contents: write`. If you cannot grant
  it, leave `usabl-history.yml` out; every run then says tracking is off.

## When the keyboard walk is cut short

A screen is not covered when its keyboard walk stopped before the end of the page. The gap
starts `on screen <id>, the keyboard walk was cut short` and says why and what to do:

- **It reached its limit of presses of Tab, or ran out of its time budget.** A long table page
  has more stops than the default of 200, or takes longer than 15 seconds. A press of Tab inside a
  region the walk cannot read counts toward the limit but is not a new stop, so the gap names both
  numbers. Raise the budget for that screen in `usabl.config.json`, up to 2000 presses and
  300000 ms:

  ```json
  "keyboardWalk": { "perSurface": { "jobs": { "tabCap": 600, "wallClockMs": 60000 } } }
  ```

  In a Playwright test, pass the `tabCap` or `wallClockMs` option of `checkPage`. Or split the
  screen so its focus order fits one walk.
- **Focus went back to a control it had reached, or stayed in an open modal dialog.** Fix the
  keyboard trap, or point the screen at a state with no dialog open and check the dialog on a
  screen of its own.
- **A script moved focus to the body, or one more Tab did not confirm the end.** Find the script
  that blurs a control or stops the Tab key. A control inside a closed shadow root or a frame
  that blurs itself gives this gap too.
- **Focus did not leave a region the walk cannot read, or went back into one.** The walk presses
  Tab at most 100 times inside one region. That bound is fixed, so a region with 100 or more
  controls always cuts the walk short, even when it is listed. Check it by hand. Focus that goes
  back into a region after other stops, such as content slotted into a closed shadow root between
  its own controls, is cut short too. The walk cannot tell that from a keyboard trap, so it
  reports no trap. A host element with a `tabindex` whose closed shadow root holds controls cuts
  the walk short the same way, listed or not. Use an open shadow root, or remove the `tabindex`
  from the host so Tab goes straight to the controls inside it.

Each fix to `usabl.config.json` is a change to a guarded file, so the pull request needs
approval, and in CI the gate reads the trusted copy.

A floor written by an older version can hold a `keyboard-walk-truncated` entry. The run then
reports a gap on `.usabl-evidence.json` that names the screens. Run `usabl baseline` (or
`usabl baseline --partial` while a screen is still not covered) to rewrite the floor without it.

## When the keyboard walk cannot read a region

A closed shadow root or a frame from another origin hides its controls from the walk. The walk
goes on past it, and the screen gets a gap that names the region, such as `a frame from
https://chat.example.com`. Check the controls inside by hand. To let usabl walk them, use an open
shadow root or a frame from the same origin. If the team accepts that the region is not checked,
list it for that screen, using the line the gap gives:

```json
"keyboardWalk": { "perSurface": { "support": { "unreadableRegions": [{ "frameOrigin": "https://chat.example.com" }] } } }
```

A listed region is a known limit, not a gap. Every result of a scan says `with known limits` and
lists the region. A stop that the stop hook allows from a stored receipt does not scan, and a
receipt records no known limits, so that line says plain `VERIFIED (exit 0, stored receipt, not
re-scanned)` and says to run `usabl check` to see them. One listing line covers every region with
that name on the screen. In CI the gate reads the listing from the trusted ref. `checkPage` reads
it from the working tree, also in CI, so a pull request's own Playwright test sees a listing the
pull request adds, and the gate still asks for approval. A listing that matched no region on a
full walk is reported, so remove or correct it.

## What has been proven

The pin fill, the port read, the branch read, and the printed steps are covered by unit
tests. The package smoke test installs the packed usabl and runs `install --ci` from it, and
checks that the written pin matches the build record. The gate an earlier 0.3.0 build wrote
ran with no hand edits on a GitHub runner for a fixture app, and its engine and build jobs
passed. The changes since then (the branch in each trigger, and the guard for a repository
named usabl) are covered by unit tests and have not yet run on a GitHub runner.
