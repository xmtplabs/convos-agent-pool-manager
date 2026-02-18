/**
 * Instance key provisioning. Pool manager reads INSTANCE_* env vars and passes
 * them to Railway services (warm-up and claim). Set these in the pool manager's .env.
 */

import { randomBytes } from "crypto";

const POOL_API_KEY = process.env.POOL_API_KEY;
const INSTANCE_VAR_MAP = {
  OPENCLAW_PRIMARY_MODEL: "INSTANCE_OPENCLAW_PRIMARY_MODEL",
  OPENROUTER_API_KEY: "INSTANCE_OPENROUTER_API_KEY",
  OPENCLAW_GATEWAY_TOKEN: "INSTANCE_OPENCLAW_GATEWAY_TOKEN",
  SETUP_PASSWORD: "INSTANCE_SETUP_PASSWORD",
  XMTP_ENV: "INSTANCE_XMTP_ENV",
  AGENTMAIL_API_KEY: "INSTANCE_AGENTMAIL_API_KEY",
  AGENTMAIL_INBOX_ID: "INSTANCE_AGENTMAIL_INBOX_ID",
  BANKR_API_KEY: "INSTANCE_BANKR_API_KEY",
  TELNYX_API_KEY: "INSTANCE_TELNYX_API_KEY",
  TELNYX_PHONE_NUMBER: "INSTANCE_TELNYX_PHONE_NUMBER",
  TELNYX_MESSAGING_PROFILE_ID: "INSTANCE_TELNYX_MESSAGING_PROFILE_ID",
};

function getEnv(name, fallback = "") {
  const val = process.env[name];
  return val != null && val !== "" ? val : fallback;
}

/** Build env vars for instance (warm-up and claim). Omit OPENCLAW_GATEWAY_TOKEN and SETUP_PASSWORD when INSTANCE_* are unset so provision does not overwrite warmup-generated values. */
export function instanceEnvVars() {
  const gatewayToken = getEnv(INSTANCE_VAR_MAP.OPENCLAW_GATEWAY_TOKEN);
  const setupPassword = getEnv(INSTANCE_VAR_MAP.SETUP_PASSWORD);
  const vars = {
    OPENCLAW_STATE_DIR: "/app",
    OPENCLAW_PRIMARY_MODEL: getEnv(INSTANCE_VAR_MAP.OPENCLAW_PRIMARY_MODEL),
    OPENROUTER_API_KEY: getEnv(INSTANCE_VAR_MAP.OPENROUTER_API_KEY),
    XMTP_ENV: getEnv(INSTANCE_VAR_MAP.XMTP_ENV, "dev"),
    CHROMIUM_PATH: "/usr/bin/chromium",
    POOL_API_KEY: POOL_API_KEY || "",
    AGENTMAIL_API_KEY: getEnv(INSTANCE_VAR_MAP.AGENTMAIL_API_KEY),
    AGENTMAIL_INBOX_ID: getEnv(INSTANCE_VAR_MAP.AGENTMAIL_INBOX_ID),
    BANKR_API_KEY: getEnv(INSTANCE_VAR_MAP.BANKR_API_KEY),
    TELNYX_API_KEY: getEnv(INSTANCE_VAR_MAP.TELNYX_API_KEY),
    TELNYX_PHONE_NUMBER: getEnv(INSTANCE_VAR_MAP.TELNYX_PHONE_NUMBER),
    TELNYX_MESSAGING_PROFILE_ID: getEnv(INSTANCE_VAR_MAP.TELNYX_MESSAGING_PROFILE_ID),
  };
  if (gatewayToken) vars.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  if (setupPassword) vars.SETUP_PASSWORD = setupPassword;
  return vars;
}

/** Generate a random gateway token (64 hex chars, like openssl rand -hex 32). */
export function generateGatewayToken() {
  return randomBytes(32).toString("hex");
}

/** Generate a random setup password (32 hex chars, like openssl rand -hex 16). */
export function generateSetupPassword() {
  return randomBytes(16).toString("hex");
}

/** Generate a random Ethereum wallet private key (0x + 64 hex chars). */
export function generatePrivateWalletKey() {
  return "0x" + randomBytes(32).toString("hex");
}

/** Resolve OPENROUTER_API_KEY. Priority: 1) INSTANCE_OPENROUTER_API_KEY if set (no create), 2) create via OPENROUTER_MANAGEMENT_KEY.
 *  Returns { key, hash } — hash is null for shared keys or when no key is available. */
export async function resolveOpenRouterApiKey(instanceId) {
  const existing = getEnv(INSTANCE_VAR_MAP.OPENROUTER_API_KEY);
  if (existing) return { key: existing, hash: null }; // never create when shared key is configured
  if (!process.env.OPENROUTER_MANAGEMENT_KEY) return { key: "", hash: null };
  return createOpenRouterKey(instanceId);
}

/** Create an OpenRouter API key via management API. Pool manager only; never pass management key to instances. */
export async function createOpenRouterKey(instanceId) {
  const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!mgmtKey) throw new Error("OPENROUTER_MANAGEMENT_KEY not set");

  const name = `convos-agent-${instanceId}`;
  const limit = parseInt(process.env.OPENROUTER_KEY_LIMIT || "20", 10);
  const limitReset = process.env.OPENROUTER_KEY_LIMIT_RESET || "monthly";

  const res = await fetch("https://openrouter.ai/api/v1/keys", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mgmtKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, limit, limit_reset: limitReset }),
  });
  const body = await res.json();
  const key = body?.key;
  const hash = body?.data?.hash ?? null;
  if (!key) {
    console.error("[keys] OpenRouter create key failed:", res.status, body);
    throw new Error(`OpenRouter key creation failed: ${res.status}`);
  }
  console.log(`[keys] Created OpenRouter key for ${name} (hash=${hash})`);
  return { key, hash };
}

/** Delete an OpenRouter API key by hash. Best-effort — logs and swallows errors. */
export async function deleteOpenRouterKey(hash) {
  const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!mgmtKey || !hash) return;

  try {
    const res = await fetch(`https://openrouter.ai/api/v1/keys/${hash}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${mgmtKey}` },
    });
    if (res.ok) {
      console.log(`[keys] Deleted OpenRouter key (hash=${hash})`);
    } else {
      const body = await res.text();
      console.warn(`[keys] Failed to delete OpenRouter key (hash=${hash}): ${res.status} ${body}`);
    }
  } catch (err) {
    console.warn(`[keys] Failed to delete OpenRouter key (hash=${hash}):`, err.message);
  }
}
