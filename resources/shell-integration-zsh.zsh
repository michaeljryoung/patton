# Patton shell integration for zsh
# Provides OSC 133 markers for prompt detection
__patton_precmd() {
  local ret=$?
  printf '\e]133;D;%d\a' "$ret"
  printf '\e]133;A\a'
}
__patton_preexec() {
  printf '\e]133;C\a'
}
precmd_functions+=(__patton_precmd)
preexec_functions+=(__patton_preexec)
# Emit initial prompt marker
printf '\e]133;A\a'
