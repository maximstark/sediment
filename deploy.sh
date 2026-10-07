#!/usr/bin/env bash
# Build SEDIMENT and publish it into a web server's document directory.
#
# The target is never hardcoded. Set SEDIMENT_DEPLOY_TARGET to the directory the
# piece should be served from (it is created if missing), either in the
# environment or in a gitignored deploy.env beside this script:
#
#   SEDIMENT_DEPLOY_TARGET=/path/to/docroot/sediment
#
# Run it on the machine that serves the files; it copies, it does not upload.
# Deliberately additive: it writes only inside the target directory and never
# touches anything beside it.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# deploy.env fills in the target only when the environment has not set one
DEST="${SEDIMENT_DEPLOY_TARGET:-}"
if [ -z "$DEST" ] && [ -f "$SRC/deploy.env" ]; then
  # shellcheck source=/dev/null
  . "$SRC/deploy.env"
  DEST="${SEDIMENT_DEPLOY_TARGET:-}"
fi
if [ -z "$DEST" ]; then
  echo "SEDIMENT_DEPLOY_TARGET is not set — export it or put it in deploy.env" >&2
  exit 1
fi

node "$SRC/build.mjs" >/dev/null

mkdir -p "$DEST/fonts"
install -m 644 "$SRC/build/index.html" "$DEST/index.html"
install -m 644 "$SRC/build/og.png"     "$DEST/og.png"
install -m 644 "$SRC/build/fonts/"*.woff2 "$DEST/fonts/"

# test-build.html carries QA hooks and must never ship
rm -f "$DEST/test-build.html"

echo "deployed -> $DEST"
find "$DEST" -type f -printf '  %-46p %6s bytes\n' | sort
