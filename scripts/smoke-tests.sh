#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="global-it@notyorch.github.io"

echo "Running logic smoke tests..."
gjs -m "$REPO_ROOT/tests/smoke.js"

if [[ "${LIVE_SHELL_TESTS:-0}" != "1" ]]; then
  echo "Skipping live Shell enable/disable cycles (set LIVE_SHELL_TESTS=1 to enable)."
  exit 0
fi

echo "Running live extension enable/disable cycles..."
for i in {1..8}; do
  gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
  gnome-extensions enable "$UUID"
done

echo "Live Shell cycle smoke test passed."
