#!/bin/bash
# Teebe installer: https://teebe.io
# Usage: curl -fsSL https://teebe.io/install.sh | bash
#
# Installs teebe.app into /Applications without the Gatekeeper "unverified
# developer" block. curl-downloaded files carry no com.apple.quarantine flag,
# so the app opens on first launch with no dialog. Sparkle handles updates after.
#
# The download is fetched via https://dl.teebe.io, which records anonymous,
# aggregate install stats (app version, country, user-agent, never your IP)
# then redirects to the GitHub release asset. See https://teebe.io/privacy/.
set -euo pipefail

# teebe runs only on Apple Silicon with macOS 14 or newer. Check before any
# download or change to /Applications.
check_system() {
  local os arch arm64 version major
  os=$(uname -s)
  if [ "${os}" != "Darwin" ]; then
    echo "error: teebe requires macOS on Apple Silicon (found: ${os})." >&2
    exit 1
  fi

  # uname -m reports x86_64 in a Terminal running under Rosetta, so ask the
  # kernel whether the hardware itself is Apple Silicon.
  arch=$(uname -m)
  arm64=$(sysctl -n hw.optional.arm64 2>/dev/null || true)
  if [ "${arch}" != "arm64" ] && [ "${arm64}" != "1" ]; then
    echo "error: teebe requires a Mac with Apple Silicon (found: Intel, ${arch})." >&2
    exit 1
  fi

  version=$(sw_vers -productVersion 2>/dev/null || true)
  major=${version%%.*}
  case "${major}" in
    ''|*[!0-9]*)
      echo "error: teebe requires macOS 14 or newer (found: unknown version '${version}')." >&2
      exit 1
      ;;
  esac
  if [ "${major}" -lt 14 ]; then
    echo "error: teebe requires macOS 14 or newer (found: macOS ${version})." >&2
    exit 1
  fi
}

# Everything runs inside main, called on the last line, so a download of this
# script cut off midway runs nothing.
main() {
  REPO="klein-t/teebe"
  APP="teebe.app"
  DEST="/Applications"

  check_system

  TMP=$(mktemp -d)
  trap 'rm -rf "${TMP}"' EXIT

  echo "Downloading teebe…"
  # Primary: through the download endpoint (counts the install). Falls back to a
  # direct GitHub fetch if the endpoint is unreachable.
  if ! curl -fsSL -A "teebe-install" "https://dl.teebe.io" -o "${TMP}/teebe.zip"; then
    echo "Download endpoint unavailable, fetching from GitHub…"
    ZIP_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep -o '"browser_download_url": *"[^"]*\.zip"' \
      | head -1 | sed 's/.*"https/https/; s/"$//')
    [ -n "${ZIP_URL}" ] || { echo "error: could not find a .zip asset on the latest release" >&2; exit 1; }
    curl -fsSL "${ZIP_URL}" -o "${TMP}/teebe.zip"
  fi

  echo "Unpacking…"
  unzip -q "${TMP}/teebe.zip" -d "${TMP}"

  # Locate the .app inside the archive (handles any nesting).
  APP_PATH=$(find "${TMP}" -maxdepth 2 -name "${APP}" -type d | head -1)
  if [ -z "${APP_PATH}" ]; then
    echo "error: ${APP} not found in archive" >&2
    exit 1
  fi

  # Replace any existing install.
  if [ -d "${DEST}/${APP}" ]; then
    echo "Removing previous ${APP}…"
    rm -rf "${DEST}/${APP}"
  fi

  echo "Installing to ${DEST}…"
  mv "${APP_PATH}" "${DEST}/"

  # Belt-and-suspenders: strip quarantine in case anything set it.
  xattr -dr com.apple.quarantine "${DEST}/${APP}" 2>/dev/null || true

  echo "Launching teebe…"
  open "${DEST}/${APP}"

  echo "✓ teebe installed. Updates are handled automatically from here."
}

main "$@"
