#!/usr/bin/env bash
# Mint a fresh scanner session for the ansible-ui demo. The dev server started by start-demo.sh
# reads this file on every scan, so running this refreshes the scanner without a restart.
# The gateway session cookie lives about 15 minutes: run this right before each filmed scan.
set -euo pipefail

WORKDIR="${WORKDIR:-${HOME}/usabl-team}"
APP="${DEMO_APP:-${WORKDIR}/ansible-ui-demo}"
ENGINE="${USABL_ENGINE:-${WORKDIR}/usabl}"
SESSION="${WORKDIR}/aui-session-live.json"

# shellcheck disable=SC1091
[ -f "${WORKDIR}/demo.env" ] && . "${WORKDIR}/demo.env"

cd "${APP}"
AUI_BASE_URL="${AUI_BASE_URL:-http://localhost:4100}" AAP_USER="${AAP_USER:-admin}" \
  AAP_PASSWORD="${AAP_PASSWORD:-redhat}" AUI_STORAGE_STATE="${SESSION}" \
  node "${ENGINE}/docs/demo/aap-login.mjs"
printf '==> session minted at %s; it lives about 15 minutes\n' "$(date +%H:%M)"
