#!/usr/bin/env bash
# Bring the ansible-ui demo up, or back up after a reboot: lab tunnel, lab readiness, the dev
# server with the scanner session in its environment, a browser warm-up, and a fresh session.
# Re-runnable at any time. Pairs with mint-session.sh and filming-checklist.md.
#
# Lab details are never committed. Put them in ${WORKDIR}/demo.env, which this script sources:
#   AAP_LAB_HOST=...         the lab jump host (required by open-aap-tunnel.sh)
#   AAP_SSH_KEY=...          path to the classroom key, if not ~/.ssh/rht_classroom.rsa
#   AAP_LAB_USER / AAP_LAB_PORT / AAP_USER / AAP_PASSWORD  only if they differ from the defaults
set -euo pipefail

WORKDIR="${WORKDIR:-${HOME}/usabl-team}"
APP="${DEMO_APP:-${WORKDIR}/ansible-ui-demo}"
ENGINE="${USABL_ENGINE:-${WORKDIR}/usabl}"
SESSION="${WORKDIR}/aui-session-live.json"
DEMO_DIR="${ENGINE}/docs/demo"

# Export everything demo.env sets: open-aap-tunnel.sh and mint-session.sh run as child processes
# and read these values from their environment, so a plain source is not enough.
set -a
# shellcheck disable=SC1091
[ -f "${WORKDIR}/demo.env" ] && . "${WORKDIR}/demo.env"
set +a

say() { printf '==> %s\n' "$*"; }

[ -d "${APP}" ] || { say "no application at ${APP}; run setup-ansible-ui-team.sh first"; exit 1; }
[ -f "${ENGINE}/dist/cli.js" ] || { say "no built engine at ${ENGINE}; run npm run build there or set USABL_ENGINE"; exit 1; }
grep -q 'aap.lab.example.com' /etc/hosts || { say "add this line to /etc/hosts and rerun: 127.0.0.1 aap.lab.example.com"; exit 1; }

# 1. Tunnel. The lab is rebuilt often and its host key changes, so drop the old key first.
if ss -ltn 2>/dev/null | grep -q ':8443 '; then
  say "tunnel already open on 8443"
else
  : "${AAP_LAB_HOST:?set AAP_LAB_HOST in ${WORKDIR}/demo.env}"
  ssh-keygen -R "[${AAP_LAB_HOST}]:${AAP_LAB_PORT:-22022}" >/dev/null 2>&1 || true
  "${DEMO_DIR}/open-aap-tunnel.sh"
fi

# 2. The lab API answers 503 for several minutes after the lab boots.
say "waiting for the lab API"
code=""
for _ in $(seq 1 90); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 https://127.0.0.1:8443/api/ || true)
  [ "${code}" = "200" ] && break
  sleep 20
done
[ "${code}" = "200" ] || { say "lab API is not answering 200 (last: ${code}); is the lab up?"; exit 1; }
say "lab API answers 200"

# 3. Dev server with the scanner session path in its environment. Every scan reads that file, so
#    minting again later refreshes the scanner without a restart. HTTPS is the app's default and
#    the scanner does not ignore certificate errors, so the protocol is forced to HTTP.
if ss -ltn 2>/dev/null | grep -q ':4100 '; then
  say "dev server already listening on 4100"
else
  say "starting the dev server on 4100"
  ( cd "${APP}" && USABL_STORAGE_STATE="${SESSION}" DEV_SERVER_PROTOCOL=http \
      PLATFORM_SERVER=https://aap.lab.example.com:8443/ BROWSER=none \
      nohup npm --prefix platform start -- --no-open > "${WORKDIR}/aui-dev.log" 2>&1 & )
  for _ in $(seq 1 60); do ss -ltn 2>/dev/null | grep -q ':4100 ' && break; sleep 3; done
fi
curl -s -o /dev/null -w 'dev server: %{http_code}\n' --max-time 30 http://localhost:4100/

# 4. Mint once now, so a check made during the warm-up finds a live session. On a cold server
#    the login helper can time out; the warm-up below fixes that and the mint runs again.
"${DEMO_DIR}/mint-session.sh" || say "first mint did not complete; retrying after the warm-up"

# 5. Warm the application in a real browser. A cold dev server compiles about two thousand
#    modules on the first page load, which takes minutes. A plain fetch does not warm it.
say "warming the application in a browser (minutes on a cold server)"
( cd "${ENGINE}" && node --input-type=module -e '
  import { chromium } from "playwright";
  const b = await chromium.launch(); const p = await (await b.newContext()).newPage();
  const t0 = Date.now();
  await p.goto("http://localhost:4100/access/users", { waitUntil: "load", timeout: 300000 });
  await p.waitForSelector("input[type=password], h1", { timeout: 240000 }).catch(() => {});
  console.log("warmed in", Math.round((Date.now() - t0) / 1000), "s");
  await b.close();
' )

# 6. Mint again so the session is fresh when the first filmed scan runs.
"${DEMO_DIR}/mint-session.sh"

say "ready"
say "overlay:   http://localhost:4100/access/users   (log in with your own browser to see the real screen)"
say "terminal:  cd ${APP} && USABL_STORAGE_STATE=${SESSION} node ${ENGINE}/dist/cli.js check"
say "checklist: ${DEMO_DIR}/filming-checklist.md"
