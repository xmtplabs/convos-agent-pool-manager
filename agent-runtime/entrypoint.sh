#!/usr/bin/env bash
set -euo pipefail

mkdir -p ~/.openclaw/workspace

jq -n \
  --arg xmtp_env "${XMTP_ENV:-dev}" \
  --arg gateway_token "${GATEWAY_AUTH_TOKEN:-changeme}" \
  --arg pool_api_key "${GATEWAY_AUTH_TOKEN:-}" \
  '{
    auth: {
      profiles: {
        "anthropic:default": {
          provider: "anthropic",
          mode: "token"
        }
      }
    },
    channels: {
      convos: {
        enabled: true,
        env: $xmtp_env,
        poolApiKey: $pool_api_key
      }
    },
    gateway: {
      mode: "local",
      port: 8080,
      bind: "lan",
      auth: { token: $gateway_token },
      reload: { mode: "off" }
    }
  }' > ~/.openclaw/openclaw.json

exec openclaw gateway run --port 8080
