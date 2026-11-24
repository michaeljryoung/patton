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
  # The tp, tl and cl fields have cases of their own below; here they are cut off.
  got=$(printf '%s' "$got" | sed -E 's#;(tp|tl|cl)=[A-Za-z0-9+/=]*##g')
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
  # Claude Code 2.1.321 sends friendly labels (cLe maps local_agent to
  # "subagent", auto_mode_scan to "auto-mode scan", ...), so match both forms.
  for AMB in dream auto_mode_scan local_memory_import "auto-mode scan" "memory import"; do
    expect_seq "ambient $AMB task not counted" 0 0 \
      "{$COMMON,\"background_tasks\":[{\"id\":\"x\",\"type\":\"$AMB\",\"status\":\"running\"}],\"session_crons\":[]}"
  done
  expect_seq "ambient dream + running subagent" 1 0 \
    "{$COMMON,\"background_tasks\":[{\"id\":\"x\",\"type\":\"dream\",\"status\":\"running\"},{\"id\":\"y\",\"type\":\"local_agent\",\"status\":\"running\"}],\"session_crons\":[]}"
  check "neither field: prints nothing" "" "{$COMMON}"
  check "malformed JSON: prints nothing" "" "{not json"
done

# The lists (tp, tl, cl): decoded and compared as text, through both parsers.
seq_of() { printf '%s' "$1" | PATTON_HOOK_PARSER="$PARSER" "$HOOK" | /usr/bin/jq -r '.terminalSequence // empty' 2>/dev/null; }
field() { # sequence, key -> the decoded field, or "<absent>"
  local v
  v=$(printf '%s' "$1" | sed -nE "s#.*;$2=([A-Za-z0-9+/=]*).*#\\1#p")
  if [ -z "$v" ]; then printf '<absent>'; else printf '%s' "$v" | /usr/bin/base64 -d 2>/dev/null; fi
}
expect_field() { # name, sequence, key, wanted decoded text
  local got; got=$(field "$2" "$3")
  if [ "$got" = "$4" ]; then echo "ok   [$PARSER] $1"; else echo "FAIL [$PARSER] $1: got <$got> want <$4>"; fail=1; fi
}
expect_true() { # name, condition result (0 = true), detail
  if [ "$2" -eq 0 ]; then echo "ok   [$PARSER] $1"; else echo "FAIL [$PARSER] $1: $3"; fail=1; fi
}
tasks_json() { # N running tasks with long unicode descriptions
  /usr/bin/jq -c -n --argjson n "$1" '{session_id:"s",transcript_path:"/x",cwd:"/x",hook_event_name:"Stop",
    background_tasks:[range($n) | {id:("task-" + tostring), type:"subagent", status:"running",
      description:("naïve résumé 😀 " + ("long description " * 8)), agent_type:"builder"}], session_crons:[]}'
}
xs() { printf 'x%.0s' $(seq 1 "$1"); }
for PARSER in jq osascript; do
  S=$(seq_of "{$COMMON,\"background_tasks\":[{\"id\":\"a1\",\"type\":\"subagent\",\"status\":\"running\",\"description\":\"fix the build\"},{\"id\":\"b2\",\"type\":\"shell\",\"status\":\"completed\",\"description\":\"done\"},{\"id\":\"m1\",\"type\":\"memory import\",\"status\":\"running\",\"description\":\"ambient\"}],\"session_crons\":[{\"id\":\"c1\",\"schedule\":\"*/5 * * * *\",\"recurring\":true,\"prompt\":\"check CI\"},{\"id\":\"c2\",\"schedule\":\"30 9 * * 1\",\"recurring\":false,\"prompt\":\"once\"}]}")
  expect_field "lists: tl holds the running non-ambient task only" "$S" tl '[{"id":"a1","type":"subagent","d":"fix the build"}]'
  expect_field "lists: cl holds both crons, recurring as a boolean" "$S" cl '[{"id":"c1","s":"*/5 * * * *","r":true,"p":"check CI"},{"id":"c2","s":"30 9 * * 1","r":false,"p":"once"}]'
  expect_field "lists: tp is the transcript path" "$S" tp '/x'
  case "$S" in *'tasks=1;crons=2;tp='*) expect_true "lists: counts first, then tp, tl, cl" 0 "";; *) expect_true "lists: counts first, then tp, tl, cl" 1 "<$S>";; esac

  S=$(seq_of "{$COMMON,\"background_tasks\":[{\"id\":\"q\",\"type\":\"shell\",\"status\":\"running\",\"description\":\"say \\\"hi\\\" naïve 😀 — \\\\ back\\nsecond line\\ttab\"}],\"session_crons\":[{\"id\":\"c\",\"schedule\":\"* * * * *\",\"recurring\":true,\"prompt\":\"a \\\"b\\\"\\nc\"}]}")
  expect_field "lists: quotes, unicode, a newline and a tab in a description" "$S" tl '[{"id":"q","type":"shell","d":"say \"hi\" naïve 😀 — \\ back second line tab"}]'
  expect_field "lists: a newline and quotes in a cron prompt" "$S" cl '[{"id":"c","s":"* * * * *","r":true,"p":"a \"b\" c"}]'

  LONG=$(xs 200)
  S=$(seq_of "{$COMMON,\"background_tasks\":[{\"id\":\"l\",\"type\":\"shell\",\"status\":\"running\",\"description\":\"$LONG\"}],\"session_crons\":[{\"id\":\"c\",\"schedule\":\"* * * * *\",\"recurring\":true,\"prompt\":\"$LONG\"}]}")
  expect_field "lists: a long description is cut to 80 characters" "$S" tl "[{\"id\":\"l\",\"type\":\"shell\",\"d\":\"$(xs 80)\"}]"
  expect_field "lists: a long cron prompt is cut to 80 characters" "$S" cl "[{\"id\":\"c\",\"s\":\"* * * * *\",\"r\":true,\"p\":\"$(xs 80)\"}]"

  S=$(seq_of "{$COMMON,\"background_tasks\":[],\"session_crons\":[]}")
  expect_field "lists: empty lists are sent as []" "$S" tl '[]'
  S=$(seq_of "{\"session_id\":\"s\",\"hook_event_name\":\"Stop\",\"background_tasks\":[]}")
  expect_field "lists: no cron field -> no cl" "$S" cl '<absent>'
  expect_field "lists: no transcript_path -> no tp" "$S" tp '<absent>'
  expect_field "lists: tl still sent when only tasks arrived" "$S" tl '[]'

  # 40 tasks with 150-character descriptions: cut to fit, every id kept.
  S=$(seq_of "$(tasks_json 40)")
  BYTES=$(printf '%s' "$S" | LC_ALL=C wc -c | tr -d ' ')
  echo "info [$PARSER] 40-task sequence: $BYTES bytes"
  expect_true "40 tasks: the whole sequence is under 3500 bytes" "$([ "$BYTES" -gt 0 ] && [ "$BYTES" -le 3500 ] && echo 0 || echo 1)" "$BYTES bytes"
  case "$S" in *'tasks=40;crons=0;'*) expect_true "40 tasks: tasks=40 kept" 0 "";; *) expect_true "40 tasks: tasks=40 kept" 1 "<$S>";; esac
  TL=$(field "$S" tl)
  N=$(printf '%s' "$TL" | /usr/bin/jq 'length' 2>/dev/null)
  expect_true "40 tasks: the list parses and keeps all 40 ids" "$([ "$N" = 40 ] && echo 0 || echo 1)" "length=$N"
  LASTID=$(printf '%s' "$TL" | /usr/bin/jq -r '.[-1].id' 2>/dev/null)
  expect_true "40 tasks: the last id is task-39" "$([ "$LASTID" = task-39 ] && echo 0 || echo 1)" "$LASTID"
  DLEN=$(printf '%s' "$TL" | /usr/bin/jq '.[0].d | length' 2>/dev/null)
  expect_true "40 tasks: descriptions were shortened, not left at 80" "$([ "${DLEN:-99}" -lt 80 ] && echo 0 || echo 1)" "d length $DLEN"
  expect_true "40 tasks: the cl field is still there" "$([ "$(field "$S" cl)" = '[]' ] && echo 0 || echo 1)" "$(field "$S" cl)"

  # 150 tasks: not even bare ids fit, so entries are dropped from the end.
  S=$(seq_of "$(tasks_json 150)")
  BYTES=$(printf '%s' "$S" | LC_ALL=C wc -c | tr -d ' ')
  expect_true "150 tasks: the whole sequence is under 3500 bytes" "$([ "$BYTES" -gt 0 ] && [ "$BYTES" -le 3500 ] && echo 0 || echo 1)" "$BYTES bytes"
  case "$S" in *'tasks=150;crons=0;'*) expect_true "150 tasks: tasks=150 kept" 0 "";; *) expect_true "150 tasks: tasks=150 kept" 1 "<$S>";; esac
  TL=$(field "$S" tl)
  N=$(printf '%s' "$TL" | /usr/bin/jq 'length' 2>/dev/null)
  FIRST=$(printf '%s' "$TL" | /usr/bin/jq -r '.[0].id' 2>/dev/null)
  expect_true "150 tasks: the list was cut from the end (first id kept, fewer than 150)" "$([ "$FIRST" = task-0 ] && [ "${N:-0}" -gt 0 ] && [ "${N:-0}" -lt 150 ] && echo 0 || echo 1)" "first=$FIRST length=$N"

  # No task fields (an old Claude Code): nothing is sent, as before.
  check "no task fields: still prints nothing" "" "{$COMMON}"
