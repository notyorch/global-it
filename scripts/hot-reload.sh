#!/usr/bin/env bash
set -euo pipefail

UUID="global-it@notyorch.github.io"

if gdbus call --session \
  --dest org.gnome.Shell.Extensions \
  --object-path /org/gnome/Shell/Extensions \
  --method org.gnome.Shell.Extensions.ReloadExtension "$UUID" >/dev/null 2>&1; then
  echo "Hot reloaded $UUID via Shell Extensions DBus API"
  exit 0
fi

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
gnome-extensions enable "$UUID" >/dev/null
echo "Reloaded $UUID via disable/enable fallback"
