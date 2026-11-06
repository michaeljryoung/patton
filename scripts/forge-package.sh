#!/bin/bash
# Build the app with Electron Forge on a Node that can actually unpack Electron.
#
# Why this exists (S40, 2026-11-06): under Node 26, `electron-forge package`
# reaches "Extracting electron-v44.7.0-darwin-arm64.zip", extract-zip 2.0.1
# opens the first entry's write stream and the Node event loop drains, so the
# child exits 0 before anything is written. Forge then reports success, `out/`
# stays empty, the postPackage hook never runs and /Applications/Patton.app keeps
# the previous build. Exit code 0 is therefore not proof of a build: compare the
# mtime of /Applications/Patton.app/Contents/Resources/app.asar with the commit.
#
# This wrapper runs Forge on the newest Node below 26 it can find and falls
# through to the current Node (with a warning) when there is none. CI pins its
# own Node in the workflow, so it never reaches the fallback list.
set -euo pipefail

major_of() { "$1" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

current="$(command -v node || true)"
if [ -n "$current" ] && [ "$(major_of "$current")" -lt 26 ] 2>/dev/null; then
  exec npx electron-forge package "$@"
fi

for candidate in \
  /opt/homebrew/opt/node@24/bin/node \
  /opt/homebrew/opt/node@22/bin/node \
  /usr/local/bin/node; do
  if [ -x "$candidate" ] && [ "$(major_of "$candidate")" -lt 26 ] 2>/dev/null; then
    echo "[forge-package] Node $(node -v) cannot unpack Electron; using $candidate ($("$candidate" -v))"
    PATH="$(dirname "$candidate"):$PATH" exec npx electron-forge package "$@"
  fi
done

echo "[forge-package] WARNING: no Node below 26 found; the build may exit 0 without producing anything" >&2
exec npx electron-forge package "$@"
