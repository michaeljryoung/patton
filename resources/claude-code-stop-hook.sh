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
# Context reading (the tab strip's checkpoint clock). From the transcript at
# `transcript_path` (JSONL, often tens of MB, so only tail and perl touch the
# whole file and jq sees a few dozen lines) the stop sequence gains
#   …;tasks=N;crons=M;ctx=C;since=S[;cpt=T]
#   C  tokens of the session's latest request: input + cache read + cache
#      write from the `message.usage` of the last line that has one (the
#      method of ~/.claude/hooks/context-meter.py; an all-zero usage, which a
#      synthetic message carries, is skipped).
#   S  C minus the context at the end of the last /checkpoint turn: the user
#      line carrying `<command-name>/checkpoint</command-name>` (a human
#      prompt) up to the next human prompt or task notification; its last
#      usage is the baseline. No checkpoint, a `compact_boundary` after it, or
#      C below the baseline: baseline 0.
#   T  that checkpoint line's timestamp in Unix seconds (absent without one).
# A Stop input with neither task field gets no stop sequence (see Fail-open);
# then the reading travels alone as
#   {"terminalSequence":"\u001b]777;patton;ctx;ctx=C;since=S[;cpt=T]\u0007"}
# so it never touches the dot or the parked ring. No readable transcript, or
# no usage in it: the ctx fields are left out and the output is as before.
#
# Fail-open: any problem, or a Stop input with neither field (older Claude
# Code, or its task registry unreachable), prints no stop sequence and exits
# 0, which leaves Patton on its title-glyph fallback.
#
# Parser: jq (/usr/bin/jq ships with macOS 15+), else JavaScript for
# Automation through osascript (every macOS). The osascript fallback sends
# the task counts only, never the context reading. Running Patton's own Electron
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

# --- Context reading (jq + perl; see the header) ---
# The whole transcript is only ever streamed through perl (/usr/bin/perl ships
# with macOS; it scans 75 MB in ~20 ms, where BSD grep takes ~250 ms a pass);
# jq parses a few dozen selected lines. Hook budget: well under a second.
PERL=/usr/bin/perl
[ -x "$PERL" ] || PERL=$(command -v perl 2>/dev/null)

# Request size of the last line on stdin whose message.usage is non-zero.
usage_of() {
  "$PERL" -ne 'print if index($_, q("usage")) >= 0' | tail -n 40 | "$JQ" -R -r '
    fromjson? | try (
      select(.isSidechain != true) | .message.usage | objects
      | ((.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0))
      | select(type == "number" and . > 0) | floor
    ) catch empty' 2>/dev/null | tail -n 1
}

context_fields() { # transcript path -> ";ctx=C;since=S[;cpt=T]" or nothing
  local t="$1" ctx cp line ts range base since
  [ -n "$PERL" ] || return 0
  # The last usage sits near the end; a tail that holds none (one huge tool
  # result) falls back to the whole file.
  ctx=$(tail -c 2097152 "$t" | usage_of)
  [ -n "$ctx" ] || ctx=$(usage_of < "$t")
  [[ "$ctx" =~ ^[0-9]+$ ]] || return 0

  # Last human /checkpoint prompt: "<line> <unix seconds or empty>". The tag
  # also turns up quoted in tool results and agent briefs, so jq checks the
  # line is a human prompt (origin human; an older line with no origin counts
  # when its content is a plain string) and the tag is in its own text.
  cp=$("$PERL" -ne '
      if (index($_, q(<command-name>/checkpoint</command-name>)) >= 0 && index($_, q("type":"user")) >= 0) {
        push @c, "$.:$_"; shift @c if @c > 20;
      }
      END { print @c }' "$t" | "$JQ" -R -r '
    (index(":")) as $i | .[:$i] as $n | (.[$i+1:] | fromjson?) as $o
    | try (
      select($o.type == "user" and ($o.isMeta != true) and ($o.isSidechain != true))
      | select(($o.origin.kind? // null) == "human"
               or ($o.origin == null and ($o.message.content | type) == "string"))
      | select(($o.message.content
                | if type == "string" then . else ([.[]? | select(.type? == "text") | .text] | join("\n")) end)
               | contains("<command-name>/checkpoint</command-name>"))
      | $n + " " + ((try ($o.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | floor | tostring) catch "") // "")
    ) catch empty' 2>/dev/null | tail -n 1)

  base=0; ts=""
  if [[ "$cp" =~ ^([0-9]+)\ ([0-9]*)$ ]]; then
    line=${BASH_REMATCH[1]}; ts=${BASH_REMATCH[2]}
    # One pass from the checkpoint line: its turn ends at the next human
    # prompt or task notification; keep the usage lines inside it, unless a
    # compact_boundary follows the checkpoint anywhere (then baseline 0).
    range=$(L="$line" "$PERL" -ne '
        next if $. < $ENV{L};
        if (index($_, q("subtype":"compact_boundary")) >= 0) { $b = 1; last }
        if (!$end && $. > $ENV{L} && (index($_, q("origin":{"kind":"human")) >= 0
            || index($_, q("origin":{"kind":"task-notification")) >= 0)) { $end = 1 }
        if (!$end && index($_, q("usage")) >= 0) { push @u, $_; shift @u if @u > 40 }
        END { print($b ? "COMPACT\n" : @u) }' "$t")
    if [ "$range" != COMPACT ]; then
      base=$(printf '%s\n' "$range" | usage_of)
      [[ "$base" =~ ^[0-9]+$ ]] || base=0
    fi
  fi
  [ "$ctx" -ge "$base" ] || base=0
  since=$((ctx - base))
  printf ';ctx=%s;since=%s' "$ctx" "$since"
  [ -n "$ts" ] && printf ';cpt=%s' "$ts"
  return 0
}

ctxf=""
if [ -n "$JQ" ]; then
  tpath=$(printf '%s' "$input" | "$JQ" -r '.transcript_path | strings' 2>/dev/null)
  if [ -n "$tpath" ] && [ -f "$tpath" ] && [ -r "$tpath" ]; then
    ctxf=$(context_fields "$tpath" 2>/dev/null)
  fi
fi

if [[ "$counts" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
  printf '{"terminalSequence":"\\u001b]777;patton;stop;tasks=%s;crons=%s%s\\u0007"}\n' \
    "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$ctxf"
elif [ -n "$ctxf" ]; then
  printf '{"terminalSequence":"\\u001b]777;patton;ctx%s\\u0007"}\n' "$ctxf"
fi
exit 0
