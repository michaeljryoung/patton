#!/bin/bash
# Probe for resources/claude-code-stop-hook.sh: feeds it synthetic Claude Code
# Stop inputs and checks the exact stdout, through both parsers (jq, and the
# osascript/JXA fallback). Needs nothing but macOS (jq from /usr/bin on 15+ or
# PATH). Exit non-zero on any mismatch.
HOOK="$(cd "$(dirname "$0")/.." && pwd)/resources/claude-code-stop-hook.sh"
fail=0

expect_seq() { # name, tasks, crons, json
  local want="{\"terminalSequence\":\"\\u001b]777;patton;stop;tasks=$2;crons=$3\\u0007\"}"
  check "$1" "$want" "$4"
}

check() { # name, wanted stdout, json
  local got
  got=$(printf '%s' "$3" | PATTON_HOOK_PARSER="$PARSER" "$HOOK"); rc=$?
  if [ "$got" = "$2" ] && [ $rc -eq 0 ]; then
    echo "ok   [$PARSER] $1"
  else
    echo "FAIL [$PARSER] $1: rc=$rc got <$got> want <$2>"; fail=1
  fi
}

COMMON='"session_id":"s","transcript_path":"/x","cwd":"/x","hook_event_name":"Stop","stop_hook_active":false'
for PARSER in jq osascript; do
  expect_seq "one running subagent" 1 0 \
    "{$COMMON,\"background_tasks\":[{\"id\":\"a1\",\"type\":\"subagent\",\"status\":\"running\",\"description\":\"d\",\"agent_type\":\"builder\"}],\"session_crons\":[]}"
  expect_seq "cron only" 0 1 \
    "{$COMMON,\"background_tasks\":[],\"session_crons\":[{\"id\":\"c1\",\"schedule\":\"*/5 * * * *\",\"recurring\":true,\"prompt\":\"p\"}]}"
  expect_seq "both empty" 0 0 "{$COMMON,\"background_tasks\":[],\"session_crons\":[]}"
  expect_seq "completed task counts as 0" 0 0 \
    "{$COMMON,\"background_tasks\":[{\"id\":\"b1\",\"type\":\"shell\",\"status\":\"completed\",\"description\":\"d\",\"command\":\"ls\"}],\"session_crons\":[]}"
  expect_seq "mixed: missing status + pending + failed" 2 0 \
    "{$COMMON,\"background_tasks\":[{\"id\":\"1\"},{\"id\":\"2\",\"status\":\"pending\"},{\"id\":\"3\",\"status\":\"Failed\"}],\"session_crons\":[]}"
  for AMB in dream auto_mode_scan local_memory_import; do
    expect_seq "ambient $AMB task not counted" 0 0 \
      "{$COMMON,\"background_tasks\":[{\"id\":\"x\",\"type\":\"$AMB\",\"status\":\"running\"}],\"session_crons\":[]}"
  done
  expect_seq "ambient dream + running subagent" 1 0 \
    "{$COMMON,\"background_tasks\":[{\"id\":\"x\",\"type\":\"dream\",\"status\":\"running\"},{\"id\":\"y\",\"type\":\"local_agent\",\"status\":\"running\"}],\"session_crons\":[]}"
  check "neither field: prints nothing" "" "{$COMMON}"
  check "malformed JSON: prints nothing" "" "{not json"
done

# Quoted path: the installer's command (hookCommand in src/main/claude-hook.ts),
# run the way Claude Code runs hook commands (through `sh -c`), for a script
# whose folder has a space, a quote, `$` and a backtick. Needs Node 22.18+
# (runs the TypeScript directly); skipped without it.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1; then
  TMPD=$(mktemp -d "${TMPDIR:-/tmp}/patton-probe.XXXXXX")
  ODD="$TMPD/App Support/it's \$HOME \`id\`"
  mkdir -p "$ODD" && cp "$HOOK" "$ODD/hook.sh" && chmod 755 "$ODD/hook.sh"
  cmd=$(node --no-warnings -e '
    import(process.argv[1]).then((m) => process.stdout.write(
      m.hookCommand({ bundledScript: "", installedScript: process.argv[2], settingsFile: "" })));
  ' "$ROOT/src/main/claude-hook.ts" "$ODD/hook.sh")
  want="{\"terminalSequence\":\"\\u001b]777;patton;stop;tasks=0;crons=0\\u0007\"}"
  got=$(printf '%s' "{$COMMON,\"background_tasks\":[],\"session_crons\":[]}" | /bin/sh -c "$cmd"); rc=$?
  if [ -n "$cmd" ] && [ "$got" = "$want" ] && [ $rc -eq 0 ]; then
    echo "ok   quoted path: $cmd"
  else
    echo "FAIL quoted path: rc=$rc cmd <$cmd> got <$got>"; fail=1
  fi
  rm -f "$ODD/hook.sh" && rmdir "$ODD" "$TMPD/App Support" "$TMPD"
else
  echo "skip quoted path (no node)"
fi

if [ $fail -ne 0 ]; then echo "probe FAILED"; exit 1; fi
echo "probe passed"