done
# With a context reading the budget shrinks but the reading is never cut.
PARSER=jq
LTD=$(mktemp -d "${TMPDIR:-/tmp}/patton-probe-lists.XXXXXX")
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":9}},"timestamp":"2026-10-11T05:00:00.000Z"}\n' > "$LTD/t.jsonl"
S=$(seq_of "$(tasks_json 150 | /usr/bin/jq -c --arg t "$LTD/t.jsonl" '.transcript_path = $t')")
BYTES=$(printf '%s' "$S" | LC_ALL=C wc -c | tr -d ' ')
case "$S" in *'tasks=150;crons=0;ctx=1210;since=1210;tp='*) expect_true "150 tasks with a context reading: ctx fields intact" 0 "";; *) expect_true "150 tasks with a context reading: ctx fields intact" 1 "<${S:0:120}>";; esac
expect_true "150 tasks with a context reading: under 3500 bytes" "$([ "$BYTES" -gt 0 ] && [ "$BYTES" -le 3500 ] && echo 0 || echo 1)" "$BYTES bytes"
expect_field "tp is the transcript path with a context reading" "$S" tp "$LTD/t.jsonl"
rm -f "$LTD/t.jsonl" && rmdir "$LTD"

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
  "$(stopwant ";ctx=300001;since=49991;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/after.jsonl" "$BOTH")"
