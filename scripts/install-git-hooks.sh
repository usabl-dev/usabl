#!/usr/bin/env bash
# Install git hooks so every clone runs the tracked pre-commit config the same way.
# Hooks live in .git/hooks, the git default. CI skips this: the workflow runs the
# same checks as a job, not at commit time.
set -euo pipefail

if [ "${CI:-}" = "true" ]; then
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

if ! command -v pre-commit >/dev/null 2>&1; then
  echo "usabl: pre-commit is not installed. Local commits will skip hygiene, gitleaks, and conventional messages." >&2
  echo "usabl: install it, then re-run npm install:" >&2
  echo "  pip install pre-commit" >&2
  exit 0
fi

# Install into .git/hooks even if the user has a global core.hooksPath. Hide
# user/system gitconfig for this command only so pre-commit does not refuse.
git config --local --unset-all core.hooksPath 2>/dev/null || true
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pre-commit install --install-hooks
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pre-commit install --hook-type commit-msg

# Pin every clone to .git/hooks so a user-global hooksPath cannot replace the
# team's hooks. Same command on every machine.
git config --local core.hooksPath .git/hooks
