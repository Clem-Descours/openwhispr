#!/usr/bin/env bash
# Build, sign and install this fork into /Applications on the local Mac.
#
# Why sign: an unsigned (ad hoc) build gets a new signature on every build, and
# macOS ties the Accessibility, Microphone and Screen Recording grants to it, so
# every install silently loses auto-paste. Signing every build with the same
# certificate keeps the grants across updates.
#
# Usage:
#   scripts/install-local-mac.sh            build, sign, install, relaunch
#   scripts/install-local-mac.sh --no-build sign and install the last build
#
# The certificate is the first "Apple Development" identity in the keychain, or
# the one named in OPENWHISPR_SIGN_IDENTITY (name or SHA-1). The first run may
# ask to let codesign use the key: choose "Always Allow".

set -euo pipefail

APP_NAME="OpenWhispr"
INSTALLED="/Applications/${APP_NAME}.app"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only." >&2
  exit 1
fi

identity="${OPENWHISPR_SIGN_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity="$(security find-identity -v -p codesigning \
    | awk -F'"' '/Apple Development/ { print $2; exit }')"
fi
if [[ -z "$identity" ]]; then
  echo "No code signing certificate found. Set OPENWHISPR_SIGN_IDENTITY, or create an" >&2
  echo "Apple Development certificate in Xcode (Settings > Accounts > Manage Certificates)." >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> Building"
  npm run pack
fi

built="$(ls -d dist/mac-*/"${APP_NAME}.app" 2>/dev/null | head -n 1 || true)"
if [[ -z "$built" ]]; then
  echo "No build found under dist/. Run without --no-build." >&2
  exit 1
fi

echo "==> Signing with: $identity"
# No hardened runtime: the build has no entitlements for it, and a local install
# doesn't need notarization.
codesign --force --deep --sign "$identity" "$built"
codesign --verify --deep --strict "$built"

if pgrep -f "${INSTALLED}/Contents/MacOS/${APP_NAME}" >/dev/null; then
  echo "==> Quitting ${APP_NAME}"
  osascript -e "quit app \"${APP_NAME}\"" || true
  for _ in $(seq 1 40); do
    pgrep -f "${INSTALLED}/Contents/MacOS/${APP_NAME}" >/dev/null || break
    sleep 0.25
  done
  if pgrep -f "${INSTALLED}/Contents/MacOS/${APP_NAME}" >/dev/null; then
    echo "${APP_NAME} is still running; quit it and run this again." >&2
    exit 1
  fi
fi

if [[ -d "$INSTALLED" ]]; then
  echo "==> Moving the previous version to the Trash"
  osascript -e "tell application \"Finder\" to delete POSIX file \"${INSTALLED}\"" >/dev/null
fi

echo "==> Installing"
ditto "$built" "$INSTALLED"
xattr -dr com.apple.quarantine "$INSTALLED" 2>/dev/null || true

open "$INSTALLED"
echo "==> Done. ${APP_NAME} is installed and running."
