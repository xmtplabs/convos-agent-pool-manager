#!/usr/bin/env bash
set -euo pipefail

mkdir -p ~/.openclaw/workspace

cat > ~/.openclaw/openclaw.json << EOF
{
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "token"
      }
    }
  },
  "channels": {
    "convos": {
      "enabled": true,
      "env": "${XMTP_ENV:-dev}",
      "poolApiKey": "${GATEWAY_AUTH_TOKEN:-}"
    }
  },
  "gateway": {
    "mode": "local",
    "port": 8080,
    "bind": "lan",
    "reload": { "mode": "off" }
  }
}
EOF

exec openclaw gateway run --port 8080
