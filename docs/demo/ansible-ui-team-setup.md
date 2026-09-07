# usabl on ansible-ui: team setup

Run usabl against ansible-ui on your machine. The app's API comes from a shared lab AAP backend over
an SSH tunnel.

**Secrets**

| What | Where |
| --- | --- |
| SSH private key (`rht_classroom.rsa`) | [Drive folder](https://drive.google.com/drive/folders/1hz_F6ZX_LjJe0mkx7SVPv9x9wDw6V4Sm?usp=drive_link) (download only, do not commit this key to any repo) |
| AAP login | `admin` / `redhat` |

The app scan config (`usabl.config.json`, `usabl.routes.json`) lives in the private
`usabl-dev/ansible-ui-demo` repo. The tunnel script, login script, and the public key for the
fingerprint check live in the usabl clone under `docs/demo`.

---

## Setup (four steps)

**1. Install the SSH key** (one time)

```
mkdir -p ~/.ssh
cp ~/Downloads/rht_classroom.rsa ~/.ssh/rht_classroom.rsa
chmod 600 ~/.ssh/rht_classroom.rsa
```

**2. Run the bootstrap script** (from a usabl clone)

```
./docs/demo/setup-ansible-ui-team.sh --skip-session
```

Clones into `~/usabl-team` by default, installs deps, links `usabl`, and opens the lab tunnel. If it
asks for `/etc/hosts`, run:

```
echo '127.0.0.1 aap.lab.example.com' | sudo tee -a /etc/hosts
```

**3. Start the dev server** (leave running in a second terminal)

```
cd ~/usabl-team/ansible-ui
PLATFORM_SERVER=https://aap.lab.example.com:8443/ DEV_SERVER_PROTOCOL=http npm start
```

**4. Mint a session and run usabl**

If step 2 ran before the dev server was up, mint the session now (from your usabl clone):

```
./docs/demo/setup-ansible-ui-team.sh --workdir ~/usabl-team --skip-clone --skip-tunnel
```

Then check:

```
cd ~/usabl-team/ansible-ui
USABL_STORAGE_STATE=./.usabl-session.json usabl check
```

First time on the evidence floor? Run `usabl baseline` before you treat failures as regressions.

---

## Wire your editor

The fork already ships Claude Code and Cursor integration files. When you clone, the hooks and
commands are ready. If they are missing or you need to regenerate them, run the install commands
below from the ansible-ui clone.

### Claude Code

Already wired in the fork. If missing, run:

```
cd ~/usabl-team/ansible-ui
usabl install --claude
usabl install --claude-skill
```

- `--claude` wires the **Stop hook** (`.claude/settings.json`) so the assistant's first attempt to
  finish on a blocking verdict is blocked unless a one-use `usabl bypass` was issued.
- `--claude-skill` writes the **`/usabl-check` skill** for advisory mid-task scans.

Mid-task: type `/usabl-check` or ask Claude to run `npx usabl check --self-check`.

### Cursor

Already wired in the fork. If missing, run:

```
cd ~/usabl-team/ansible-ui
usabl install --cursor
chmod +x .cursor/hooks/usabl-stop.sh
```

This writes four files:
- `.cursor/hooks.json` - declares the `stop` event with a loop limit
- `.cursor/hooks/usabl-stop.sh` - pipes stdin through `npx usabl stop-hook --cursor`
- `.cursor/commands/usabl-check.md` - the `/usabl-check` slash command
- `.cursor/rules/usabl-accessibility.mdc` - a rule reminding the agent to self-check after UI edits

The stop hook uses Cursor's `followup_message` protocol: on a blocking verdict it sends the agent one
follow-up with the disclosed result and reason, and when Cursor reports that the loop is already active (`loop_count`
above 0) it allows the stop to prevent a recursive loop. Set `USABL_STORAGE_STATE=./.usabl-session.json` in your shell profile or prefix it
when you open Cursor.

Mid-task: type `/usabl-check` or ask the agent to run `npx usabl check --self-check`. That command
is advisory. Only `usabl check` (and the stop hook) can block a regression.

### Confirm wiring

```
cd ~/usabl-team/ansible-ui
USABL_STORAGE_STATE=./.usabl-session.json usabl doctor
```

Look for `stop-hook`, `claude usabl-check skill`, and `cursor stop hook + assistant` as **wired**.

---

## Test ansible-ui as a brownfield app

ansible-ui is a real, login-gated monorepo. usabl treats it as **brownfield**: existing accessibility
debt is expected until you baseline it. The gate then blocks only **new** barriers on touched surfaces.

### What to expect on first run

| First `usabl check` | Meaning |
| --- | --- |
| `regression` | Real findings, no evidence floor yet. Normal for brownfield. |
| `not_covered` | A changed file mapped to no screen, or Chromium/session/tunnel missing. |
| `approval required` | You edited guarded policy (`usabl.config.json`, routes, evidence). |

Do **not** run `usabl init` on ansible-ui. The fork already ships `usabl.config.json` and
`usabl.routes.json`.

### Brownfield loop (recommended order)

**1. Baseline the floor** (already done - Ed committed `.usabl-evidence.json` to the fork)

The baseline records existing accessibility debt so it does not block your PRs. Carried debt no
longer gates; only **new** barriers do. You do not need to run `usabl baseline` unless the floor is
missing or you are resetting it.

**2. Map fixes before you chase axe noise**

If changed files show `not_covered`, fix the route map first:

```
usabl drift routes
```

Add missing surfaces to `usabl.config.json` through a PR. Each map edit is guarded.

**3. Daily dev loop**

With dev server, tunnel, and session running:

```
# advisory mid-task (assistant or you)
USABL_STORAGE_STATE=./.usabl-session.json npx usabl check --self-check

# gate before you call UI work done
USABL_STORAGE_STATE=./.usabl-session.json usabl check
```

Touch a `platform/**/*.tsx` or `frontend/**/*.tsx` file in your branch, then run `usabl check` to scan
the surfaces that file maps to.

**4. Pay down debt**

When you fix a floored finding, run a full scan and prune paid-down identities:

```
USABL_STORAGE_STATE=./.usabl-session.json usabl check
USABL_STORAGE_STATE=./.usabl-session.json usabl floor prune
```

Merge the `.usabl-evidence.json` diff with your fix PR so the floor ratchets down.

### Rules for this test subject

- Work only in the private **`usabl-dev/ansible-ui-demo`** repo. Never push to `ansible/ansible-ui`.
- Never commit `.usabl-session.json`, the SSH private key, or raw scan output that names product
  findings you should not publish.
- Keep tunnel + dev server + `USABL_STORAGE_STATE` exported for every scan.
- A login-gated page scanned signed-out measures the login screen, not the product. Re-mint the session
  if you change dev server port.

### Sanity checks

```
USABL_STORAGE_STATE=./.usabl-session.json usabl doctor
USABL_STORAGE_STATE=./.usabl-session.json usabl check
```

Doctor should show config, session, and Chromium as wired. Check should return a verdict (any of the
four), not a silent pass on zero work.

---

## Surfaces already wired in the fork

Ed has already set up the CI gate, Vite overlay, baseline, and branch protection. You do not need to
run the install commands below. This section explains what each surface does so you know what you are
looking at.

### Vite overlay (advisory)

The overlay is an advisory badge inside the running dev server. It shows findings live while you code
but never changes exit codes. Hide it with `?usabl=off` in the URL.

If it is missing, the two lines to add by hand are:

```ts
import { usablVitePluginFromConfig } from 'usabl/vite'
// then inside defineConfig plugins array:
usablVitePluginFromConfig({ cwd: import.meta.dirname }),
```

Restart the dev server after adding the plugin.

### CI gate (blocking)

`.github/workflows/usabl-gate.yml` runs on every PR, and again on every review event, with three jobs:

| Job | Purpose |
| --- | --- |
| `gate-comment` | Checks out PR head, runs `usabl check --ci --trusted-ref origin/<base> --json`, posts a sticky PR comment, and uploads the Result as an artifact. Runs only on `pull_request` events, so fork head code never sees secrets. |
| `usabl-policy` | Never runs head code. Checks out the trusted base, reads the head as git objects only, decides policy from CODEOWNERS and the trusted ref, and publishes the accessibility verdict read from the Result artifact. It is green whenever no guarded path diverged, which says nothing about accessibility, so do not make it the required check on its own. |
| `usabl-required` | The **required status check**. It is the only job that sees both the accessibility verdict and the policy verdict, and it decides merge or block. It runs on every event (`always()`), so a skipped job can never read as satisfied. |

The workflow is already pinned to a trusted usabl commit and `USABL_ENGINE_CHECKOUT_TOKEN` is set as
a repo secret. Branch protection requires the `usabl-required` check to pass before merge. Do not
require `gate-comment` (it cannot run on a review event) or `usabl-policy` alone.

You can verify that the branch rule requires `usabl-required`:

```
usabl install --branch-rule
```

That target is **read-only**: it checks the GitHub API and writes nothing.

### What the PR comment looks like

Every PR gets a sticky bot comment that starts with:

```
## usabl report: VERIFIED
```

or `REGRESSION`, `NOT COVERED`, `APPROVAL REQUIRED`, or `IDLE`.

The comment includes:
- **Conformance summary** - deterministic new/carried/waived/fixed counts, judged counts, unresolved
  files, gaps, and a `blocked` flag. That flag is true only when new deterministic failures block
  the accessibility result; it is false for `not_covered` and `approval_required`, even though the
  required `usabl-required` check still blocks the merge in those cases.
- **Receipt** (verified only) - the comment displays `sourceTree`, `policyHash`, `runnerVersion`, and
  `mintedAt`. The receipt itself binds four values: the exact source tree, the policy hash, the engine
  version, and the scanner versions (axe-core, Playwright, Chromium); the comment does not display the
  scanner versions. Change any of the four and the receipt stops verifying.
- **Findings** - each new or carried finding with rule, impact, surface, and page-derived help text
  (neutralized for terminal safety).
- **Model suggestions** - grouped under "Model suggestions (not blocking)" when present. These are
  advisory and never decide a verdict.

The `gate-comment` job updates the same comment on each push (it finds the existing one by a hidden
HTML marker). You will never get comment spam.

### How CI verdicts map to the merge gate

| Verdict | `gate-comment` job | `usabl-policy` check | Merge |
| --- | --- | --- | --- |
| `verified` | Green, posts receipt | Green | Allowed |
| `regression` | Red, posts findings | Red | Blocked (if required) |
| `not_covered` | Red, posts disclosure | Red | Blocked |
| `approval_required` | Red, names changed policy | Red | Blocked until CODEOWNERS approve |

The `usabl-policy` check is the one you make required in branch protection. `gate-comment` posts the
readable result but is not required by itself.

---

## Push a fix and see the whole loop

This is the day-one workflow for fixing an accessibility barrier on a PR.

### 1. Branch

```
cd ~/usabl-team/ansible-ui
git checkout -b fix/a11y-missing-label
```

### 2. Make the change

Edit a `.tsx` file (e.g. add an `aria-label`). The overlay shows findings live if wired.

### 3. Self-check (advisory)

```
USABL_STORAGE_STATE=./.usabl-session.json npx usabl check --self-check
```

This exits 0 always. It tells you the verdict mid-task without blocking. If you are in Claude Code,
type `/usabl-check`. In Cursor, ask the agent to run the command above.

### 4. Gate check (local)

```
USABL_STORAGE_STATE=./.usabl-session.json usabl check
```

This is the real gate. `verified` means the fix worked. `regression` means new barriers remain.
Fix them before pushing.

### 5. Commit and push

```
git add -p
git commit -m "fix(a11y): add missing label to ..."
git push origin fix/a11y-missing-label
```

### 6. Open a PR

```
gh pr create --base devel --fill
```

CI runs `usabl-gate`. Watch for:
- The sticky bot comment with the verdict.
- The `usabl-policy` check (green or red) in the PR checks tab.

### 7. Interpret the result

- **VERIFIED** with a receipt: merge when ready.
- **REGRESSION**: the comment lists each new finding with rule, impact, and repair. Fix locally, push,
  CI re-runs.
- **NOT COVERED**: a changed file maps to no screen, or the scan could not run. Check
  `usabl.config.json` surfaces and `usabl drift routes`.
- **APPROVAL REQUIRED**: you touched a guarded file (`usabl.config.json`, evidence, waivers). A
  CODEOWNERS approval is required before merge.

### 8. Pay down debt (optional, after a fix lands)

```
USABL_STORAGE_STATE=./.usabl-session.json usabl floor prune
```

Commit the `.usabl-evidence.json` diff alongside the fix PR so the floor ratchets down.

---

## All surfaces at a glance

| Surface | Command | Blocking? | When it runs |
| --- | --- | --- | --- |
| CLI | `usabl check` | Yes (exit code) | You run it |
| Self-check | `usabl check --self-check` | No (always exit 0) | You or the assistant runs it mid-task |
| Stop hook (Claude) | `npx usabl stop-hook` | Yes (stdout decision) | Claude tries to finish a turn |
| Stop hook (Cursor) | `npx usabl stop-hook --cursor` | Yes (followup_message loop) | Agent completes a turn |
| Vite overlay | `usabl install --overlay` | No (advisory badge) | Dev server is running |
| PR comment | `usabl comment` (via CI) | No (informational) | Every PR push |
| CI gate | `usabl-policy` (via CI) | Yes (required check) | Every PR push + review |
| Doctor | `usabl doctor` | No (read-only report) | You run it to diagnose setup |
| Baseline | `usabl baseline` | No (drafts evidence floor) | Once, at brownfield adoption |
| Floor prune | `usabl floor prune` | No (removes paid debt) | After fixing a floored finding |

---

## Manual setup (reference)

Use these if the script fails or you want to understand each step.

### 0. Prerequisites

- Node **22** or newer, and git. (`usabl` requires Node 22; ansible-ui requires Node 20+.)
- Access to the usabl-dev org on GitHub
- Access to the Drive folder (link above). Download `rht_classroom.rsa` and save it as
  `~/.ssh/rht_classroom.rsa`.

Install the private key:
```
mkdir -p ~/.ssh
cp ~/Downloads/rht_classroom.rsa ~/.ssh/rht_classroom.rsa
chmod 600 ~/.ssh/rht_classroom.rsa
```

Verify the private key matches the public key (shipped in the usabl clone, not the fork):
```
ssh-keygen -lf ~/.ssh/rht_classroom.rsa
ssh-keygen -lf usabl/docs/demo/keys/rht_classroom.rsa.pub    # run from the usabl-team workdir
```
Both must print the same `SHA256:` fingerprint. See `docs/demo/keys/README.md` in the usabl clone.

### 1. Get the code

The private demo app repo (`usabl-dev/ansible-ui-demo`). It ships `usabl.config.json` and
`usabl.routes.json`. The demo helper scripts and the key live in the usabl clone (see below):
```
git clone https://github.com/usabl-dev/ansible-ui-demo.git ansible-ui
cd ansible-ui && npm ci
```

usabl itself (in usabl-dev):
```
git clone https://github.com/usabl-dev/usabl.git
cd usabl && npm ci && npm run build && npm link
```

`npm link` puts the `usabl` command on your PATH. If the shell cannot find it:
```
export PATH="$(npm prefix -g)/bin:$PATH"
```

Install the headless browser usabl uses (from the ansible-ui clone):
```
cd ansible-ui
npx playwright install chromium
```
On Linux, if `usabl check` still cannot launch Chromium, run
`npx playwright install --with-deps chromium`.

Check the toolchain:
```
usabl doctor
```

The fork `.gitignore` already excludes `.usabl-session.json`. Do not commit session files.

### 2. Open the tunnel to the lab

The AAP backend runs in the lab, not on your machine. The tunnel script lives in the usabl clone.
Set your lab jump host first (its address changes each time the lab is provisioned; take it from the
lab provisioning details), then run the script from the ansible-ui clone:
```
export AAP_LAB_HOST=<your lab jump host address>
../usabl/docs/demo/open-aap-tunnel.sh
```

The script checks the key exists, opens the tunnel unless local port 8443 is already forwarding, and
reminds you to add the lab hostname to `/etc/hosts` if needed. Other lab values (`AAP_LAB_USER`,
`AAP_LAB_PORT`, `AAP_SSH_KEY`) have sane defaults and can be overridden with environment variables.

One-time on each machine (needs `sudo`):
```
echo '127.0.0.1 aap.lab.example.com' | sudo tee -a /etc/hosts
```

Verify both return `200`:
```
curl -sk -o /dev/null -w "%{http_code}\n" https://aap.lab.example.com:8443/api/
curl -sk -o /dev/null -w "%{http_code}\n" https://127.0.0.1:8443/api/
```

If the hostname check fails but `127.0.0.1` works, add the `/etc/hosts` line. Every teammate runs
their own tunnel on local port 8443; they do not conflict.

### 3. Start the ansible-ui dev server

`PLATFORM_SERVER` points the app at the tunnel. `DEV_SERVER_PROTOCOL=http` is required, because the
default is https and usabl's browser does not accept the dev server's self-signed cert.
```
cd ansible-ui
PLATFORM_SERVER=https://aap.lab.example.com:8443/ DEV_SERVER_PROTOCOL=http npm start
```
This serves the app on http://localhost:4100. Leave it running in its own terminal.

### 4. Log in and save a session

usabl scans as a logged-in user. Mint a session with the script from the usabl clone, run from the
ansible-ui clone so the session file lands where usabl reads it:
```
cd ansible-ui
AUI_BASE_URL=http://localhost:4100 \
AAP_USER=admin AAP_PASSWORD=redhat \
AUI_STORAGE_STATE=./.usabl-session.json \
node ../usabl/docs/demo/aap-login.mjs
```

**Important: the session is tied to the exact scheme, host, and port.** A session minted against
`localhost:4100` will not authenticate `localhost:4200`. If you scan a different port, re-mint against
that port, or every page loads logged-out and renders nothing.

### 5. Run usabl

usabl reads its target from `usabl.config.json` (already in the fork). It reads your session from the
`USABL_STORAGE_STATE` environment variable on purpose, because the file holds live tokens.
```
cd ansible-ui
USABL_STORAGE_STATE=./.usabl-session.json usabl check
```

`usabl check` scans and reports a verdict. Run `usabl baseline` once when starting fresh on the evidence
floor. `usabl doctor` diagnoses setup problems.

**Do not run `usabl init` on ansible-ui.** The monorepo layout drafts the wrong dev URL and empty
surfaces. Use the committed `usabl.config.json`.

---

## Safety rules

- Never commit or push the SSH private key or session files (`*.session.json`, `.usabl-session.json`).
- Keep session files on your machine only. They contain live tokens.
- Push app changes only to the fork (`origin` is already the fork), never to `ansible/ansible-ui`.

## If something breaks

- `curl` returns `000`: tunnel down, re-run `../usabl/docs/demo/open-aap-tunnel.sh`. If `127.0.0.1`
  works but the hostname does not, add the `/etc/hosts` line.
- Key fingerprint mismatch: you have the wrong private key. Re-download from the team Drive folder,
  not a key from your own lab DOWNLOAD unless Ed confirms it is the same pair.
- Login script times out on `#pf-login-username-id`: dev server not running, or API tunnel down. Open
  http://localhost:4100/login in a browser first.
- Every page shows the login screen in usabl output: session is for the wrong port, re-mint step 4.
- App loads but the API is empty: check `PLATFORM_SERVER` uses `aap.lab.example.com`, not `127.0.0.1`.
- `usabl: command not found`: re-run `npm link` in the usabl repo, then
  `export PATH="$(npm prefix -g)/bin:$PATH"`.
- `usabl check` returns `not_covered` for every screen: run `npx playwright install chromium`.
- `approval required: guarded path(s) changed`: you edited `usabl.config.json` locally. Reset from the
  fork or commit your change before checking.
