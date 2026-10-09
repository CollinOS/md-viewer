#!/usr/bin/env bash
# Checks the desktop entry inside the built Linux packages, so opening a .md
# file from a file manager actually passes the file to the app.
# Usage: scripts/check-linux-packages.sh <bundle dir>
set -euo pipefail
bundle="${1:?bundle directory}"
fail=0

check() {
  local label="$1" desktop="$2"
  echo "== $label: $desktop"
  cat "$desktop"
  grep -Eq '^Exec=.* %[FfUu]$' "$desktop" || { echo "FAIL: Exec line doesn't take file arguments"; fail=1; }
  grep -q '^MimeType=.*text/markdown' "$desktop" || { echo "FAIL: text/markdown not registered"; fail=1; }
}

tmp="$(mktemp -d)"
shopt -s nullglob
for deb in "$bundle"/deb/*.deb; do
  dpkg-deb -x "$deb" "$tmp/deb"
  check "deb" "$(find "$tmp/deb" -name '*.desktop' | head -1)"
done
for appimage in "$bundle"/appimage/*.AppImage; do
  (cd "$tmp" && "$appimage" --appimage-extract > /dev/null)
  check "AppImage" "$(find "$tmp/squashfs-root" -maxdepth 1 -name '*.desktop' | head -1)"
done
exit $fail
