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
# the session, so counting them would park a pane that is waiting on you. They
# are matched by the friendly `type` label Claude Code sends ("auto-mode scan",
# "memory import") and by the raw name. Patton parses it in
# terminal-view.ts and pane.ts (handleHookStop).
#
# Lists (the session bar, docs/session-bar.md D10). The stop sequence ends
#   …[;ctx…];tp=P;tl=L;cl=C
#   tp  base64 of `transcript_path` (absolute, at most 512 bytes, no control
#       character; else left out).
#   tl  base64 of a JSON array of the tasks counted in `tasks`:
#       {"id","type","d"} (Claude Code's id and type label, the description).
#   cl  base64 of a JSON array of `session_crons`:
#       {"id","s":schedule,"r":recurring,"p":prompt}.
#   Control characters in any text become spaces. A list is sent (possibly
#   `[]`) whenever Claude Code sent its field, so an absent tl or cl means
#   "no data", never "none". An old Claude Code that sends neither task field
#   gets no stop sequence at all, as before.
# Size cap. Claude Code drops a hook's terminalSequence whole when it is longer
# than 4096 bytes (2.1.321, w8o: `Buffer.byteLength(e,"utf8")>_8o`, `_8o=4096`,
# checked on the entire ESC ] … BEL string, then "rejected by the allowlist"),
# which would lose the verdict, so the whole sequence is kept under SEQ_MAX
# (3500). The counts and the context reading are never cut; the lists are: the
# text of every entry is shortened (80 down to 0 characters) so every id stays,
# since Patton reads a task missing from `tl` as ended (tasks=N against the
# length of tl tells it a list was cut), and only then are entries dropped from
# the end of the longer list. tp is left out when over 512 bytes.
#
# Context reading (the tab strip's checkpoint clock and its red "checkpoint
# finished" circle). From the transcript at `transcript_path` (JSONL, often
# tens of MB, so only tail and perl touch the whole file and jq sees a few
# dozen lines) the stop sequence gains
#   …;tasks=N;crons=M;ctx=C;since=S[;cpt=T][;cpd=T][;own=O]
#   C  tokens of the session's latest request: input + cache read + cache
#      write from the `message.usage` of the last line that has one (the
#      method of ~/.claude/hooks/context-meter.py; an all-zero usage, which a
#      synthetic message carries, is skipped).
#   S  C minus the context at the end of the current /checkpoint's turn (its
#      start line up to the next human prompt or task notification, a `user`
#      line; peer messages don't end a turn); its last usage is the baseline.
#      No checkpoint, a `compact_boundary` after it, or C below the baseline:
#      baseline 0.
#   T  the current checkpoint's start timestamp in Unix seconds (absent
#      without one).
#   cpd  the same T, sent only when no OWN TASK of the checkpoint is in
#      flight (crons don't gate it, or a /loop session would never get it),
#      or when Claude Code gave no task fields (tasks unknown): the checkpoint
#      has finished. Patton raises the red circle on `cpd`, not `cpt`, because
#      the first Stop after a start is not always its finish.
#   O  how many of the running tasks are the checkpoint's own (below), and
#   U  how many have no launch line found (undated, below); both hold `cpd`.
#      Sent as `own=O;und=U` with `cpt` whenever tasks ran and every id was in
#      hand, so main.log shows a `cpd` sent over older work (`tasks` minus
#      O+U of them) and tells a finish held by the checkpoint's own work from
#      one held only because the hook couldn't date a task (a dating gap to
#      fix, such as a subagent's shell id never seen live).
#   own task  a counted task (see `tasks`) launched in the checkpoint's window,
#      which is two turns at most:
#      - its own turn: from the start line to the first human prompt after it
#        (task-notification turns before that prompt still count);
#      - when RESCUED (its first landed commit step came after that prompt:
#        an interrupted start finished on his "go on", or a question he
#        answered mid-way), also the commit step's turn: from the last human
#        prompt before that commit step to the first human prompt after it.
#      Tasks launched in any other turn in between (his unrelated prompts
#      before the rescue, a dev server started then) are not its own, nor are
#      those after a later commit step (another round of notes, prompts later).
#      Claude Code's Stop input gives each task only an id, type, status and
#      description (2.1.321, Mzn: no start time), so it is dated by the line
#      that launched it: the first non-sidechain line with a `toolUseResult`
#      carrying the id under a launch key,
#      `"backgroundTaskId":"<id>"` (a background Bash: run_in_background, or
#      moved to the background after its timeout), `"agentId":"<id>"` (an
#      async Agent) or `"taskId":"<id>"` (a Monitor). A mere mention (output
#      text, TaskOutput's `task_id`, an exit code) dates nothing. An agent
#      resumed by SendMessage (`resumedAgentId` / `revivedAgentId`) is dated
#      by its latest resume (the resume's main line is the launch line). The ids
#      are the ones Claude Code's registry gives the hook: read in 2.1.321's
#      source, Mzn lists `taskRegistry.all()` as `id: r.id` with no owner
#      filter, a shell's `backgroundTaskId` is kept only when it has the
#      registry's local_bash id form (bU: "b" and 8 base-36 characters) and
#      its output file is `<id>.output`, and shells a subagent launched sit
#      in the same registry (tasks carry `agentId`; I0r filters on it). No
#      live hook input with a subagent's shell has been captured, so an id
#      that matches nothing still holds. A task a subagent launched has no
#      launch line in the main transcript, only in `<transcript minus
#      .jsonl>/subagents/agent-<agentId>.jsonl` (regular files only, read in
#      name order), so it is dated by its launch line there (the earliest by
#      timestamp if several files have one; a line with no timestamp sorts
#      after every dated one), or, for an agent an agent re-engaged by
#      SendMessage, by its latest resume line there, as in the main
#      transcript: that line's timestamp against the window's bounds'
#      timestamps, so a shell an agent launched in its first run is not moved
#      into the window when the checkpoint resumes the agent. A shell such an
#      agent launches after the human prompt that ends the window is not its
#      own either, though the agent itself still is. Inside the window it
#      counts only when the agent whose file holds that line worked for the
#      checkpoint too: one of the agent's own starts (launch or resume) lies in
#      the window and came from the checkpoint, in the main transcript by line
#      or, for a nested agent, by its line's timestamp in an agent file that
#      passes the same test (5 levels at most); an agent from before the
#      checkpoint, still running, launches nothing of its own. When a line or
#      a bound has no timestamp, or the bounds run out of order, only that
#      chain decides. An UNDATED task (no launch line found, no chain to the
#      main transcript, or an empty id) holds `cpd` as before;
#      so does any failure, ids that don't add up to `tasks`, or a reading
#      past 3 s (the hook's own limit is 10 s). The cost is one regex per
#      tool-result line and a hash lookup, whatever the number of tasks
#      (174 MB in about a quarter of a second). Why: until 24 Nov 2026 any
#      task held it, so a monitor or build started before the /checkpoint
#      held its red circle until it ended (main.log 20 Nov 20:51, released
#      21 Nov 06:16).
# A checkpoint START is the user line carrying
# `<command-name>/checkpoint</command-name>` (a human prompt) or an assistant
# `tool_use` of the Skill tool with skill "checkpoint" (the model invoked it).
# A start is CUT OFF when an INTERRUPT lands inside its own turn (after the
# start and before the next human prompt, a `user` line with origin human;
# task-notification turns before that prompt still count as its turn) and no
# COMMIT STEP comes anywhere between the start and the next start (or the end
# of the file): an interrupt after the commit step doesn't count, the commit
# landed, and an interrupt resumed into a commit is rescued. An unrelated
# interrupt hours later, in a project that checkpoints without
# checkpoint-commit.py, doesn't cancel a finished checkpoint. The current
# checkpoint is the last start that isn't cut off; none left: no checkpoint.
#   interrupt    a `user` line, not a tool result, whose text (string content
#                or its text blocks) begins "[Request interrupted by user"
#                (Claude Code writes it when Esc stops a turn).
#   commit step  an assistant Bash tool_use whose command runs the checkpoint
#                skill's commit script: `[dir/]checkpoint-commit.py` in a
#                command's place (the start of the command or of a line, or
#                after `;`, `&` or `|`; past any VAR=value prefixes), run
#                directly or as `[dir/]python3 [-flags] [dir/]checkpoint-commit.py`,
#                with `--message` somewhere after it (the script requires it,
#                so a `--help` or `-h` call is no commit step: it would
#                otherwise fix a rescue's window at a turn that committed
#                nothing; all 385 real run lines carried it, 24 Nov 2026).
#                So `python3 ~/.claude/scripts/checkpoint-commit.py …` and
#                `cd x; PATTON_NO_INSTALL=1 python3 /abs/checkpoint-commit.py`
#                count, while a mention (quoted, in a comment, a path given to
#                cat or wc) doesn't: every one of 253 real runs in his
#                transcripts matched and none of 5 mentions did (18 Nov 2026),
#                where "after any whitespace" took a heredoc comment as a run.
#                It counts only once its own tool_result (same tool_use_id)
#                has come back without `"is_error": true`: a refused or failed
#                commit, or one still running, rescues nothing (the review of
#                18 Nov 2026 found 2 refused commit steps among the 253 runs).
# All three are non-sidechain, non-meta lines. Why (Michael, 18 Nov 2026: "the
# red dot for checkpointing isn't working very well. Sometimes it's going
# green rather than red, and other times it's going red when it hasn't
# checkpointed"): a checkpoint's turn could end parked on its own background
# work (red too early; selecting the tab then acked the start, so the real
# finish showed green), or he interrupted it and talked about something else
# (red for nothing; when it was resumed and finished, green). A landed commit
# alone can't be the finish signal: several projects checkpoint without
# checkpoint-commit.py (no git, a worktree's own commits, a no-op checkpoint).
# A checkpoint still running a task it launched itself stays unfinished (no
# `cpd`) until that task ends (see "own task").
# A Stop input with neither task field gets no stop sequence (see Fail-open);
# then the reading travels alone as
#   {"terminalSequence":"\u001b]777;patton;ctx;ctx=C;since=S[;cpt=T][;cpd=T][;own=O]\u0007"}
# so it never touches the dot or the parked ring. No readable transcript, or
# no usage in it: the ctx fields are left out and the output is as before.
#
# Fail-open: any problem, or a Stop input with neither field (older Claude
# Code, or its task registry unreachable), prints no stop sequence and exits
# 0, which leaves Patton on its title-glyph fallback.
#
# Parser: jq (/usr/bin/jq ships with macOS 15+), else JavaScript for
# Automation through osascript (every macOS). The osascript fallback sends
# the counts and the lists, never the context reading. Running Patton's own Electron
# binary as Node is not an option: the packaged app's RunAsNode fuse is off,
# so ELECTRON_RUN_AS_NODE would launch the app instead.

