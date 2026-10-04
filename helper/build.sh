#!/bin/zsh

set -euo pipefail

PROVIDER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${PROVIDER_DIR}/helper/dist"

# A missing node would otherwise fall through to whatever PATH offers; the build tool is the only PATH use.
if ! command -v node >/dev/null 2>&1; then
  echo "Missing node (needed only to run the build scripts)." >&2
  exit 1
fi

# The pinned, self-contained LGPL ffmpeg used for the AAC stream-copy remux and length checks.
node "${PUROS_PROVIDER_CLI:?Run through puros-provider build (or npm run build)}" ffmpeg "--install=${DIST_DIR}" >/dev/null

# Self-check in the same clean environment the host gives helpers.
CHECK_HOME="$(mktemp -d "${TMPDIR:-/tmp}/puros-soundcloud-check.XXXXXX")"
trap 'rm -rf "${CHECK_HOME}"' EXIT
if ! env -i HOME="${CHECK_HOME}" TMPDIR="${CHECK_HOME}" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 "${DIST_DIR}/ffmpeg" -version >/dev/null 2>&1; then
  echo "Installed ffmpeg cannot start: ${DIST_DIR}/ffmpeg" >&2
  exit 1
fi
codesign --verify "${DIST_DIR}/ffmpeg"
