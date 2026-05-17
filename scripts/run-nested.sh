#!/usr/bin/env bash
set -euo pipefail

UUID="global-it@notyorch.github.io"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USE_XEPHYR=0
START_MOCK_PROVIDER="${START_MOCK_PROVIDER:-0}"
MOCK_MODE="${MOCK_MODE:-normal}"
MOCK_WINDOW_ID="${MOCK_WINDOW_ID:-1}"
SHELL_SUPPORTS_NESTED=0

if gnome-shell --help 2>/dev/null | grep -q -- '--nested'; then
  SHELL_SUPPORTS_NESTED=1
fi

if [[ "${1:-}" == "--xephyr" ]]; then
  USE_XEPHYR=1
fi

if ! command -v dbus-run-session >/dev/null 2>&1; then
  echo "dbus-run-session is required."
  exit 1
fi

if ! command -v gnome-shell >/dev/null 2>&1; then
  echo "gnome-shell is required."
  exit 1
fi

"$REPO_ROOT/scripts/install-dev.sh"

CURRENT_ENABLED_EXTENSIONS="$(gsettings get org.gnome.shell enabled-extensions)"
ORIGINAL_ENABLED_EXTENSIONS="$CURRENT_ENABLED_EXTENSIONS"
if [[ "$CURRENT_ENABLED_EXTENSIONS" != *"$UUID"* ]]; then
  if [[ "$CURRENT_ENABLED_EXTENSIONS" == "[]" ]]; then
    UPDATED_ENABLED_EXTENSIONS="['$UUID']"
  else
    UPDATED_ENABLED_EXTENSIONS="${CURRENT_ENABLED_EXTENSIONS%]}"
    UPDATED_ENABLED_EXTENSIONS="${UPDATED_ENABLED_EXTENSIONS}, '$UUID']"
  fi
  gsettings set org.gnome.shell enabled-extensions "$UPDATED_ENABLED_EXTENSIONS"
fi

dbus-run-session -- bash -lc "
set -euo pipefail
export XDG_CURRENT_DESKTOP=GNOME
export GNOME_SHELL_SESSION_MODE=gnome
export MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080

if [[ '$START_MOCK_PROVIDER' == '1' ]]; then
  gjs -m '$REPO_ROOT/scripts/mock-dbusmenu-provider.js' '$MOCK_MODE' '$MOCK_WINDOW_ID' &
  MOCK_PROVIDER_PID=\$!
  trap 'kill \$MOCK_PROVIDER_PID >/dev/null 2>&1 || true' EXIT
fi

if [[ '$USE_XEPHYR' -eq 1 ]]; then
  if ! command -v Xephyr >/dev/null 2>&1; then
    echo 'Xephyr not found. Install xorg-x11-server-Xephyr or run without --xephyr.'
    exit 1
  fi
  Xephyr :92 -screen 1920x1080 -nolisten tcp &
  XEPHYR_PID=\$!
  trap 'kill \$XEPHYR_PID >/dev/null 2>&1 || true' EXIT
  export DISPLAY=:92
  if [[ '$SHELL_SUPPORTS_NESTED' -eq 1 ]]; then
    gnome-shell --wayland --nested
  else
    gnome-shell --display-server
  fi
else
  if [[ '$SHELL_SUPPORTS_NESTED' -eq 1 ]]; then
    gnome-shell --wayland --nested
  else
    gnome-shell --headless --virtual-monitor=1920x1080
  fi
fi
"

gsettings set org.gnome.shell enabled-extensions "$ORIGINAL_ENABLED_EXTENSIONS"

echo "Nested shell session ended."
