# Patton Terminal — shell integration loader for zsh
# Injected via ZDOTDIR override; restores user's ZDOTDIR before continuing.

# Restore original ZDOTDIR so all other startup files (.zprofile, .zshrc, etc.)
# load from the user's real home/config directory.
if [ -n "$PATTON_ORIG_ZDOTDIR" ]; then
  ZDOTDIR="$PATTON_ORIG_ZDOTDIR"
else
  ZDOTDIR="$HOME"
fi
unset PATTON_ORIG_ZDOTDIR

# Capture the integration-script path into a read-only local BEFORE we source
# the user's .zshenv. If the user's .zshenv is compromised it cannot redirect
# PATTON_SHELL_INTEGRATION_SCRIPT to point at a malicious file — by the time
# that write would happen, the value we'll actually source is already frozen.
_patton_integration="$PATTON_SHELL_INTEGRATION_SCRIPT"
typeset -r _patton_integration 2>/dev/null || readonly _patton_integration 2>/dev/null || true

# Source user's .zshenv (from their real ZDOTDIR)
if [ -f "$ZDOTDIR/.zshenv" ]; then
  . "$ZDOTDIR/.zshenv"
fi

# Source Patton shell integration (OSC 133 markers) from the frozen path
if [ -n "$_patton_integration" ] && [ -f "$_patton_integration" ]; then
  . "$_patton_integration"
fi
unset PATTON_SHELL_INTEGRATION_SCRIPT
