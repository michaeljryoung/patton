#!/usr/bin/env bash
# Runs every scripts/check-*.mjs and scripts/check-*.cjs in turn: one pass/fail
# line per check, full output only for a failure, exit 1 if any failed.
#   JSDOM_DIR=<folder whose node_modules has jsdom >= 30>   enables the jsdom checks
#   CC_LAUNCHER=<path to the cc launcher script>            adds the board's launcher round trip
# Checks that need JSDOM_DIR are skipped (with the reason) when it is unset.
# check-fonts, check-close-electron and check-ui-text-scale start Electron
# hidden (no window is ever shown) and need `npx install-electron --no` once.
set -u
cd "$(dirname "$0")/.." || exit 1

NEEDS_JSDOM=" check-checkpoint-done.mjs check-close-confirm.mjs check-paste-chips.mjs check-pause-all.mjs check-project-board-ui.mjs check-project-board-wire.mjs check-tab-strip-dblclick.mjs "
pass=0; fail=0; skip=0
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

for f in scripts/check-*.mjs scripts/check-*.cjs; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [[ "$NEEDS_JSDOM" == *" $name "* ]] && [ -z "${JSDOM_DIR:-}" ]; then
    echo "SKIP $name (set JSDOM_DIR to a folder whose node_modules has jsdom >= 30)"
    skip=$((skip + 1)); continue
  fi
  if node "$f" >"$log" 2>&1; then
    oks="$(grep -c '^ok' "$log")"
    if [ "$oks" -gt 0 ]; then echo "PASS $name ($oks ok lines)"; else echo "PASS $name"; fi
    pass=$((pass + 1))
  else
    echo "FAIL $name (exit $?)"
    tail -n 25 "$log" | sed 's/^/     /'
    fail=$((fail + 1))
  fi
done

[ -z "${CC_LAUNCHER:-}" ] && echo "note: CC_LAUNCHER unset, check-project-board.mjs skipped its launcher round trip"
echo "checks: $pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ]
