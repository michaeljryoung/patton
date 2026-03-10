# Patton Terminal — bash initialization wrapper
# Used via --rcfile to inject shell integration without PTY echo.
# Simulates login shell behavior since --rcfile requires non-login mode.

# Source system profile
[ -f /etc/profile ] && . /etc/profile

# Source user login files (first found, matching bash login precedence)
if [ -f "$HOME/.bash_profile" ]; then
  . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then
  . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then
  . "$HOME/.profile"
fi

# Source Patton shell integration (OSC 133 markers)
if [ -n "$PATTON_SHELL_INTEGRATION_SCRIPT" ] && [ -f "$PATTON_SHELL_INTEGRATION_SCRIPT" ]; then
  . "$PATTON_SHELL_INTEGRATION_SCRIPT"
  unset PATTON_SHELL_INTEGRATION_SCRIPT
fi