check "ctx: compact boundary after the checkpoint (since = ctx)" \
  "$(stopwant ";ctx=50001;since=50001;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/compact.jsonl" "$BOTH")"
check "ctx: task notification ends the checkpoint turn" \
  "$(stopwant ";ctx=500000;since=100000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/taskn.jsonl" "$BOTH")"
check "ctx: compact after the turn, ctx below the old baseline" \
  "$(stopwant ";ctx=90000;since=90000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/below.jsonl" "$BOTH")"
check "ctx: ctx below the baseline with no compact line (since = ctx)" \
  "$(stopwant ";ctx=100000;since=100000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/drop.jsonl" "$BOTH")"
check "ctx: stop of the checkpoint turn itself (since 0)" \
  "$(stopwant ";ctx=400000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/current.jsonl" "$BOTH")"
check "ctx: missing transcript (as before)" "$(stopwant '')" "$(ctxjson "$TD/nope.jsonl" "$BOTH")"
check "ctx: empty transcript (as before)" "$(stopwant '')" "$(ctxjson "$TD/empty.jsonl" "$BOTH")"
check "ctx: no task fields (ctx message only)" \
  "$(ctxwant ";ctx=300001;since=49991;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/after.jsonl" '')"
check "ctx: no task fields, missing transcript (nothing)" "" "$(ctxjson "$TD/nope.jsonl" '')"
PARSER=osascript
check "ctx: osascript fallback leaves the ctx fields out" "$(stopwant '')" "$(ctxjson "$TD/after.jsonl" "$BOTH")"

