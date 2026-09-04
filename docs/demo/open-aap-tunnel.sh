#!/usr/bin/env bash
# Open the SSH tunnel to the lab AAP so the local dev server reaches it at
# https://${REMOTE_HOST}:${LOCAL_PORT}/. The lab jump host is not baked in: set AAP_LAB_HOST
# (and, if they differ from the defaults, the other AAP_LAB_* values) from the team setup guide.
# Re-runnable: if the local port is already forwarding, it reports that and exits 0.
set -euo pipefail

AAP_LAB_HOST="${AAP_LAB_HOST:?set AAP_LAB_HOST to the lab jump host (see ansible-ui-team-setup.md)}"
AAP_LAB_PORT="${AAP_LAB_PORT:-22022}"
AAP_LAB_USER="${AAP_LAB_USER:-instructor}"
SSH_KEY="${AAP_SSH_KEY:-${HOME}/.ssh/rht_classroom.rsa}"
LOCAL_PORT="${AAP_LOCAL_PORT:-8443}"
REMOTE_HOST="${AAP_REMOTE_HOST:-aap.lab.example.com}"
REMOTE_PORT="${AAP_REMOTE_PORT:-443}"

if [[ ! -f "${SSH_KEY}" ]]; then
  echo "error: SSH key not found at ${SSH_KEY}. Download it per ansible-ui-team-setup.md." >&2
  exit 1
fi

if ss -ltn 2>/dev/null | grep -q ":${LOCAL_PORT} "; then
  echo "==> local port ${LOCAL_PORT} already in use; assuming the tunnel is open"
  exit 0
fi

echo "==> opening tunnel: localhost:${LOCAL_PORT} -> ${REMOTE_HOST}:${REMOTE_PORT} via ${AAP_LAB_USER}@${AAP_LAB_HOST}:${AAP_LAB_PORT}"
ssh -f -N \
  -L "${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ExitOnForwardFailure=yes \
  -i "${SSH_KEY}" \
  -p "${AAP_LAB_PORT}" \
  "${AAP_LAB_USER}@${AAP_LAB_HOST}"

echo "==> tunnel open. Map the host once if you have not: echo '127.0.0.1 ${REMOTE_HOST}' | sudo tee -a /etc/hosts"
