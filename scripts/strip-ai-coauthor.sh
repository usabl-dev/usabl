#!/usr/bin/env bash
# Drop editor-agent Co-authored-by trailers before the commit is recorded.
# Author remains the human developer. Do not bypass this with --no-verify.
set -euo pipefail

msg_file="${1:?commit message file required}"

sed -i '/^Co-authored-by: .*cursoragent@cursor.com>$/d' "$msg_file"
