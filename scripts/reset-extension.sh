#!/usr/bin/env bash
set -euo pipefail

UUID="global-it@notyorch.github.io"
SCHEMA="org.gnome.shell.extensions.global-it"

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
gsettings reset-recursively "$SCHEMA" >/dev/null 2>&1 || true
gnome-extensions enable "$UUID"

echo "Reset settings and re-enabled $UUID"
