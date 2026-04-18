#!/usr/bin/env bash
# Patton health check — inspects the installed app for signs of the
# anomalies that the session-20 hardening was designed to catch.
#
# Run this after a day or two of real use. It greps the macOS unified log
# for our structured error strings, counts Crashpad dumps, and verifies
# the safeStorage migration produced its key file.
#
# Usage:
#   bash scripts/patton-health.sh                # last 24h
#   bash scripts/patton-health.sh --hours=48     # custom window
#   bash scripts/patton-health.sh --verbose      # show matching log lines

set -u

HOURS=24
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --hours=*) HOURS="${arg#--hours=}" ;;
    --verbose|-v) VERBOSE=1 ;;
    --help|-h)
      echo "Usage: $0 [--hours=N] [--verbose]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

APP_PATH="/Applications/Patton.app"
SUPPORT_DIR="$HOME/Library/Application Support/Patton"
CRASHPAD_DIR="$SUPPORT_DIR/Crashpad/completed"
CONFIG_PATH="$SUPPORT_DIR/config.json"
KEY_PATH="$SUPPORT_DIR/key.enc"
LOG_DIR="$SUPPORT_DIR/logs"
LOG_FILE="$LOG_DIR/main.log"

# ANSI (only when stdout is a tty)
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; RESET=$'\033[0m'
else
  B=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

ok()    { echo "  ${GREEN}✓${RESET} $1"; }
warn()  { echo "  ${YELLOW}⚠${RESET}  $1"; }
bad()   { echo "  ${RED}✗${RESET} $1"; }
info()  { echo "  ${DIM}·${RESET} $1"; }

echo "${B}Patton health check${RESET} — $(date '+%Y-%m-%d %H:%M'), last ${HOURS}h"
echo ""

# --- Install ---
echo "${B}Install${RESET}"
if [ -d "$APP_PATH" ]; then
  ver=$(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "?")
  built=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$APP_PATH" 2>/dev/null)
  ok "App installed (v$ver, built $built)"
else
  bad "App not installed at $APP_PATH"
fi
echo ""

# --- Crashpad dumps ---
echo "${B}Crash dumps${RESET}"
if [ -d "$CRASHPAD_DIR" ]; then
  recent_dmps=$(find "$CRASHPAD_DIR" -name '*.dmp' -mtime "-$((HOURS/24+1))" 2>/dev/null | wc -l | tr -d ' ')
  total_dmps=$(find "$CRASHPAD_DIR" -name '*.dmp' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$recent_dmps" -eq 0 ]; then
    ok "0 crash dumps in last ${HOURS}h (${total_dmps} total)"
  else
    warn "$recent_dmps crash dumps in last ${HOURS}h (${total_dmps} total) — inspect with lldb or minidump_stackwalk"
    if [ "$VERBOSE" -eq 1 ]; then
      find "$CRASHPAD_DIR" -name '*.dmp' -mtime "-$((HOURS/24+1))" -exec stat -f '    %Sm  %N' -t '%Y-%m-%d %H:%M' {} \; 2>/dev/null
    fi
  fi
else
  info "Crashpad dir not created yet — either app hasn't run with new build, or crashReporter failed to init"
fi
echo ""

# --- Log signals ---
echo "${B}Log signals${RESET} ${DIM}($LOG_FILE)${RESET}"
if [ ! -f "$LOG_FILE" ]; then
  info "No log file yet — app hasn't been launched with the file-logger build"
else
  # Filter to entries within the window by ISO timestamp prefix. Logger
  # writes `YYYY-MM-DDTHH:MM:SS.sssZ [LEVEL] message` lines, UTC.
  cutoff=$(date -u -v-"${HOURS}"H '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u -d "-${HOURS} hours" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null)
  # Combine main.log + any rotations so we don't lose signal across rotations
  LOG_OUTPUT=$(cat "$LOG_FILE" "$LOG_FILE.1" "$LOG_FILE.2" 2>/dev/null | awk -v cutoff="$cutoff" '$1 >= cutoff')

  if [ -z "$LOG_OUTPUT" ]; then
    info "No log entries in last ${HOURS}h"
  else
    check_pattern() {
      local label="$1" pattern="$2"
      local count
      count=$(echo "$LOG_OUTPUT" | grep -cE -- "$pattern" || true)
      if [ "$count" -eq 0 ]; then
        ok "$label: 0"
      else
        warn "$label: $count"
        if [ "$VERBOSE" -eq 1 ]; then
          echo "$LOG_OUTPUT" | grep -E -- "$pattern" | tail -5 | sed 's/^/      /'
        fi
      fi
    }
    check_pattern "Renderer crashes"          "Renderer process gone"
    check_pattern "Renderer unresponsive"     "Renderer unresponsive"
    check_pattern "Child/GPU process gone"    "Child process gone"
    check_pattern "WebGL context loss"        "WebGL context lost"
    check_pattern "Fatal main-process errors" "\[FATAL\]"
    check_pattern "PTY cleanup failures"      "PTY cleanup"
    check_pattern "Session save failures"     "Failed to save session"
    check_pattern "Store corruption resets"   "Store corrupted, resetting"

    # Migration is a one-shot — report whether it happened but don't flag it
    mig_count=$(echo "$LOG_OUTPUT" | grep -c "Migrated store from legacy" || true)
    if [ "$mig_count" -gt 0 ]; then
      info "Store migration: $mig_count (expected once after first launch on the new build)"
    fi

    # Crash circuit breaker firing is serious
    halt_count=$(echo "$LOG_OUTPUT" | grep -c "halting auto-reload" || true)
    if [ "$halt_count" -gt 0 ]; then
      bad "Crash circuit breaker tripped $halt_count times — 3+ renderer crashes in 30s"
    fi
  fi

  # Also report total log size as a rough activity indicator
  log_size=$(stat -f '%z' "$LOG_FILE" 2>/dev/null || echo "?")
  info "Log file: ${log_size}B"
fi
echo ""

# --- Store + key files ---
echo "${B}Store${RESET}"
if [ -f "$CONFIG_PATH" ]; then
  size=$(stat -f '%z' "$CONFIG_PATH" 2>/dev/null)
  mtime=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$CONFIG_PATH" 2>/dev/null)
  ok "config.json: ${size}B, updated $mtime"
else
  info "config.json not present — never launched, or wiped"
fi
if [ -f "$KEY_PATH" ]; then
  size=$(stat -f '%z' "$KEY_PATH" 2>/dev/null)
  ok "key.enc (Keychain-protected): ${size}B"
else
  info "key.enc not present — either running with legacy key fallback or not yet launched"
fi
echo ""

echo "${DIM}Tip: pass --verbose to see matching log lines and crash paths.${RESET}"
