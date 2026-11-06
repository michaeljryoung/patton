#!/bin/bash
# Patton's Claude Code Stop hook: tells Patton whether a turn that just ended
# still has background work in flight (so the session is parked, not waiting
# on you).
#
# Protocol. Claude Code passes the Stop input as JSON on stdin; we read
# `background_tasks` (array of {id, type, status, ...}) and `session_crons`
# (array of scheduled wakeups). We print one JSON object on stdout:
#   {"terminalSequence":"\u001b]777;patton;stop;tasks=N;crons=M\u0007"}
# Claude Code writes that OSC 777 sequence to the terminal for us (a hook has
# no tty of its own). N = tasks whose status isn't a finished one (a missing
# status counts as in flight), leaving out AMBIENT types; M = scheduled crons.
# Claude Code already lists only running/pending work, so FINISHED is a
# belt-and-braces filter. AMBIENT: dreams, auto-mode scans and memory
# imports, which Claude Code stops with `ambient: true` and which never wake
# the session, so counting them would park a pane that is waiting on you. Patton parses it in
# terminal-view.ts and pane.ts (handleHookStop).
#
# Fail-open: any problem, or a Stop input with neither field (older Claude
# Code, or its task registry unreachable), prints nothing and exits 0, which
# leaves Patton on its title-glyph fallback.
#
# Parser: jq (/usr/bin/jq ships with macOS 15+), else JavaScript for
# Automation through osascript (every macOS). Running Patton's own Electron
# binary as Node is not an option: the packaged app's RunAsNode fuse is off,
# so ELECTRON_RUN_AS_NODE would launch the app instead.

input=$(cat 2>/dev/null) || exit 0
FINISHED='["completed","failed","killed","cancelled","canceled","done","finished","stopped"]'
AMBIENT='["dream","auto_mode_scan","local_memory_import"]'

counts=""
JQ=$(command -v jq 2>/dev/null || { [ -x /usr/bin/jq ] && echo /usr/bin/jq; })
[ "${PATTON_HOOK_PARSER:-}" = osascript ] && JQ=""  # lets the probe test the fallback
if [ -n "$JQ" ]; then
  counts=$(printf '%s' "$input" | "$JQ" -r --argjson fin "$FINISHED" --argjson amb "$AMBIENT" '
    def arr(f): (f | if type == "array" then . else [] end);
    if (has("background_tasks") or has("session_crons")) | not then empty else
      ([arr(.background_tasks)[]
        | select((((.status // "running") | tostring | ascii_downcase) as $s | $fin | index($s)) == null)
        | select(((.type // "") | tostring) as $t | $amb | index($t) | not)]
        | length | tostring) + " " + (arr(.session_crons) | length | tostring)
    end' 2>/dev/null)
elif [ -x /usr/bin/osascript ]; then
  counts=$(printf '%s' "$input" | /usr/bin/osascript -l JavaScript -e '
    ObjC.import("Foundation");
    const raw = $.NSString.alloc.initWithDataEncoding(
      $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
    const j = JSON.parse(raw), fin = '"$FINISHED"', amb = '"$AMBIENT"';
    const arr = (v) => Array.isArray(v) ? v : [];
    if (!("background_tasks" in j) && !("session_crons" in j)) { "" } else {
      const t = arr(j.background_tasks).filter((x) =>
        !fin.includes(String((x && x.status) || "running").toLowerCase()) &&
        !amb.includes(String((x && x.type) || ""))).length;
      t + " " + arr(j.session_crons).length;
    }' 2>/dev/null)
fi

if [[ "$counts" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
  printf '{"terminalSequence":"\\u001b]777;patton;stop;tasks=%s;crons=%s\\u0007"}\n' \
    "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
exit 0
