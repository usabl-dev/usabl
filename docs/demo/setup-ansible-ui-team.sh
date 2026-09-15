#!/usr/bin/env bash
# Bootstrap the ansible-ui + usabl team workflow (clone, install, tunnel, session).
# See ansible-ui-team-setup.md for the full walkthrough and troubleshooting.
set -euo pipefail

WORKDIR="${WORKDIR:-${HOME}/usabl-team}"
ANSIBLE_UI_REPO="${ANSIBLE_UI_REPO:-https://github.com/usabl-dev/ansible-ui-demo.git}"
USABL_REPO="${USABL_REPO:-https://github.com/usabl-dev/usabl.git}"
SSH_KEY="${HOME}/.ssh/rht_classroom.rsa"
AAP_USER="${AAP_USER:-admin}"
AAP_PASSWORD="${AAP_PASSWORD:-}"
AUI_BASE_URL="${AUI_BASE_URL:-http://localhost:4100}"
SKIP_CLONE=0
SKIP_SESSION=0
SKIP_TUNNEL=0

usage() {
  cat <<'EOF'
Usage: setup-ansible-ui-team.sh [options]

Clone ansible-ui and usabl, install dependencies, open the lab tunnel, and mint a
Playwright session. Does not start the dev server (that needs its own terminal).

Options:
  --workdir DIR     Parent directory for clones (default: ~/usabl-team)
  --skip-clone      Use existing clones in WORKDIR
  --skip-tunnel     Do not run open-aap-tunnel.sh
  --skip-session    Do not run aap-login.mjs (dev server must be up for login)
  -h, --help        Show this help

Environment:
  AAP_USER          Default: admin
  AAP_PASSWORD      Required, no default. Export it or set it in WORKDIR/demo.env
  AUI_BASE_URL      Default: http://localhost:4100

Before running:
  1. Download rht_classroom.rsa from the Drive folder in ansible-ui-team-setup.md
  2. Save as ~/.ssh/rht_classroom.rsa and chmod 600
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workdir)
      WORKDIR="$2"
      shift 2
      ;;
    --skip-clone)
      SKIP_CLONE=1
      shift
      ;;
    --skip-tunnel)
      SKIP_TUNNEL=1
      shift
      ;;
    --skip-session)
      SKIP_SESSION=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ANSIBLE_UI_DIR="${WORKDIR}/ansible-ui"
USABL_DIR="${WORKDIR}/usabl"

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

check_node() {
  require_cmd node
  require_cmd npm
  require_cmd git
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "${major}" -lt 22 ]]; then
    die "Node 22+ required (found $(node --version))"
  fi
}

check_ssh_key() {
  if [[ ! -f "${SSH_KEY}" ]]; then
    die "missing ${SSH_KEY}. Download rht_classroom.rsa from the Drive folder in ansible-ui-team-setup.md"
  fi
  chmod 600 "${SSH_KEY}"
}

verify_key_fingerprint() {
  local pub_key="${USABL_DIR}/docs/demo/keys/rht_classroom.rsa.pub"
  if [[ ! -f "${pub_key}" ]]; then
    info "skipping fingerprint check (${pub_key} not found yet)"
    return 0
  fi
  local expected actual
  expected="$(ssh-keygen -lf "${pub_key}" | awk '{print $2}')"
  actual="$(ssh-keygen -lf "${SSH_KEY}" | awk '{print $2}')"
  if [[ "${expected}" != "${actual}" ]]; then
    die "SSH key fingerprint mismatch. Re-download the team key from Drive."
  fi
  info "SSH key fingerprint OK (${actual})"
}

clone_repos() {
  mkdir -p "${WORKDIR}"
  if [[ ! -d "${ANSIBLE_UI_DIR}/.git" ]]; then
    info "cloning ansible-ui into ${ANSIBLE_UI_DIR}"
    git clone "${ANSIBLE_UI_REPO}" "${ANSIBLE_UI_DIR}"
  else
    info "ansible-ui clone already exists"
  fi
  if [[ ! -d "${USABL_DIR}/.git" ]]; then
    info "cloning usabl into ${USABL_DIR}"
    git clone "${USABL_REPO}" "${USABL_DIR}"
  else
    info "usabl clone already exists"
  fi
}

install_deps() {
  info "npm ci ansible-ui (this can take a few minutes)"
  (cd "${ANSIBLE_UI_DIR}" && npm ci)
  info "npm ci + build + link usabl"
  (cd "${USABL_DIR}" && npm ci && npm run build && npm link)
  export PATH="$(npm prefix -g)/bin:${PATH}"
  command -v usabl >/dev/null 2>&1 || die "usabl not on PATH after npm link; run: export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  info "linking usabl into ansible-ui so the dev server can import usabl/vite"
  (cd "${ANSIBLE_UI_DIR}" && npm link --no-save "${USABL_DIR}")
  info "installing Playwright chromium for usabl"
  (cd "${ANSIBLE_UI_DIR}" && npx playwright install chromium)
}

