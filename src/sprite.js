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

// Create a new sprite and set its URL to public.
// Returns { name, url } where url is the public HTTPS URL from the API.
export async function createSprite(name) {
  console.log(`[sprite] Creating sprite: ${name}`);
  await client().createSprite(name);

  // Make the sprite URL publicly accessible and read back the assigned URL
  // (the API adds a hash suffix to the name, e.g. name-bmabx.sprites.app)
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
    throw new Error(`url_settings PUT failed: ${urlRes.status} ${body}`);
  }
  const info = await urlRes.json();
  const url = info.url;
  if (!url) {
    throw new Error(`Sprite API did not return a URL for ${name}`);
  }
  console.log(`[sprite]   URL: ${url}`);
  return { name, url };
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

// Create a checkpoint of the sprite's current state.
// Consumes the NDJSON response stream and returns the checkpoint ID (e.g. "v0").
export async function createCheckpoint(name, comment) {
  console.log(`[sprite] Creating checkpoint on ${name}${comment ? `: ${comment}` : ""}`);
  const s = client().sprite(name);
  const res = await s.createCheckpoint(comment);
  const id = await consumeNdjsonStream(res);
  console.log(`[sprite]   Checkpoint created: ${id}`);
  return id;
}

// Restore a sprite to a previously saved checkpoint.
// Kills all running processes and resets filesystem state.
export async function restoreCheckpoint(name, checkpointId) {
  console.log(`[sprite] Restoring checkpoint ${checkpointId} on ${name}`);
  const s = client().sprite(name);
  const res = await s.restoreCheckpoint(checkpointId);
  await consumeNdjsonStream(res);
  console.log(`[sprite]   Checkpoint restored`);
}

// List all checkpoints for a sprite.
export async function listCheckpoints(name) {
  const s = client().sprite(name);
  return s.listCheckpoints();
}

// Consume an NDJSON streaming response from the Sprites API.
// Returns the checkpoint ID from the final message (if present).
async function consumeNdjsonStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lastId = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        console.log(`[sprite]   ndjson: ${JSON.stringify(msg)}`);
        if (msg.id) lastId = msg.id;
        if (msg.status) {
          console.log(`[sprite]   checkpoint: ${msg.status}`);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }
  return lastId;
}

// Start a long-running process inside a sprite (detached tmux session).
// Returns immediately — the process runs in the background.
// Set logLines > 0 to capture initial output for debugging.
export async function startDetached(name, command, { logLines = 0 } = {}) {
  console.log(`[sprite] Starting detached on ${name}: ${command.slice(0, 80)}`);
  const s = client().sprite(name);
  const cmd = s.createSession("bash", ["-c", command]);
  let logged = 0;
  const logChunk = (stream, chunk) => {
    if (logged >= logLines) return;
    for (const line of chunk.toString().split("\n")) {
      if (line.trim() && logged < logLines) {
        console.log(`[sprite]   ${name} ${stream}: ${line.trim()}`);
        logged++;
      }
    }
  };
  cmd.stdout.on("data", logLines > 0 ? (d) => logChunk("out", d) : () => {});
  cmd.stderr.on("data", logLines > 0 ? (d) => logChunk("err", d) : () => {});
  cmd.on("error", (err) => {
    console.warn(`[sprite] startDetached error on ${name}: ${err.message}`);
  });
}
