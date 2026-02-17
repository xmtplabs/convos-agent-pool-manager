/** OpenRouter models (mirrors openclaw.json). */
export const OPENROUTER_MODELS = [
  { id: "openrouter/openai/gpt-oss-20b", name: "GPT-OSS 20B" },
  { id: "openrouter/openai/gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
  { id: "openrouter/perplexity/sonar", name: "Perplexity Sonar" },
  { id: "openrouter/openai/gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { id: "openrouter/anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "openrouter/anthropic/claude-opus-4", name: "Claude Opus 4" },
  { id: "openrouter/google/gemini-2.0-flash-exp", name: "Gemini 2.0 Flash" },
  { id: "openrouter/meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
  { id: "openrouter/deepseek/deepseek-r1", name: "DeepSeek R1" },
  { id: "openrouter/qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B" },
  { id: "openrouter/openai/gpt-4o", name: "GPT-4o" },
  { id: "openrouter/openai/gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "openrouter/mistralai/mistral-large-2411", name: "Mistral Large" },
];

/** Agent identity presets — instruction blocks prepended to custom instructions. */
export const IDENTITY_PRESETS = {
  booking:
    "You are a booking agent. Help users reserve tables, flights, hotels, and appointments. Use web search and browser tools to find availability and complete bookings.\n\n",
  restaurant:
    "You are a restaurant booking assistant. Help users find restaurants, check availability, and reserve tables. Use web search and browser tools to book via Resy, OpenTable, or direct restaurant sites.\n\n",
  travel:
    "You are a travel planner. Help users plan trips, book flights, hotels, and activities. Use web search and browser tools to find options and complete reservations.\n\n",
};

/** Resolve identity preset by id. Returns instruction block or empty string. */
export function resolveIdentityPreset(id) {
  if (!id || typeof id !== "string") return "";
  return IDENTITY_PRESETS[id] || "";
}
