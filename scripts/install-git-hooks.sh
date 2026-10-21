#!/usr/bin/env bash
# Install git hooks so every clone runs the tracked pre-commit config the same way.
# Hooks live in .git/hooks, the git default. CI skips this: the workflow runs the
# same checks as a job, not at commit time.
#
# npm's prepare script runs this file only when it exists, so the published
# package, which ships only dist, never reaches it.
set -euo pipefail

if [ "${CI:-}" = "true" ]; then
  exit 0
fi

# The package root is the directory above scripts/. Resolve symlinks so the
# comparisons below compare real paths. CDPATH could make cd print a path or
# land somewhere else, so it is cleared first.
unset CDPATH
package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# Touch git config only when this package is its own git repo. A source copy of
# usabl inside another project finds that project's repo, and changing its hooks
# would break whatever it uses, such as husky.
if ! toplevel="$(git -C "$package_root" rev-parse --show-toplevel 2>/dev/null)"; then
  exit 0
fi
if [ "$(cd "$toplevel" && pwd -P)" != "$package_root" ]; then
  exit 0
fi

# A repo without the tracked pre-commit config has no hooks for us to install.
if [ ! -f "$package_root/.pre-commit-config.yaml" ]; then
  exit 0
fi

# npm sets INIT_CWD to the directory npm was started from. When npm installs
# usabl as a git dependency, it runs prepare in a temporary clone that has its
# own .git, and INIT_CWD is the consumer's directory. Installing hooks there is
# useless and can fail offline, so only a developer's install in this clone counts.
if [ -n "${INIT_CWD:-}" ]; then
  if ! init_cwd="$(cd "$INIT_CWD" 2>/dev/null && pwd -P)" || [ "$init_cwd" != "$package_root" ]; then
    exit 0
  fi
fi

if ! command -v pre-commit >/dev/null 2>&1; then
  echo "usabl: pre-commit is not installed. Local commits will skip hygiene, gitleaks, and conventional messages." >&2
  echo "usabl: install it, then re-run npm install:" >&2
  echo "  pip install pre-commit" >&2
  exit 0
fi

cd "$package_root"

# Install into .git/hooks even if the user has a global core.hooksPath. Hide
# user/system gitconfig for this command only so pre-commit does not refuse.
git config --local --unset-all core.hooksPath 2>/dev/null || true
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pre-commit install --install-hooks >&2
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pre-commit install --hook-type commit-msg >&2

# Pin every clone to .git/hooks so a user-global hooksPath cannot replace the
# team's hooks. Same command on every machine.
git config --local core.hooksPath .git/hooks