PARSER=jq
# Skill-tool checkpoint, attachment/peer lines, tool-result flood, perl magic open.
SKILLCALL='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Skill","input":{"skill":"checkpoint"}}],"usage":{"input_tokens":1,"cache_read_input_tokens":200000,"cache_creation_input_tokens":0,"output_tokens":9}},"timestamp":"2026-10-11T04:48:38.277Z"}'
ATTACH='{"type":"attachment","attachment":{"type":"queued_command","origin":{"kind":"human"},"prompt":"x"},"timestamp":"2026-10-11T05:30:00.000Z"}'
PEER='{"type":"user","message":{"role":"user","content":"hello from a peer"},"origin":{"kind":"peer"}}'
{ human hi; u 10 100000 0; echo "$SKILLCALL"; u 1 250000 0; human next; u 1 300000 0; } > "$TD/skill.jsonl"
check "ctx: model-invoked checkpoint (Skill tool_use) is a start, turn ends at the next human prompt" \
  "$(stopwant ";ctx=300001;since=50000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/skill.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$ATTACH"; u 0 500000 0; echo "$PEER"; u 0 600000 0; } > "$TD/attach.jsonl"
check "ctx: attachment with an origin and a peer message don't end the turn" \
  "$(stopwant ";ctx=600000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/attach.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; human next; u 0 450000 0; for i in $(seq 1 30); do echo "$QUOTED"; done; u 0 480000 0; } > "$TD/flood.jsonl"
check "ctx: 30 tool results quoting the tag don't push the checkpoint out of the window" \
  "$(stopwant ";ctx=480000;since=80000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/flood.jsonl" "$BOTH")"
# When the checkpoint finished (cpd) and when it was cut off (18 Nov 2026).
ONE=',"background_tasks":[{"id":"a1","type":"subagent","status":"running"}],"session_crons":[]'
CRON=',"background_tasks":[],"session_crons":[{"id":"c1","schedule":"*/5 * * * *","recurring":true,"prompt":"p"}]'
stopwantN() { printf '{"terminalSequence":"\\u001b]777;patton;stop;tasks=%s;crons=%s%s\\u0007"}' "$1" "$2" "$3"; }
INTR='{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-10-11T04:50:00.000Z"}'
INTRT='{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"timestamp":"2026-10-11T04:50:00.000Z"}'
INTRS='{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"},"timestamp":"2026-10-11T04:50:00.000Z"}'
COMMIT1='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"python3 ~/.claude/scripts/checkpoint-commit.py --session 3","description":"Commit"}}]},"timestamp":"2026-10-11T04:55:00.000Z"}'
COMMIT2='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"cd /x; PATTON_NO_INSTALL=1 python3 /abs/checkpoint-commit.py","description":"Commit"}}]},"timestamp":"2026-10-11T04:55:00.000Z"}'
# A commit step's own result (tool_use id "b"): success, refused, failed.
COMMITOK='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b","content":"OK committed"}]},"timestamp":"2026-10-11T04:55:10.000Z"}'
COMMITNO='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b","is_error":true,"content":"The user doesn'"'"'t want to proceed with this tool use."}]},"timestamp":"2026-10-11T04:55:10.000Z"}'
COMMITERR='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b","is_error":true,"content":"Exit code 1\nFAIL"}]},"timestamp":"2026-10-11T04:55:10.000Z"}'
OTHEROK='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"zz","content":"OK"}]},"timestamp":"2026-10-11T04:55:10.000Z"}'
COMMITCR='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"cd /x;\rcheckpoint-commit.py","description":"Commit"}}]},"timestamp":"2026-10-11T04:55:00.000Z"}'
EARLY='{"type":"user","message":{"role":"user","content":"<command-message>checkpoint</command-message>\n<command-name>/checkpoint</command-name>"},"timestamp":"2026-10-11T03:00:00.000Z","origin":{"kind":"human"}}'
EARLYT=1791687600
# Lines that must NOT count as an interrupt or a commit step.
NI_TEXT='{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"[Request interrupted by user] is what Claude Code writes"}]},"timestamp":"2026-10-11T04:50:00.000Z"}'
NI_RESULT='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"[Request interrupted by user]"}]},"timestamp":"2026-10-11T04:50:00.000Z"}'
NI_SIDE='{"type":"user","isSidechain":true,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-10-11T04:50:00.000Z"}'
NC_QUOTE='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"python3 -c \"print('"'"'checkpoint-commit.py'"'"' in cmd)\"","description":"x"}}]},"timestamp":"2026-10-11T04:55:00.000Z"}'
NC_PATH='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"wc -l ~/.claude/scripts/checkpoint-commit.py\n# then checkpoint-commit.py runs","description":"x"}}]},"timestamp":"2026-10-11T04:55:00.000Z"}'
NC_DQUOTE='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"grep -c \"checkpoint-commit.py\" notes.txt","description":"x"}}]},"timestamp":"2026-10-11T04:55:00.000Z"}'
check "cpd: start, Stop with its own task running: cpt, no cpd" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/current.jsonl" "$ONE")"
check "cpd: same file, Stop with no task: cpd" \
  "$(stopwant ";ctx=400000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/current.jsonl" "$BOTH")"
