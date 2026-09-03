#!/usr/bin/env bash
# Cursor stop hook adapter for usabl. Feeds the stdin shape usabl stop-hook expects.
# Copy to ansible-ui/.cursor/hooks/usabl-stop.sh and wire hooks.json (see ansible-ui-team-setup.md).
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export USABL_STORAGE_STATE="${USABL_STORAGE_STATE:-./.usabl-session.json}"

echo '{"stop_hook_active":false}' | npx usabl stop-hook