input=$(cat 2>/dev/null) || exit 0
FINISHED='["completed","failed","killed","cancelled","canceled","done","finished","stopped"]'
# Claude Code 2.1.321 puts a friendly label in background_tasks[].type (its
# cLe maps auto_mode_scan to "auto-mode scan", local_memory_import to
# "memory import", dream to "dream"), so both forms are listed: the raw names
# are for builds that send them.
AMBIENT='["dream","auto_mode_scan","auto-mode scan","local_memory_import","memory import"]'

counts=""
tlb=""; clb=""; tpb=""   # base64 of the task list, the cron list, the transcript path ("" = none)
# The size cap on the whole sequence (see "Size cap" in the header) and what a
# list may use of it. LIST_MIN: below it a list can't hold even "[]" and its
# field name, so the lists are left out.
SEQ_MAX=3500
LIST_MIN=16
JQ=$(command -v jq 2>/dev/null || { [ -x /usr/bin/jq ] && echo /usr/bin/jq; })
[ "${PATTON_HOOK_PARSER:-}" = osascript ] && JQ=""  # lets the probe test the fallback
# The tasks that count, shared by the count and the list: not finished, not ambient.
JQ_RUNNING='
  def arr(f): (f | if type == "array" then . else [] end);
  def running: [arr(.background_tasks)[]
    | select((((.status // "running") | tostring | ascii_downcase) as $s | $fin | index($s)) == null)
    | select(((.type // "") | tostring) as $t | $amb | index($t) | not)];'
if [ -n "$JQ" ]; then
  counts=$(printf '%s' "$input" | "$JQ" -r --argjson fin "$FINISHED" --argjson amb "$AMBIENT" "$JQ_RUNNING"'
    if (has("background_tasks") or has("session_crons")) | not then empty else
      (running | length | tostring) + " " + (arr(.session_crons) | length | tostring)
    end' 2>/dev/null)
elif [ -x /usr/bin/osascript ]; then
  # Line 1: the counts; then the task list, the cron list and the transcript
  # path, each base64 or empty (see lists_fit below for the same cut in jq).
  # The context reading is never taken on this path, so the budget is the
  # sequence cap less a generous allowance for the fixed part (tp is counted
  # inside).
  out=$(printf '%s' "$input" | /usr/bin/osascript -l JavaScript -e '
    ObjC.import("Foundation");
    const raw = $.NSString.alloc.initWithDataEncoding(
      $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
    const j = JSON.parse(raw), fin = '"$FINISHED"', amb = '"$AMBIENT"';
    const SEQ_MAX = '"$SEQ_MAX"', LIST_MIN = '"$LIST_MIN"', FIXED = 70;
    const arr = (v) => Array.isArray(v) ? v : [];
    const str = (v) => (v === undefined || v === null || v === false) ? "" : String(v);
    const clean = (v) => Array.from(str(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
    const cut = (v, n) => clean(v).slice(0, n).join("");
    const b64 = (s) => $.NSString.stringWithString(s).dataUsingEncoding($.NSUTF8StringEncoding)
      .base64EncodedStringWithOptions(0).js;
    if (!("background_tasks" in j) && !("session_crons" in j)) { "" } else {
      const running = arr(j.background_tasks).filter((x) =>
        !fin.includes(String((x && x.status) || "running").toLowerCase()) &&
        !amb.includes(String((x && x.type) || "")));
      const byteLen = (s) => $.NSString.stringWithString(s).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding);
      let tp = "";
      const path = typeof j.transcript_path === "string" ? j.transcript_path : "";
      if (path.startsWith("/") && byteLen(path) <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(path)) tp = b64(path);
      const mk = (n) => ({
        tl: "background_tasks" in j ? running.map((x) => ({ id: cut(x && x.id, 128), type: cut(x && x.type, 32), d: cut(x && x.description, n) })) : null,
        cl: "session_crons" in j ? arr(j.session_crons).map((x) => ({ id: cut(x && x.id, 128), s: cut(x && x.schedule, 100), r: !!(x && x.recurring === true), p: cut(x && x.prompt, n) })) : null,
      });
      const enc = (l) => l === null ? 0 : b64(JSON.stringify(l)).length + 4;
      const size = (o) => enc(o.tl) + enc(o.cl);
      const budget = SEQ_MAX - FIXED - (tp ? tp.length + 4 : 0);
      let o = null;
      if (budget >= LIST_MIN) {
        for (const n of [80, 60, 40, 30, 20, 10, 0]) { const c = mk(n); if (size(c) <= budget) { o = c; break; } }
        if (o === null) {
          o = mk(0);
          while (size(o) > budget && ((o.tl || []).length + (o.cl || []).length) > 0) {
            if (enc(o.tl) >= enc(o.cl) && (o.tl || []).length > 0) o.tl.pop(); else o.cl.pop();
          }
        }
      }
      [running.length + " " + arr(j.session_crons).length,
       o && o.tl !== null ? b64(JSON.stringify(o.tl)) : "",
       o && o.cl !== null ? b64(JSON.stringify(o.cl)) : "", tp].join("\n");
    }' 2>/dev/null)
  { IFS= read -r counts; IFS= read -r tlb; IFS= read -r clb; IFS= read -r tpb; } <<<"$out"
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

context_fields() { # transcript path, tasks in flight ("" = unknown), their ids -> ";ctx=C;since=S[;cpt=T][;cpd=T][;own=O]" or nothing
  local t="$1" tasks="$2" ids="$3" ctx cp line ts rline own range base since
  [ -n "$PERL" ] || return 0
  # The last usage sits near the end; a tail that holds none (one huge tool
  # result) falls back to the whole file.
  ctx=$(tail -c 2097152 "$t" | usage_of)
  [ -n "$ctx" ] || ctx=$(usage_of < "$t")
  [[ "$ctx" =~ ^[0-9]+$ ]] || return 0

  # The current /checkpoint (see the header): "<line> <unix seconds or
  # empty>". perl collects candidates in groups, one per start candidate (the
  # last 20 groups), each with its first few interrupt and commit-step
  # candidates and the tool results carrying a candidate's tool_use id (every
  # id string in the candidate line, so a superset of the ids jq accepts);
  # jq checks each form properly and walks them in order. Start:
  # for the prompt, origin human (an older line with no origin counts when its
  # content is a plain string) and the tag in its own text; for the tool call,
  # a non-sidechain assistant tool_use block. The tag also turns up quoted in
  # tool results and agent briefs (skipped here, so they can't fill the
  # window). The file is read through `<`, never as a perl argument (perl's
  # magic open would run a path ending in `|`).
  cp=$("$PERL" -ne '
      # A group: s start line, i interrupts, c commit candidates, e turn
      # ended, r results, ids the commit candidates tool_use ids, o lines.
      if (index($_, q("type":"tool_result")) >= 0) {
        # A commit candidate`s own result (jq checks the id and is_error);
        # every other tool result is skipped.
        if (@g && $g[-1]{r} < 8) {
          for my $id (keys %{$g[-1]{ids}}) {
            if (index($_, qq("tool_use_id":"$id")) >= 0) { $g[-1]{r}++; push @{$g[-1]{o}}, "$.:$_"; last }
          }
        }
        next;
      }
      if ((index($_, q(<command-name>/checkpoint</command-name>)) >= 0 && index($_, q("type":"user")) >= 0)
          || (index($_, q("skill":"checkpoint")) >= 0 && index($_, q("name":"Skill")) >= 0)) {
        push @g, {s => "$.:$_", i => 0, c => 0, e => 0, r => 0, ids => {}, o => []}; shift @g if @g > 20; next;
      }
      next unless @g;
      if (index($_, q("type":"user")) >= 0 && index($_, q("origin":{"kind":"human")) >= 0) {
        # The turn ended: one marker for jq; later interrupts belong to other turns.
        unless ($g[-1]{e}) { $g[-1]{e} = 1; push @{$g[-1]{o}}, "$.:\"HUMAN\"\n" }
      } elsif (!$g[-1]{e} && index($_, q([Request interrupted by user)) >= 0 && index($_, q("type":"user")) >= 0
          && (index($_, q("text":"[Request interrupted by user)) >= 0
              || index($_, q("content":"[Request interrupted by user)) >= 0)) {
        if ($g[-1]{i} < 4) { $g[-1]{i}++; push @{$g[-1]{o}}, "$.:$_" }
      } elsif (index($_, q(checkpoint-commit.py)) >= 0 && index($_, q("name":"Bash")) >= 0
          && /(?:"command":"|[;&|]|\\n)(?:\s|\\[nrt])*(?:[A-Za-z_]\w*=\S*(?:\s|\\[nrt])+)*(?:(?:\S*\/)?python[0-9.]*(?:\s|\\[nrt])+(?:-\S+(?:\s|\\[nrt])+)*)?(?:\S*\/)?checkpoint-commit\.py.*?--message/) {
        if ($g[-1]{c} < 4) {
          $g[-1]{c}++; push @{$g[-1]{o}}, "$.:$_";
          $g[-1]{ids}{$1} = 1 while /"id":"([^"\\]+)"/g;
        }
      }
      END { for $x (@g) { print $x->{s}, @{$x->{o}} } }' < "$t" | "$JQ" -R -n -r '
    def text_of: if type == "string" then [.] else [.[]? | select(.type? == "text") | .text | strings] end;
    def commit_ids($o):
      $o.message.content[]? | select(.type? == "tool_use" and .name? == "Bash"
        and ((.input.command? // "") | strings
             | test("(^|[;&|\\n])\\s*([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*((\\S*/)?python[0-9.]*\\s+(-\\S+\\s+)*)?(\\S*/)?checkpoint-commit\\.py[\\s\\S]*--message")))
      | .id | strings;
    def kind($o):
      if ($o.isMeta == true) or ($o.isSidechain == true) then null
      elif ($o.type == "user"
            and (($o.origin.kind? // null) == "human"
                 or ($o.origin == null and ($o.message.content | type) == "string"))
            and ($o.message.content | text_of | join("\n") | contains("<command-name>/checkpoint</command-name>")))
        or ($o.type == "assistant"
            and any($o.message.content[]?; .type? == "tool_use" and .name? == "Skill" and (.input.skill? // null) == "checkpoint"))
        then "start"
      elif $o.type == "user"
           and any($o.message.content | if type == "array" then .[] else empty end; .type? == "tool_result")
        then "result"
      elif $o.type == "user"
           and any($o.message.content | text_of | .[]; startswith("[Request interrupted by user"))
        then "interrupt"
      elif $o.type == "assistant" and ([commit_ids($o)] | length > 0)
        then "commit"
      else null end;
    reduce (inputs
            | (index(":")) as $i | .[:$i] as $n | (.[$i+1:] | fromjson?) as $o
            | (if $o == "HUMAN" then "human" else (try kind($o) catch null) end) as $k | select($k != null)
            | {n: $n, k: $k,
               ts: ((try ($o.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | floor | tostring) catch "") // ""),
               ids: (if $k == "commit" then [commit_ids($o)]
                     elif $k == "result" then [$o.message.content[] | select(.type? == "tool_result" and .is_error != true) | .tool_use_id | strings]
                     else [] end)})
      as $x ([];
        # The line of the commit step this result answers (none when it answers none).
        ([.[-1].pend[]? | . as $p | select(any($x.ids[]; . == $p.id)) | .n] | .[0]) as $cs
        | if $x.k == "start" then . + [{n: $x.n, ts: $x.ts, cut: false, commit: false, ended: false, pend: []}]
        elif length == 0 then .
        elif $x.k == "human" then .[-1].ended = true
        elif $x.k == "interrupt" then (if .[-1].commit or .[-1].ended then . else .[-1].cut = true end)
        elif $x.k == "commit" then .[-1].pend += [$x.ids[] | {id: ., n: $x.n}]
        # A commit step counts once its own result has come back without an error.
        # The FIRST such step (its line) is kept: when it landed after a human prompt
        # (a rescue), its turn is part of the own-task window; later commit steps
        # (another round of notes, prompts later) widen nothing.
        elif $cs != null then .[-1].commit = true | .[-1].cut = false | .[-1].cs //= $cs
        else . end)
    | map(select(.cut | not)) | last // empty | .n + " " + .ts + " " + (.cs // "")' 2>/dev/null)

  base=0; ts=""
  if [[ "$cp" =~ ^([0-9]+)\ ([0-9]*)\ ([0-9]*)$ ]]; then
    line=${BASH_REMATCH[1]}; ts=${BASH_REMATCH[2]}; rline=${BASH_REMATCH[3]}
    # One pass from the checkpoint line: its turn ends at the next human
    # prompt or task notification (a `user` line; an attachment that merely
    # carries an origin, or a peer message, does not end it); keep the usage lines inside it, unless a
    # compact_boundary follows the checkpoint anywhere (then baseline 0).
    range=$(L="$line" "$PERL" -ne '
        next if $. < $ENV{L};
        if (index($_, q("subtype":"compact_boundary")) >= 0) { $b = 1; last }
        if (!$end && $. > $ENV{L} && index($_, q("type":"user")) >= 0
            && (index($_, q("origin":{"kind":"human")) >= 0
                || index($_, q("origin":{"kind":"task-notification")) >= 0)) { $end = 1 }
        if (!$end && index($_, q("usage")) >= 0) { push @u, $_; shift @u if @u > 40 }
        END { print($b ? "COMPACT\n" : @u) }' < "$t")
    if [ "$range" != COMPACT ]; then
      base=$(printf '%s\n' "$range" | usage_of)
      [[ "$base" =~ ^[0-9]+$ ]] || base=0
    fi
  fi
  [ "$ctx" -ge "$base" ] || base=0
  since=$((ctx - base))
  printf ';ctx=%s;since=%s' "$ctx" "$since"
  if [ -n "$ts" ]; then
    printf ';cpt=%s' "$ts"
    # Finished: nothing of its own still running (or tasks unknown). Every
    # running task must have its id in hand, else it holds as before.
    if [ -z "$tasks" ] || [ "$tasks" = 0 ]; then
      printf ';cpd=%s' "$ts"
    elif [ "$(printf '%s\n' "$ids" | grep -c '^i:')" = "$tasks" ]; then
      held=$(own_tasks "$t" "$line" "$rline" "$ids")
      if [[ "$held" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
        [ "$held" = "0 0" ] && printf ';cpd=%s' "$ts"
        printf ';own=%s;und=%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
      fi
    fi
  fi
  return 0
}

# How many of the running tasks hold the checkpoint's finish (see "own task" and
# "undated" in the header): transcript, the checkpoint's start line, its first
# landed commit step's line (or empty), the ids ("i:<id>" a line) -> "O U"
# (own, undated), or nothing on any failure or after 3 s (either holds it). One
# pass of the main transcript (through `<`) finds the window's bounds (with
# their timestamps) and each id's launch line: one key-anchored regex per
# tool-result line and a hash lookup, so the number of tasks costs nothing.
# Only for ids it lacks, one pass of the session's subagent transcripts finds
# each launch key's earliest line and each resume; such an id is dated by its
# latest resume or else that launch line, by timestamp against the window's,
# and counts only when the agent up its chain worked for the checkpoint (one
# of its starts in the window, nested agents up to 5 levels).
own_tasks() {
  L="$2" C="$3" IDS="$4" SUB="${1%.jsonl}/subagents" "$PERL" -ne '
    BEGIN {
      $SIG{ALRM} = sub { kill 9, $$ }; alarm 3;   # killed: prints nothing, which holds cpd
      @id = map { substr($_, 2) } grep { /^i:/ } split /\n/, $ENV{IDS};
      %want = map { $_ => 1 } grep { $_ ne "" } @id;
      $L = $ENV{L}; $C = ($ENV{C} || 0) > $L ? $ENV{C} : 0;
    }
    # The window: the start line up to the first human prompt after it ($end);
    # when the first commit step landed after that, also its turn, from the
    # last human prompt before it ($rs) to the first one after it ($re).
    $tsL = $1 if $. == $L && /"timestamp":"([^"]+)"/;
    if ($. > $L && index($_, q("type":"user")) >= 0 && index($_, q("origin":{"kind":"human")) >= 0) {
      my ($w) = /"timestamp":"([^"]+)"/;
      if (!$end) { $end = $.; $tsEnd = $w }
      if ($C && $. < $C) { $rs = $.; $tsRs = $w }
      if ($C && $. > $C && !$re) { $re = $.; $tsRe = $w }
    }
    next if index($_, q("toolUseResult")) < 0 || index($_, q("isSidechain":true)) >= 0;
    # %starts: each agent`s main launch line and every resume line, for the
    # agents up a subagent shell`s chain.
    while (/"(backgroundTaskId|taskId|agentId|resumedAgentId|revivedAgentId)":"([^"\\]+)"/g) {
      my ($k, $v) = ($1, $2);
      if ($k eq "resumedAgentId" || $k eq "revivedAgentId") {
        push @{$starts{$v}}, $. unless @{$starts{$v} || []} && $starts{$v}[-1] == $.;
        $at{$v} = $. if $want{$v};
      } else {
        push @{$starts{$v}}, $. if $k eq "agentId" && !$starts{$v};
        $at{$v} //= $. if $want{$v};
      }
    }
    END {
      # $rs, when set, is a human prompt after the start, so $end is set and $rs >= $end.
      my $inside = sub {   # a main-transcript line number
        my $w = shift;
        return ($w >= $L && (!$end || $w < $end)) || ($rs && $w >= $rs && (!$re || $w < $re));
      };
      # Timestamps date the launch line in a subagent file only when every bound has one
      # and they run in order (fixtures and clock changes can break either). They
      # compare as strings: Claude Code writes every one as fixed-width ISO UTC with
      # milliseconds (`2026-11-24T09:48:00.123Z`; all 6,413 real files, 24 Nov 2026).
      my $tsok = defined $tsL && (!$end || (defined $tsEnd && $tsL le $tsEnd))
        && (!$rs || (defined $tsRs && $tsEnd le $tsRs && (!$re || (defined $tsRe && $tsRs le $tsRe))));
      my $insideTs = sub {
        my $t = shift;
        return ($t ge $tsL && (!$end || $t lt $tsEnd)) || ($rs && $t ge $tsRs && (!$re || $t lt $tsRe));
      };
      my (%own, @cur);
      for my $x (keys %want) { if (defined $at{$x}) { $own{$x} = $inside->($at{$x}) ? 1 : 0 } else { push @cur, $x } }
      if (@cur && opendir(my $d, $ENV{SUB})) {
        my @files = sort grep { /^agent-[A-Za-z0-9_-]+\.jsonl$/ && -f "$ENV{SUB}/$_" } readdir $d;
        closedir $d;
        # id -> [timestamp or undef, agent]: %launch the earliest launch-key line
        # naming it, %resume its latest resume (SendMessage from inside an agent),
        # @{$resumes{id}} every resume.
        my (%launch, %resume, %resumes);
        for my $f (@files) {
          my ($a) = $f =~ /^agent-(.+)\.jsonl$/;
          open(my $h, "<", "$ENV{SUB}/$f") or next;
          while (my $s = <$h>) {
            next if index($s, q("toolUseResult")) < 0;
            my ($when) = $s =~ /"timestamp":"([^"]+)"/;   # undef when the line has none
            while ($s =~ /"(backgroundTaskId|taskId|agentId|resumedAgentId|revivedAgentId)":"([^"\\]+)"/g) {
              my ($k, $v) = ($1, $2);
              next if $v eq $a;
              # A line with no timestamp sorts after every dated one, so it is
              # kept only while no dated line names the id (the first read stays).
              # Launch: the earliest dated line wins. Resume: the latest does.
              my $resumed = $k eq "resumedAgentId" || $k eq "revivedAgentId";
              my $map = $resumed ? \%resume : \%launch;
              my $old = $map->{$v};
              $map->{$v} = [$when, $a]
                if !$old || (defined $when && (!defined $old->[0]
                  || ($resumed ? $when gt $old->[0] : $when lt $old->[0])));
              push @{$resumes{$v}}, [$when, $a] if $resumed;
            }
          }
          close $h;
        }
        # Did agent $p work for the checkpoint? Yes when one of its starts (its
        # launch or a resume) lies in the window and came from the checkpoint: a
        # main-transcript line in the window, or a line in an agent file, in the
        # window by time, written by an agent that did (5 levels at most). 1, 0,
        # or undef when no start of it is found (undated).
        my $chain;
        $chain = sub {
          my ($p, $depth) = @_;
          if ($starts{$p}) { for (@{$starts{$p}}) { return 1 if $inside->($_) } return 0 }
          my @q = grep { defined } $launch{$p}, @{$resumes{$p} || []};
          return undef if $depth >= 5 || !@q;
          my $r = 0;
          for my $q (@q) {
            next if $tsok && defined $q->[0] && !$insideTs->($q->[0]);
            my $o = $chain->($q->[1], $depth + 1);
            return 1 if $o;
            $r = undef unless defined $o;
          }
          return $r;
        };
        for my $x (@cur) {
          # Dated by its latest resume, else its launch (as in the main
          # transcript), by time: a shell an agent launched in its first run
          # stays outside the window when the agent is resumed later. Then the
          # agent that launched or resumed it must have worked for the checkpoint
          # too: an older agent still running launches nothing of its own.
          my $q = $resume{$x} || $launch{$x} or next;
          if ($tsok && defined $q->[0] && !$insideTs->($q->[0])) { $own{$x} = 0; next }
          my $o = $chain->($q->[1], 0);
          $own{$x} = $o if defined $o;
        }
      }
      my ($n, $u) = (0, 0);
      for my $x (@id) {
        my $o = $x eq "" ? undef : $own{$x};
        if (!defined $o) { $u++ } elsif ($o) { $n++ }
      }
      print "$n $u";
    }' < "$1" 2>/dev/null
}

ctxf=""
tasks=""
[[ "$counts" =~ ^([0-9]+)\ ([0-9]+)$ ]] && tasks=${BASH_REMATCH[1]}
if [ -n "$JQ" ]; then
  tpath=$(printf '%s' "$input" | "$JQ" -r '.transcript_path | strings' 2>/dev/null)
  if [ -n "$tpath" ] && [ -f "$tpath" ] && [ -r "$tpath" ]; then
    # The running tasks' ids, one "i:<id>" line each (the prefix keeps an
    # empty id a line), for telling the checkpoint's own work from older work.
    ids=""
    if [ -n "$tasks" ] && [ "$tasks" != 0 ]; then
      ids=$(printf '%s' "$input" | "$JQ" -r --argjson fin "$FINISHED" --argjson amb "$AMBIENT" "$JQ_RUNNING"'
        running[] | "i:" + ((.id // "") | tostring | gsub("[\\p{Cc}]"; ""))' 2>/dev/null)
    fi
    ctxf=$(context_fields "$tpath" "$tasks" "$ids" 2>/dev/null)
  fi
fi

# --- The lists (jq path; the osascript path made its own above) ---
# tp: the transcript path, base64, when it is an absolute path of at most 512
# bytes with no control character. tl, cl: the running tasks and the crons,
# base64 of a JSON array, fitted to what the sequence has room for (SEQ_MAX
# less everything else in it). Fitting: the text of every entry is cut
# 80 -> 60 -> 40 -> 30 -> 20 -> 10 -> 0 characters until the lists fit, keeping every id (Patton
# reads a task missing from the list as ended); only when even that is too
# long are entries dropped from the end of the longer list.
if [ -n "$JQ" ] && [[ "$counts" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
  tpath=${tpath:-}
  if [ -n "$tpath" ] && [ "${#tpath}" -le 512 ] && [[ "$tpath" == /* ]] && [[ "$tpath" != *[[:cntrl:]]* ]]; then
    tpb=$(printf '%s' "$tpath" | /usr/bin/base64 2>/dev/null | tr -d '\n')
  fi
  base=$(printf '\033]777;patton;stop;tasks=%s;crons=%s%s\007' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$ctxf")
  budget=$((SEQ_MAX - ${#base} - ${#tpb} - 4))
  if [ "$budget" -ge "$LIST_MIN" ]; then
    lists=$(printf '%s' "$input" | "$JQ" -r --argjson b "$budget" --argjson fin "$FINISHED" --argjson amb "$AMBIENT" "$JQ_RUNNING"'
      def clean: if . == null or . == false then "" else tostring | gsub("[\\p{Cc}]"; " ") end;
      def mk($n): {
        tl: (if has("background_tasks") then [running[]
              | {id: (.id | clean | .[:128]), type: (.type | clean | .[:32]), d: (.description | clean | .[:$n])}] else null end),
        cl: (if has("session_crons") then [arr(.session_crons)[]
              | {id: (.id | clean | .[:128]), s: (.schedule | clean | .[:100]), r: (.recurring == true), p: (.prompt | clean | .[:$n])}] else null end)};
      def enc: if . == null then 0 else (tojson | @base64 | length) + 4 end;
      def size: (.tl | enc) + (.cl | enc);
      def count: ((.tl // []) | length) + ((.cl // []) | length);
      def dropfit: if size <= $b or count == 0 then . elif (.tl | enc) >= (.cl | enc) and ((.tl // []) | length) > 0
                   then .tl |= .[:-1] | dropfit else .cl |= .[:-1] | dropfit end;
      . as $in | (first((80, 60, 40, 30, 20, 10, 0) as $n | $in | mk($n) | select(size <= $b)) // ($in | mk(0) | dropfit))
      | (.tl | if . == null then "" else tojson | @base64 end), (.cl | if . == null then "" else tojson | @base64 end)' 2>/dev/null)
    { IFS= read -r tlb; IFS= read -r clb; } <<<"$lists"
  fi
fi

# What the stop sequence gets on top of the counts and the context reading.
# Anything unreadable above left its field empty, which leaves it out. A
# sequence still over the cap (it shouldn't be) loses the lists and tp whole:
# never the counts or the context reading.
extras=""
[ -n "$tpb" ] && extras="$extras;tp=$tpb"
[ -n "$tlb" ] && extras="$extras;tl=$tlb"
[ -n "$clb" ] && extras="$extras;cl=$clb"
if [[ "$counts" =~ ^([0-9]+)\ ([0-9]+)$ ]]; then
  [ $((${#extras} + ${#ctxf} + 50)) -le "$SEQ_MAX" ] || extras=""
  printf '{"terminalSequence":"\\u001b]777;patton;stop;tasks=%s;crons=%s%s%s\\u0007"}\n' \
    "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$ctxf" "$extras"
elif [ -n "$ctxf" ]; then
  printf '{"terminalSequence":"\\u001b]777;patton;ctx%s\\u0007"}\n' "$ctxf"
fi
exit 0