check "cpd: a cron alone doesn't hold it back" \
  "$(stopwantN 0 1 ";ctx=400000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/current.jsonl" "$CRON")"
# Own tasks (24 Nov 2026): only work launched in the checkpoint's turn holds cpd.
# Launch lines as Claude Code 2.1.321 writes them: a background Bash, an async Agent.
LBASH() { printf '{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"tool_use_id":"tb%s","type":"tool_result","content":"Command running in background with ID: %s."}]},"timestamp":"2026-10-11T04:40:00.000Z","toolUseResult":{"stdout":"","backgroundTaskId":"%s"}}\n' "$1" "$1" "$1"; }
LAGENT() { printf '{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"tool_use_id":"ta%s","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\\nagentId: %s"}]}]},"timestamp":"2026-10-11T04:40:00.000Z","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"%s"}}\n' "$1" "$1" "$1"; }
TN() { printf '{"type":"user","message":{"role":"user","content":"<task-notification>\\n<task-id>%s</task-id>\\n<status>completed</status>\\n</task-notification>"},"origin":{"kind":"task-notification"}}\n' "$1"; }
RUN() { local s='' x; for x in "$@"; do s="$s${s:+,}{\"id\":\"$x\",\"type\":\"shell\",\"status\":\"running\",\"description\":\"d\"}"; done
  printf ',"background_tasks":[%s],"session_crons":[]' "$s"; }
{ human hi; LBASH bmon0old1; u 0 300000 0; echo "$CKPT"; u 0 400000 0; } > "$TD/own-old.jsonl"
check "own: a task launched before the checkpoint doesn't hold cpd" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/own-old.jsonl" "$(RUN bmon0old1)")"
{ human hi; LBASH bmon0old1; echo "$CKPT"; LBASH bckpt0own; u 0 400000 0; } > "$TD/own-new.jsonl"
check "own: its own background job still running: no cpd" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/own-new.jsonl" "$(RUN bckpt0own)")"
check "own: its own job and an older one running: no cpd" \
  "$(stopwantN 2 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/own-new.jsonl" "$(RUN bmon0old1 bckpt0own)")"
{ cat "$TD/own-new.jsonl"; TN bckpt0own; u 0 410000 0; } > "$TD/own-done.jsonl"
check "own: its job ended (notification turn), the older one still running: cpd" \
  "$(stopwantN 1 0 ";ctx=410000;since=10000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/own-done.jsonl" "$(RUN bmon0old1)")"
{ echo "$CKPT"; u 0 400000 0; TN x; LAGENT a0123456789abcdef; u 0 410000 0; } > "$TD/own-taskn.jsonl"
check "own: an agent launched in a task-notification turn of the checkpoint holds it" \
  "$(stopwantN 1 0 ";ctx=410000;since=10000;cpt=$CPT")" "$(ctxjson "$TD/own-taskn.jsonl" "$(RUN a0123456789abcdef)")"
{ echo "$CKPT"; u 0 400000 0; human next; LBASH blater000; u 0 410000 0; } > "$TD/own-later.jsonl"
check "own: a task launched after his next prompt doesn't hold it" \
  "$(stopwantN 1 0 ";ctx=410000;since=10000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/own-later.jsonl" "$(RUN blater000)")"
