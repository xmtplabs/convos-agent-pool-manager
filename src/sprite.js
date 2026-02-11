import { SpritesClient } from "@fly/sprites";

let _client;
function client() {
  if (!_client) {
    const token = process.env.SPRITE_TOKEN;
    if (!token) throw new Error("SPRITE_TOKEN not set");
    _client = new SpritesClient(token);
  }
  return _client;
}

// Sprite public URL convention (*.sprites.app, NOT *.sprites.dev which is the API domain)
function spriteUrl(name) {
  return `https://${name}.sprites.app`;
}

// Create a new sprite and set its URL to public.
// Returns { name, url } where url is the public HTTPS URL.
export async function createSprite(name) {
  console.log(`[sprite] Creating sprite: ${name}`);
  const sprite = await client().createSprite(name);

  // Make the sprite URL publicly accessible (no sprite auth on HTTP)
  const urlRes = await fetch(`${client().baseURL}/v1/sprites/${name}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${client().token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url_settings: { auth: "public" } }),
  });
  if (!urlRes.ok) {
    const body = await urlRes.text().catch(() => "");
    console.warn(`[sprite]   url_settings PUT failed: ${urlRes.status} ${body}`);
  } else {
    const body = await urlRes.json().catch(() => ({}));
    console.log(`[sprite]   url_settings: ${JSON.stringify(body.url_settings || body.url || "ok")}`);
  }

  const url = spriteUrl(name);
  console.log(`[sprite]   URL: ${url}`);
  return { name: sprite.name, url };
}

// Delete a sprite by name. No-op if already gone.
export async function deleteSprite(name) {
  console.log(`[sprite] Deleting sprite: ${name}`);
  try {
    await client().deleteSprite(name);
  } catch (err) {
    if (err.message?.includes("404")) return;
    throw err;
  }
}

// Check if a sprite exists. Returns { name, status } or null.
export async function getSpriteInfo(name) {
  try {
    const sprite = await client().getSprite(name);
    return { name: sprite.name, status: sprite.status };
  } catch {
    return null;
  }
}

// List all sprites whose names start with a given prefix.
// Returns array of Sprite objects.
export async function listSprites(prefix = "convos-agent-") {
  return client().listAllSprites(prefix);
}

// Execute a shell command inside a sprite. Waits for completion.
// Returns { stdout, stderr, exitCode }.
export async function exec(name, command) {
  console.log(`[sprite] exec on ${name}: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`);
  const sprite = client().sprite(name);
  const result = await sprite.execFile("bash", ["-c", command]);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

// Start a long-running process inside a sprite (detached tmux session).
// Returns immediately — the process runs in the background.
export async function startDetached(name, command) {
  console.log(`[sprite] Starting detached on ${name}: ${command.slice(0, 80)}`);
  const sprite = client().sprite(name);
  const cmd = sprite.createSession("bash", ["-c", command]);
  // Drain streams and handle errors to prevent uncaught exceptions
  cmd.stdout.on("data", () => {});
  cmd.stderr.on("data", () => {});
  cmd.on("error", (err) => {
    console.warn(`[sprite] startDetached error on ${name}: ${err.message}`);
  });
}
