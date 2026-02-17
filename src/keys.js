/**
 * Instance key provisioning. Pool manager reads INSTANCE_* env vars and passes
 * them to Railway services (warm-up and claim). Set these in the pool manager's .env.
 */

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
  PRIVATE_WALLET_KEY: "INSTANCE_PRIVATE_WALLET_KEY",
  TELNYX_API_KEY: "INSTANCE_TELNYX_API_KEY",
  TELNYX_PHONE_NUMBER: "INSTANCE_TELNYX_PHONE_NUMBER",
  TELNYX_MESSAGING_PROFILE_ID: "INSTANCE_TELNYX_MESSAGING_PROFILE_ID",
};

function getEnv(name, fallback = "") {
  const val = process.env[name];
  return val != null && val !== "" ? val : fallback;
}

/** Build env vars for instance (warm-up and claim). */
export function instanceEnvVars() {
  const vars = {
    OPENCLAW_PRIMARY_MODEL: getEnv(INSTANCE_VAR_MAP.OPENCLAW_PRIMARY_MODEL),
    OPENROUTER_API_KEY: getEnv(INSTANCE_VAR_MAP.OPENROUTER_API_KEY),
    OPENCLAW_GATEWAY_TOKEN: getEnv(INSTANCE_VAR_MAP.OPENCLAW_GATEWAY_TOKEN),
    SETUP_PASSWORD: getEnv(INSTANCE_VAR_MAP.SETUP_PASSWORD),
    XMTP_ENV: getEnv(INSTANCE_VAR_MAP.XMTP_ENV, "dev"),
    CHROMIUM_PATH: "/usr/bin/chromium",
    GATEWAY_AUTH_TOKEN: POOL_API_KEY || "",
    OPENCLAW_STATE_DIR: "/data",
    AGENTMAIL_API_KEY: getEnv(INSTANCE_VAR_MAP.AGENTMAIL_API_KEY),
    AGENTMAIL_INBOX_ID: getEnv(INSTANCE_VAR_MAP.AGENTMAIL_INBOX_ID),
    BANKR_API_KEY: getEnv(INSTANCE_VAR_MAP.BANKR_API_KEY),
    PRIVATE_WALLET_KEY: getEnv(INSTANCE_VAR_MAP.PRIVATE_WALLET_KEY),
    TELNYX_API_KEY: getEnv(INSTANCE_VAR_MAP.TELNYX_API_KEY),
    TELNYX_PHONE_NUMBER: getEnv(INSTANCE_VAR_MAP.TELNYX_PHONE_NUMBER),
    TELNYX_MESSAGING_PROFILE_ID: getEnv(INSTANCE_VAR_MAP.TELNYX_MESSAGING_PROFILE_ID),
  };
  return vars;
}

/** Env vars for provision (claim time). All keys + model override + AGENT_NAME. */
export function instanceEnvVarsForProvision(opts) {
  const { model, agentName, openRouterApiKey } = opts;
  const base = { ...instanceEnvVars(), AGENT_NAME: agentName || "" };
  if (model) base.OPENCLAW_PRIMARY_MODEL = model;
  if (openRouterApiKey != null && openRouterApiKey !== "") base.OPENROUTER_API_KEY = openRouterApiKey;
  return base;
}

/** Resolve OPENROUTER_API_KEY. Priority: 1) INSTANCE_OPENROUTER_API_KEY if set (no create), 2) create via OPENROUTER_MANAGEMENT_KEY. */
export async function resolveOpenRouterApiKey(instanceId) {
  const existing = getEnv(INSTANCE_VAR_MAP.OPENROUTER_API_KEY);
  if (existing) return existing; // never create when shared key is configured
  if (!process.env.OPENROUTER_MANAGEMENT_KEY) return "";
  return createOpenRouterKey(instanceId);
}

/** Create an OpenRouter API key via management API. Pool manager only; never pass management key to instances. */
export async function createOpenRouterKey(instanceId) {
  const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!mgmtKey) throw new Error("OPENROUTER_MANAGEMENT_KEY not set");

  const name = `convos-${instanceId}-${Date.now()}`;
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
  if (!key) {
    console.error("[keys] OpenRouter create key failed:", res.status, body);
    throw new Error(`OpenRouter key creation failed: ${res.status}`);
  }
  return key;
}