check "own: an id never launched in the transcript holds it (unknown, as before)" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/own-old.jsonl" "$(RUN bnowhere0)")"
check "own: an empty id holds it" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/own-old.jsonl" ',"background_tasks":[{"type":"shell","status":"running"}],"session_crons":[]')"
check "own: an id must match whole (bmon0old1 launched, bmon0old running): holds" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/own-old.jsonl" "$(RUN bmon0old)")"
# A shell a subagent launched: dated by the agent's own launch in the main transcript.
mkdir -p "$TD/sub/subagents"
{ human hi; LAGENT aold000000000000a; echo "$CKPT"; LAGENT anew000000000000b; u 0 400000 0; } > "$TD/sub.jsonl"
{ LBASH bbyold000 | sed 's/"isSidechain":false/"isSidechain":true,"agentId":"aold000000000000a"/'; } > "$TD/sub/subagents/agent-aold000000000000a.jsonl"
{ LBASH bbynew000 | sed 's/"isSidechain":false/"isSidechain":true,"agentId":"anew000000000000b"/'; } > "$TD/sub/subagents/agent-anew000000000000b.jsonl"
check "own: a shell from an agent launched before the checkpoint doesn't hold it" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/sub.jsonl" "$(RUN bbyold000)")"
check "own: a shell from the checkpoint's own agent holds it" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/sub.jsonl" "$(RUN bbynew000)")"
{ LAGENT anest00000000000c | sed 's/"isSidechain":false/"isSidechain":true,"agentId":"anew000000000000b"/'; } >> "$TD/sub/subagents/agent-anew000000000000b.jsonl"
{ LBASH bnested00 | sed 's/"isSidechain":false/"isSidechain":true,"agentId":"anest00000000000c"/'; } > "$TD/sub/subagents/agent-anest00000000000c.jsonl"
check "own: two levels down (agent in the checkpoint's agent) holds it" \
  "$(stopwantN 1 0 ";ctx=400000;since=0;cpt=$CPT")" "$(ctxjson "$TD/sub.jsonl" "$(RUN bnested00)")"
