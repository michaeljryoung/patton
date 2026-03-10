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

# Source user's .zshenv (from their real ZDOTDIR)
if [ -f "$ZDOTDIR/.zshenv" ]; then
  . "$ZDOTDIR/.zshenv"
fi

# Source Patton shell integration (OSC 133 markers)
if [ -n "$PATTON_SHELL_INTEGRATION_SCRIPT" ] && [ -f "$PATTON_SHELL_INTEGRATION_SCRIPT" ]; then
  . "$PATTON_SHELL_INTEGRATION_SCRIPT"
  unset PATTON_SHELL_INTEGRATION_SCRIPT
fi
