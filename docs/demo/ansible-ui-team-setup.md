# usabl on ansible-ui: team setup

Goal: run usabl against the ansible-ui app on your machine, with the app's API served by the shared
lab AAP backend over an SSH tunnel.

Download the lab SSH key from Ed's Drive folder (keep it local. do not commit or
repost the key file):

https://drive.google.com/drive/folders/1hz_F6ZX_LjJe0mkx7SVPv9x9wDw6V4Sm?usp=drive_link

Shared lab AAP login (classroom default):

| Field | Value |
| --- | --- |
| Username | `admin` |
| Password | `redhat` |

Everything else (config, login script, tunnel script, public key fingerprint) is in the
`usabl-dev/ansible-ui` fork.

Session files hold live tokens; keep them local.

Time: about 20 minutes the first time, most of it `npm ci`. Or run the bootstrap script
(see **Quick setup** below) and follow the printed next steps.

---

## Quick setup

From a usabl clone, after you install `~/.ssh/rht_classroom.rsa` from Drive:

```
./docs/demo/setup-ansible-ui-team.sh
```

The script clones `ansible-ui` and `usabl` into `~/usabl-team` by default, runs `npm ci`,
links the `usabl` CLI, installs Playwright Chromium, and opens the lab tunnel. If the dev server
is already running on port 4100, it also mints `.usabl-session.json`.

Use `--workdir DIR` to choose a different parent directory. Use `--skip-session` on the first run
if the dev server is not up yet; start the server, then re-run with `--skip-clone --skip-tunnel`.

---

## 0. Prerequisites

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

Verify the private key matches the public key in the fork:
```
ssh-keygen -lf ~/.ssh/rht_classroom.rsa
ssh-keygen -lf keys/rht_classroom.rsa.pub    # run inside your ansible-ui clone
```
Both must print the same `SHA256:` fingerprint. See `keys/README.md` in the fork.

## 1. Get the code

The ansible-ui fork (public, in usabl-dev). This repo ships `usabl.config.json`,
`scripts/aap-login.mjs`, `scripts/open-aap-tunnel.sh`, and `keys/rht_classroom.rsa.pub`:
```
git clone https://github.com/usabl-dev/ansible-ui.git
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

## 2. Open the tunnel to the lab

The AAP backend runs in the lab, not on your machine. From the ansible-ui clone:
```
./scripts/open-aap-tunnel.sh
```

The script checks your key fingerprint, starts the tunnel if it is not already running, and prints a
`curl` check. It also reminds you to add the lab hostname to `/etc/hosts` if needed.

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

## 3. Start the ansible-ui dev server

`PLATFORM_SERVER` points the app at the tunnel. `DEV_SERVER_PROTOCOL=http` is required, because the
default is https and usabl's browser does not accept the dev server's self-signed cert.
```
cd ansible-ui
PLATFORM_SERVER=https://aap.lab.example.com:8443/ DEV_SERVER_PROTOCOL=http npm start
```
This serves the app on http://localhost:4100. Leave it running in its own terminal.

## 4. Log in and save a session

usabl scans as a logged-in user. Mint a session with the script in the fork:
```
cd ansible-ui
AUI_BASE_URL=http://localhost:4100 \
AAP_USER=admin AAP_PASSWORD=redhat \
AUI_STORAGE_STATE=./.usabl-session.json \
node scripts/aap-login.mjs
```

**Important: the session is tied to the exact scheme, host, and port.** A session minted against
`localhost:4100` will not authenticate `localhost:4200`. If you scan a different port, re-mint against
that port, or every page loads logged-out and renders nothing.

## 5. Run usabl

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

## Safety rules

- Never commit or push the SSH private key or session files (`*.session.json`, `.usabl-session.json`).
- Keep session files on your machine only. They contain live tokens.
- Push app changes only to the fork (`origin` is already the fork), never to `ansible/ansible-ui`.

## If something breaks

- `curl` returns `000`: tunnel down, re-run `./scripts/open-aap-tunnel.sh`. If `127.0.0.1` works but
  the hostname does not, add the `/etc/hosts` line.
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
