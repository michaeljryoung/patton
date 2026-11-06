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
  check "neither field: prints nothing" "" "{$COMMON}"
  check "malformed JSON: prints nothing" "" "{not json"
done

if [ $fail -ne 0 ]; then echo "probe FAILED"; exit 1; fi
echo "probe passed"