rm -f "$TD"/sub/subagents/*.jsonl && rmdir "$TD/sub/subagents" "$TD/sub"
# The interrupt and commit-rescue rules are unchanged with tasks in flight.
{ human hi; LBASH bmon0old1; echo "$CKPT"; u 0 400000 0; echo "$INTR"; human next; u 0 450000 0; } > "$TD/own-cut.jsonl"
check "own: an interrupted checkpoint with an older task running: no cpt, no cpd" \
  "$(stopwantN 1 0 ";ctx=450000;since=450000")" "$(ctxjson "$TD/own-cut.jsonl" "$(RUN bmon0old1)")"
{ human hi; LBASH bmon0old1; echo "$CKPT"; u 0 400000 0; echo "$INTR"; human "go on"; echo "$COMMIT1"; echo "$COMMITOK"; u 0 450000 0; } > "$TD/own-rescued.jsonl"
check "own: interrupted then committed, an older task running: cpd" \
  "$(stopwantN 1 0 ";ctx=450000;since=50000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/own-rescued.jsonl" "$(RUN bmon0old1)")"
{ echo "$CKPT"; u 0 400000 0; echo "$INTR"; human next; u 0 450000 0; } > "$TD/cut.jsonl"
check "cut off: start then interrupt, no earlier checkpoint: no cpt, no cpd" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/cut.jsonl" "$BOTH")"
check "cut off: ctx message only, no cpt" "$(ctxwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/cut.jsonl" '')"
{ echo "$CKPT"; u 0 400000 0; echo "$INTRT"; human next; u 0 450000 0; } > "$TD/cut-tool.jsonl"
check "cut off: the 'for tool use' interrupt" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/cut-tool.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$INTRS"; human next; u 0 450000 0; } > "$TD/cut-str.jsonl"
check "cut off: an interrupt as string content" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/cut-str.jsonl" "$BOTH")"
{ echo "$EARLY"; u 0 100000 0; human x; u 0 200000 0; cat "$TD/cut.jsonl"; } > "$TD/fallback.jsonl"
check "cut off: falls back to the earlier finished checkpoint (cpt, cpd, since)" \
  "$(stopwant ";ctx=450000;since=350000;cpt=$EARLYT;cpd=$EARLYT")" "$(ctxjson "$TD/fallback.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$INTR"; human "go on"; echo "$COMMIT1"; echo "$COMMITOK"; u 0 450000 0; } > "$TD/resumed.jsonl"
check "not cut off: interrupt, then the commit step" \
  "$(stopwant ";ctx=450000;since=50000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/resumed.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$COMMIT2"; echo "$COMMITOK"; echo "$INTR"; human next; u 0 450000 0; } > "$TD/late-intr.jsonl"
check "not cut off: commit step, then an interrupt" \
  "$(stopwant ";ctx=450000;since=50000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/late-intr.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$COMMIT1"; echo "$COMMITNO"; echo "$INTRT"; human next; u 0 450000 0; } > "$TD/refused.jsonl"
check "cut off: commit step refused (is_error result), then the interrupt" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/refused.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$COMMIT1"; echo "$COMMITERR"; echo "$INTR"; human next; u 0 450000 0; } > "$TD/commit-err.jsonl"
check "cut off: commit step failed (non-zero exit, is_error), then an interrupt" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/commit-err.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$COMMIT1"; echo "$OTHEROK"; echo "$INTR"; human next; u 0 450000 0; } > "$TD/commit-pending.jsonl"
check "cut off: commit step with no result of its own yet (another id's result), then an interrupt" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/commit-pending.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$COMMIT1"; echo "$COMMITERR"; u 0 450000 0; } > "$TD/commit-err-noint.jsonl"
check "no interrupt: a failed commit step doesn't stop cpd" \
  "$(stopwant ";ctx=450000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/commit-err-noint.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$COMMITCR"; echo "$COMMITOK"; echo "$INTR"; human next; u 0 450000 0; } > "$TD/commit-cr.jsonl"
check "not cut off: a commit step after a carriage return (perl prefilter keeps \\r)" \
  "$(stopwant ";ctx=450000;since=50000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/commit-cr.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$NI_TEXT"; echo "$NI_RESULT"; echo "$NI_SIDE"; human next; u 0 450000 0; } > "$TD/not-intr.jsonl"
check "not interrupts: assistant text, tool result, sidechain line" \
  "$(stopwant ";ctx=450000;since=50000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/not-intr.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$INTR"; echo "$NC_QUOTE"; echo "$NC_DQUOTE"; echo "$NC_PATH"; human next; u 0 450000 0; } > "$TD/not-commit.jsonl"
check "not commit steps: the script's name quoted, given to wc, in a comment" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/not-commit.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; human next; u 0 420000 0; echo "$INTR"; human x; u 0 450000 0; } > "$TD/intr-later.jsonl"
check "not cut off: an interrupt after the checkpoint's turn ended (next human prompt)" \
  "$(stopwant ";ctx=450000;since=50000;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/intr-later.jsonl" "$BOTH")"
{ echo "$CKPT"; u 0 400000 0; echo "$TASKN"; u 0 410000 0; echo "$INTR"; human next; u 0 450000 0; } > "$TD/intr-taskn.jsonl"
check "cut off: an interrupt in a task-notification turn before the next human prompt" \
  "$(stopwant ";ctx=450000;since=450000")" "$(ctxjson "$TD/intr-taskn.jsonl" "$BOTH")"
{ echo "$EARLY"; u 0 100000 0; echo "$INTR"; human x; cat "$TD/current.jsonl"; } > "$TD/later-ok.jsonl"
check "a cut-off earlier start doesn't affect a later finished one" \
  "$(stopwant ";ctx=400000;since=0;cpt=$CPT;cpd=$CPT")" "$(ctxjson "$TD/later-ok.jsonl" "$BOTH")"
EVIL="$TD/x;touch pwned|"
cp "$TD/after.jsonl" "$EVIL"
( cd "$TD" && printf '%s' "$(ctxjson "$EVIL" "$BOTH")" | bash "$HOOK" >/dev/null 2>&1 )
if [ -e "$TD/pwned" ]; then echo "FAIL transcript path ending in | was executed"; fail=1; else echo "ok   transcript path ending in | is not executed"; fi
rm -f "$TD"/*.jsonl "$EVIL" "$TD/pwned" && rmdir "$TD"

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
  got=$(printf '%s' "$got" | sed -E 's#;(tp|tl|cl)=[A-Za-z0-9+/=]*##g')
  if [ -n "$cmd" ] && [ "$got" = "$want" ] && [ $rc -eq 0 ]; then
    echo "ok   quoted path: $cmd"
  else
    echo "FAIL quoted path: rc=$rc cmd <$cmd> got <$got>"; fail=1
  fi
  rm -f "$ODD/hook.sh" && rmdir "$ODD" "$TMPD/App Support" "$TMPD"
else
  echo "skip quoted path (no node)"
fi

# The renderer's parse of the OSC 777 message: unknown or malformed trailing
# fields must not cost the stop verdict. The module imports its sibling
# hook-lists.ts, so it is bundled with the repo's esbuild first; skipped without
# node or esbuild.
ESBUILD="$ROOT/node_modules/.bin/esbuild"
if command -v node >/dev/null 2>&1 && [ -x "$ESBUILD" ]; then
  OSCD=$(mktemp -d "${TMPDIR:-/tmp}/patton-probe-osc.XXXXXX")
  "$ESBUILD" "$ROOT/src/renderer/services/patton-osc.ts" --bundle --format=esm --platform=node --log-level=error --outfile="$OSCD/patton-osc.mjs" || fail=1
  out=$(node --no-warnings -e '
    import(process.argv[1]).then((m) => {
      const t = (s) => JSON.stringify(m.parsePattonOsc(s));
      const cases = [
        ["patton;stop;tasks=1;crons=2", "{\"kind\":\"stop\",\"tasks\":1,\"crons\":2,\"context\":null}"],
        ["patton;stop;tasks=0;crons=0;ctx=5;since=3;cpt=9", "{\"kind\":\"stop\",\"tasks\":0,\"crons\":0,\"context\":{\"ctxTokens\":5,\"sinceTokens\":3,\"checkpointAt\":9,\"checkpointDoneAt\":null}}"],
        ["patton;stop;tasks=0;crons=0;ctx=5;since=3;cpt=9;cpd=9", "{\"kind\":\"stop\",\"tasks\":0,\"crons\":0,\"context\":{\"ctxTokens\":5,\"sinceTokens\":3,\"checkpointAt\":9,\"checkpointDoneAt\":9}}"],
        ["patton;ctx;ctx=5;since=3;cpt=9;cpd=1234567890123", "{\"kind\":\"ctx\",\"context\":{\"ctxTokens\":5,\"sinceTokens\":3,\"checkpointAt\":9,\"checkpointDoneAt\":null}}"],
        ["patton;stop;tasks=0;crons=0;ctx=5;since=3;future=abc;x", "{\"kind\":\"stop\",\"tasks\":0,\"crons\":0,\"context\":{\"ctxTokens\":5,\"sinceTokens\":3,\"checkpointAt\":null,\"checkpointDoneAt\":null}}"],
        ["patton;stop;tasks=0;crons=0;ctx=5;since=3;cpt=oops", "{\"kind\":\"stop\",\"tasks\":0,\"crons\":0,\"context\":{\"ctxTokens\":5,\"sinceTokens\":3,\"checkpointAt\":null,\"checkpointDoneAt\":null}}"],
        ["patton;stop;tasks=0;crons=0;ctx=bad;since=3", "{\"kind\":\"stop\",\"tasks\":0,\"crons\":0,\"context\":null}"],
        ["patton;stop;tasks=0;crons=0;zzz", "{\"kind\":\"stop\",\"tasks\":0,\"crons\":0,\"context\":null}"],
        ["patton;ctx;ctx=5;since=3;new=1", "{\"kind\":\"ctx\",\"context\":{\"ctxTokens\":5,\"sinceTokens\":3,\"checkpointAt\":null,\"checkpointDoneAt\":null}}"],
        ["patton;ctx;ctx=5", "null"],
        ["patton;stop;tasks=x;crons=0", "null"],
      ];
      let bad = 0;
      for (const [i, want] of cases) { const got = t(i); if (got !== want) { bad++; console.log("FAIL parse <" + i + "> got " + got); } }
      console.log(bad ? "parse FAILED" : "ok   OSC 777 parse (" + cases.length + " cases)");
      process.exit(bad ? 1 : 0);
    });
  ' "$OSCD/patton-osc.mjs" 2>&1) || fail=1
  echo "$out"
  rm -f "$OSCD/patton-osc.mjs" && rmdir "$OSCD"
else
  echo "skip OSC parse (no node or no esbuild)"
fi

if [ $fail -ne 0 ]; then echo "probe FAILED"; exit 1; fi
echo "probe passed"
