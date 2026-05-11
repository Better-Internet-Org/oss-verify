#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Builds Bun-compiled standalone binaries for the targets listed in plan
# Decision #11: linux-x64, linux-arm64, macos-arm64, windows-x64.
#
# Output: dist/binaries/oss-verify-<target>{,.exe}
#
# Requires `bun` on PATH (https://bun.sh). Run via:
#   pnpm build:binaries     # locally
#   the release workflow    # in CI (.github/workflows/release.yml)

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required (https://bun.sh)" >&2
  exit 2
fi

OUT="dist/binaries"
mkdir -p "$OUT"
rm -f "$OUT"/*

declare -a TARGETS=(
  "bun-linux-x64:oss-verify-linux-x64"
  "bun-linux-arm64:oss-verify-linux-arm64"
  "bun-darwin-arm64:oss-verify-macos-arm64"
  "bun-windows-x64:oss-verify-windows-x64.exe"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  echo "→ Building $name (target=$target)"
  bun build src/cli.ts --compile --target="$target" --outfile="$OUT/$name"
done

echo
echo "✓ Built binaries:"
ls -lh "$OUT"
