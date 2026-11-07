#!/bin/bash
# Build the app with Electron Forge on a Node that Forge supports.
#
# History (S40, 2026-11-06): under Forge 7, `electron-forge package` on Node 26
# reached "Extracting electron-v44.7.0-darwin-arm64.zip", extract-zip 2.0.1
# opened the first entry's write stream and the Node event loop drained, so the
# child exited 0 before anything was written. Forge reported success, `out/`
# stayed empty and the postPackage hook never ran. This wrapper then ran Forge
# on the newest Node below 26.
#
# Forge 8 (S45) packages through @electron/packager 20.3, which no longer uses
# extract-zip, and builds on Node 26. It needs Node 22.13 or newer, so this
# wrapper now runs Forge on the current Node when it is new enough, and
# otherwise on the first Homebrew or /usr/local Node that is. It stays the one
# entry point for local builds (the post-commit hook, `npm run package`,
# `npm run install-app`).
#
# Exit code 0 is still not proof of a build: compare the mtime of
# out/Patton-darwin-arm64/Patton.app/Contents/Resources/app.asar (or, for an
# installing build, /Applications/Patton.app/...) with the commit.
set -euo pipefail

# Forge 8's engines field: ">= 22.13.0".
MIN_MAJOR=22
MIN_MINOR=13

new_enough() {
  local version major minor
  version="$("$1" -v 2>/dev/null)" || return 1
  major="$(echo "$version" | sed -E 's/^v([0-9]+)\..*/\1/')"
  minor="$(echo "$version" | sed -E 's/^v[0-9]+\.([0-9]+)\..*/\1/')"
  [ "$major" -gt "$MIN_MAJOR" ] 2>/dev/null && return 0
  [ "$major" -eq "$MIN_MAJOR" ] 2>/dev/null && [ "$minor" -ge "$MIN_MINOR" ] 2>/dev/null
}

current="$(command -v node || true)"
if [ -n "$current" ] && new_enough "$current"; then
  exec npx electron-forge package "$@"
fi

for candidate in \
  /opt/homebrew/opt/node@24/bin/node \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node; do
  if [ -x "$candidate" ] && new_enough "$candidate"; then
    echo "[forge-package] Node $(node -v 2>/dev/null || echo none) is older than Forge 8 needs; using $candidate ($("$candidate" -v))"
    PATH="$(dirname "$candidate"):$PATH" exec npx electron-forge package "$@"
  fi
done

echo "[forge-package] ERROR: Forge 8 needs Node ${MIN_MAJOR}.${MIN_MINOR} or newer and none was found" >&2
exit 1
