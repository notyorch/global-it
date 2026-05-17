#!/usr/bin/env bash
set -euo pipefail

UUID="global-it@notyorch.github.io"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$TARGET_DIR")"

if [[ -e "$TARGET_DIR" && ! -L "$TARGET_DIR" ]]; then
  BACKUP_DIR="${TARGET_DIR}.backup.$(date +%s)"
  mv "$TARGET_DIR" "$BACKUP_DIR"
  echo "Backed up existing extension to: $BACKUP_DIR"
fi

ln -sfn "$REPO_ROOT" "$TARGET_DIR"
glib-compile-schemas "$REPO_ROOT/schemas"

echo "Installed development symlink:"
echo "  $TARGET_DIR -> $REPO_ROOT"
echo "Run ./scripts/hot-reload.sh to apply code changes without logging out."
