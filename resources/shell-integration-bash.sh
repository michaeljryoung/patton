# Patton shell integration for bash
# Provides OSC 133 markers for prompt detection
__patton_prompt_command() {
  local ret=$?
  printf '\e]133;D;%d\a' "$ret"
  printf '\e]133;A\a'
}
PROMPT_COMMAND="__patton_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS0=$'\e]133;C\a'
# Emit initial prompt marker
printf '\e]133;A\a'