check_hosts() {
  if grep -qE '[[:space:]]aap\.lab\.example\.com' /etc/hosts 2>/dev/null; then
    info "/etc/hosts entry for aap.lab.example.com found"
    return 0
  fi
  echo ""
  echo "warning: /etc/hosts is missing aap.lab.example.com"
  echo "  Run once (needs sudo):"
  echo "    echo '127.0.0.1 aap.lab.example.com' | sudo tee -a /etc/hosts"
  echo ""
}

open_tunnel() {
  if [[ "${SKIP_TUNNEL}" -eq 1 ]]; then
    info "skipping tunnel (--skip-tunnel)"
    return 0
  fi
  info "opening lab tunnel"
  # Lives in the usabl clone, not the ansible-ui fork, so the fork stays a clean mirror.
  "${USABL_DIR}/docs/demo/open-aap-tunnel.sh"
}

mint_session() {
  if [[ "${SKIP_SESSION}" -eq 1 ]]; then
    info "skipping session mint (--skip-session)"
    return 0
  fi
  if ! curl -sf -o /dev/null "${AUI_BASE_URL}/login" 2>/dev/null; then
    echo ""
    echo "warning: dev server not reachable at ${AUI_BASE_URL}"
    echo "  Start it in another terminal, then re-run with --skip-clone --skip-tunnel:"
    echo "    cd ${ANSIBLE_UI_DIR}"
    echo "    PLATFORM_SERVER=https://aap.lab.example.com:8443/ DEV_SERVER_PROTOCOL=http npm start"
    echo ""
    echo "  Then mint the session:"
    echo "    cd ${ANSIBLE_UI_DIR}"
    echo "    AUI_BASE_URL=${AUI_BASE_URL} AAP_USER=${AAP_USER} AAP_PASSWORD=*** \\"
    echo "      AUI_STORAGE_STATE=./.usabl-session.json node ${USABL_DIR}/docs/demo/aap-login.mjs"
    return 0
  fi
  if [ -z "${AAP_PASSWORD}" ]; then
    echo "error: AAP_PASSWORD is not set. Export it, or put it in ${WORKDIR}/demo.env." >&2
    return 1
  fi
  info "minting Playwright session at ${ANSIBLE_UI_DIR}/.usabl-session.json"
  (
    # Run from the ansible-ui clone so .usabl-session.json lands where usabl reads it, but the
    # script itself lives in the usabl clone to keep the ansible-ui fork clean.
    cd "${ANSIBLE_UI_DIR}"
    AUI_BASE_URL="${AUI_BASE_URL}" \
      AAP_USER="${AAP_USER}" \
      AAP_PASSWORD="${AAP_PASSWORD}" \
      AUI_STORAGE_STATE=./.usabl-session.json \
      node "${USABL_DIR}/docs/demo/aap-login.mjs"
  )
}

apply_demo_edit() {
  # A fresh clone lands clean on the floor commit, so the change-driven overlay shows
  # "Nothing to check". Reintroduce a benign edit on the users screen so setup leaves the
  # demo in the VERIFIED-carrying-29 state, ready to film. Working-tree only; never committed.
  local route="${ANSIBLE_UI_DIR}/platform/routes/useGetPlatformUsersRoutes.tsx"
  local marker='// demo: edit on the users screen so usabl grades this change'
  if [[ ! -f "${route}" ]]; then
    info "skipping demo edit (${route} not found)"
    return 0
  fi
  if grep -qF "${marker}" "${route}"; then
    info "demo edit already present on users screen"
    return 0
  fi
  printf '%s\n' "${marker}" >>"${route}"
  info "applied demo edit to users screen (uncommitted; overlay will show VERIFIED, 29 recorded)"
}

print_next_steps() {
  cat <<EOF

Setup complete.

Workdirs:
  ansible-ui: ${ANSIBLE_UI_DIR}
  usabl:      ${USABL_DIR}

If the dev server is not running yet, start it in a separate terminal:
  cd ${ANSIBLE_UI_DIR}
  PLATFORM_SERVER=https://aap.lab.example.com:8443/ DEV_SERVER_PROTOCOL=http npm start

Run usabl:
  cd ${ANSIBLE_UI_DIR}
  USABL_STORAGE_STATE=./.usabl-session.json usabl check

Doctor:
  cd ${ANSIBLE_UI_DIR}
  USABL_STORAGE_STATE=./.usabl-session.json usabl doctor

Full guide: docs/demo/ansible-ui-team-setup.md in the usabl repo.
EOF
}

main() {
  check_node
  check_ssh_key
  if [[ "${SKIP_CLONE}" -eq 0 ]]; then
    clone_repos
  fi
  [[ -d "${ANSIBLE_UI_DIR}" ]] || die "ansible-ui not found at ${ANSIBLE_UI_DIR}"
  [[ -d "${USABL_DIR}" ]] || die "usabl not found at ${USABL_DIR}"
  verify_key_fingerprint
  install_deps
  apply_demo_edit
  check_hosts
  open_tunnel
  mint_session
  print_next_steps
}

main "$@"
