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

# Context reading: synthetic transcripts (jq parser; the osascript fallback
# leaves the ctx fields out by design, checked once).
TD=$(mktemp -d "${TMPDIR:-/tmp}/patton-probe-ctx.XXXXXX")
u() { # assistant line with usage: input, cache read, cache write
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s,"output_tokens":9}},"timestamp":"2026-10-11T05:00:00.000Z"}\n' "$1" "$2" "$3"
}
human() { printf '{"type":"user","message":{"role":"user","content":"%s"},"timestamp":"2026-10-11T04:00:00.000Z","origin":{"kind":"human"}}\n' "$1"; }
CKPT='{"type":"user","message":{"role":"user","content":"<command-message>checkpoint</command-message>\n<command-name>/checkpoint</command-name>"},"timestamp":"2026-10-11T04:48:38.277Z","origin":{"kind":"human"}}'
SKILL='{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: x"}]},"timestamp":"2026-10-11T04:48:38.300Z"}'
QUOTED='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"grep found <command-name>/checkpoint</command-name> in a file"}]},"timestamp":"2026-10-11T06:00:00.000Z"}'
TASKN='{"type":"user","message":{"role":"user","content":"<task-notification>done</task-notification>"},"origin":{"kind":"task-notification"}}'
COMPACT='{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","timestamp":"2026-10-11T07:00:00.000Z"}'
{ human hi; u 10 1000 200; u 5 2000 300; } > "$TD/none.jsonl"                      # ctx 2305
{ human hi; u 10 100000 0; echo "$CKPT"; echo "$SKILL"; u 1 200000 0; u 1 250000 9;
  human next; echo "$QUOTED"; u 1 300000 0; u 0 0 0; } > "$TD/after.jsonl"         # ctx 300001, base 250010
{ cat "$TD/after.jsonl"; echo "$COMPACT"; u 1 50000 0; } > "$TD/compact.jsonl"      # ctx 50001
{ echo "$CKPT"; u 0 400000 0; echo "$TASKN"; u 0 500000 0; } > "$TD/taskn.jsonl"   # turn ends at the notification
{ echo "$CKPT"; u 0 400000 0; human next; echo "$COMPACT"; u 0 90000 0; human x; } > "$TD/below.jsonl"  # compact wins
{ echo "$CKPT"; u 0 400000 0; human next; u 0 100000 0; } > "$TD/drop.jsonl"     # ctx < baseline, no compact line
{ echo "$CKPT"; u 0 400000 0; } > "$TD/current.jsonl"                              # the checkpoint is the last turn
: > "$TD/empty.jsonl"
CPT=1791694118
ctxjson() { printf '{"session_id":"s","transcript_path":"%s","cwd":"/x","hook_event_name":"Stop"%s}' "$1" "$2"; }
BOTH=',"background_tasks":[],"session_crons":[]'
stopwant() { printf '{"terminalSequence":"\\u001b]777;patton;stop;tasks=0;crons=0%s\\u0007"}' "$1"; }
ctxwant() { printf '{"terminalSequence":"\\u001b]777;patton;ctx%s\\u0007"}' "$1"; }
PARSER=jq
check "ctx: no checkpoint (since = ctx)" "$(stopwant ';ctx=2305;since=2305')" "$(ctxjson "$TD/none.jsonl" "$BOTH")"
check "ctx: checkpoint turn, then work (quoted tag, skill line ignored)" \
  "$(stopwant ";ctx=300001;since=49991;cpt=$CPT")" "$(ctxjson "$TD/after.jsonl" "$BOTH")"
check "ctx: compact boundary after the checkpoint (since = ctx)" \
  "$(stopwant ";ctx=50001;since=50001;cpt=$CPT")" "$(ctxjson "$TD/compact.jsonl" "$BOTH")"
check "ctx: task notification ends the checkpoint turn" \
  "$(stopwant ";ctx=500000;since=100000;cpt=$CPT")" "$(ctxjson "$TD/taskn.jsonl" "$BOTH")"
check "ctx: compact after the turn, ctx below the old baseline" \
  "$(stopwant ";ctx=90000;since=90000;cpt=$CPT")" "$(ctxjson "$TD/below.jsonl" "$BOTH")"
check "ctx: ctx below the baseline with no compact line (since = ctx)" \
  "$(stopwant ";ctx=100000;since=100000;cpt=$CPT")" "$(ctxjson "$TD/drop.jsonl" "$BOTH")"
check "ctx: stop of the checkpoint turn itself (since 0)" \
  "$(stopwant ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/current.jsonl" "$BOTH")"
check "ctx: missing transcript (as before)" "$(stopwant '')" "$(ctxjson "$TD/nope.jsonl" "$BOTH")"
check "ctx: empty transcript (as before)" "$(stopwant '')" "$(ctxjson "$TD/empty.jsonl" "$BOTH")"
check "ctx: no task fields (ctx message only)" \
  "$(ctxwant ";ctx=300001;since=49991;cpt=$CPT")" "$(ctxjson "$TD/after.jsonl" '')"
check "ctx: no task fields, missing transcript (nothing)" "" "$(ctxjson "$TD/nope.jsonl" '')"
PARSER=osascript
check "ctx: osascript fallback leaves the ctx fields out" "$(stopwant '')" "$(ctxjson "$TD/after.jsonl" "$BOTH")"
rm -f "$TD"/*.jsonl && rmdir "$TD"

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
