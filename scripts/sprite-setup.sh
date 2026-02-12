#!/usr/bin/env bash
set -euo pipefail

echo "=== Sprite setup: convos-agent ==="

# --- Build tools (most already present on Sprite Ubuntu image) ---
apt-get update -qq && apt-get install -y -qq git ca-certificates curl python3 make g++ > /dev/null 2>&1
echo "[1/6] Build tools ready"

# --- Install Bun (needed for OpenClaw build) ---
if ! command -v bun &> /dev/null; then
  curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1
  export PATH="$HOME/.bun/bin:$PATH"
fi
echo "[2/6] Bun ready"

# --- Install pnpm and ensure it's in PATH ---
npm install -g pnpm > /dev/null 2>&1
export PATH="$(npm config get prefix)/bin:$PATH"
echo "[3/6] pnpm ready: $(pnpm --version)"

# --- Clone OpenClaw and install dependencies ---
# Install to /openclaw so paths match the convos-agent server defaults:
#   OPENCLAW_ENTRY=/openclaw/dist/entry.js
#   plugins.load.paths=["/openclaw/extensions"]
OPENCLAW_BRANCH="${OPENCLAW_GIT_REF:-main}"
rm -rf /openclaw
git clone --depth 1 --branch "$OPENCLAW_BRANCH" https://github.com/xmtplabs/openclaw /openclaw
cd /openclaw

# Patch extension version constraints
find ./extensions -name 'package.json' -type f | while read f; do
  sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"
  sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"
done
echo "[4/6] Patches applied, running pnpm install..."

pnpm install --no-frozen-lockfile 2>&1 | tail -20
echo "[5/6] pnpm install done"

# Build, UI, and CLI wrapper are run as separate exec calls by the pool manager
# to avoid WebSocket timeout on long-running commands.
echo "[6/6] Phase 1 complete — ready for build phase"
