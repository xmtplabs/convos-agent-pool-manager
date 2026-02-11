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
echo "[2.5/6] pnpm ready: $(pnpm --version)"

# --- Clone and build OpenClaw ---
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

pnpm install --no-frozen-lockfile > /dev/null 2>&1
pnpm build > /dev/null 2>&1
pnpm ui:install > /dev/null 2>&1 && pnpm ui:build > /dev/null 2>&1
echo "[3/6] OpenClaw built"

# --- Create openclaw CLI wrapper ---
mkdir -p /usr/local/bin
cat > /usr/local/bin/openclaw << 'WRAPPER'
#!/usr/bin/env bash
exec node /openclaw/dist/entry.js "$@"
WRAPPER
chmod +x /usr/local/bin/openclaw
echo "[4/6] OpenClaw CLI ready"

# --- Clone convos-agent wrapper ---
rm -rf /opt/convos-agent
git clone --depth 1 https://github.com/xmtplabs/convos-agent-railway-template /opt/convos-agent
cd /opt/convos-agent
npm install --omit=dev > /dev/null 2>&1
echo "[5/6] Convos-agent wrapper installed"

# --- Create persistent directories ---
# Setup runs as root, but the server runs as user "sprite" via createSession.
# Make state + app dirs writable by the sprite user.
mkdir -p /opt/convos-agent/.openclaw/workspace
chmod -R 777 /opt/convos-agent

echo "[6/6] Setup complete"
