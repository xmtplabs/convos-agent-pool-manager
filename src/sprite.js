import { SpritesClient } from "@fly/sprites";
import * as log from "./log.js";

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
  log.debug(`[sprite] Creating sprite: ${name}`);
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
  const spriteInfo = await urlRes.json();
  const url = spriteInfo.url;
  if (!url) {
    throw new Error(`Sprite API did not return a URL for ${name}`);
  }
  log.debug(`[sprite]   URL: ${url}`);
  return { name, url };
}

// Delete a sprite by name. No-op if already gone.
export async function deleteSprite(name) {
  log.debug(`[sprite] Deleting sprite: ${name}`);
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
export async function listSprites(prefix = `convos-agent-${process.env.POOL_ENVIRONMENT || "dev"}-`) {
  return client().listAllSprites(prefix);
}

// Execute a shell command inside a sprite. Waits for completion.
// Returns { stdout, stderr, exitCode }.
export async function exec(name, command) {
  const safeCmd = command.replace(/(?:API_KEY|SECRET|TOKEN)=\S+/gi, (m) => m.split("=")[0] + "=***");
  log.debug(`[sprite] exec on ${name}: ${safeCmd.slice(0, 80)}${safeCmd.length > 80 ? "..." : ""}`);
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
  log.debug(`[sprite] Creating checkpoint on ${name}${comment ? `: ${comment}` : ""}`);
  const s = client().sprite(name);
  const res = await s.createCheckpoint(comment);
  const id = await consumeNdjsonStream(res);
  if (!id) {
    log.error(`[sprite]   Checkpoint stream completed but no ID returned for ${name}`);
    throw new Error(`Checkpoint creation on ${name} returned no ID`);
  }
  log.debug(`[sprite]   Checkpoint created: ${id}`);
  return id;
}

// Restore a sprite to a previously saved checkpoint.
// Kills all running processes and resets filesystem state.
export async function restoreCheckpoint(name, checkpointId) {
  log.debug(`[sprite] Restoring checkpoint ${checkpointId} on ${name}`);
  const s = client().sprite(name);
  const res = await s.restoreCheckpoint(checkpointId);
  await consumeNdjsonStream(res);
  log.debug(`[sprite]   Checkpoint restored`);
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
        log.debug(`[sprite]   ndjson: ${JSON.stringify(msg)}`);
        if (msg.id) lastId = msg.id;
        // Sprites checkpoint API embeds the ID in info/complete data strings
        if (msg.data) {
          const idMatch = msg.data.match(/^\s*ID:\s+(\S+)/);
          if (idMatch) lastId = idMatch[1];
          const cpMatch = msg.data.match(/Checkpoint\s+(\S+)\s+created/);
          if (cpMatch && !lastId) lastId = cpMatch[1];
        }
        if (msg.status) {
          log.debug(`[sprite]   checkpoint: ${msg.status}`);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }
  return lastId;
}

// Register a persistent service on a Sprite via the sprite-env CLI.
// Services auto-restart when a Sprite wakes from hibernation (unlike TTY sessions).
// Uses the CLI because the REST API's PUT endpoint has a bug ("service name required").
// Writes a wrapper script because the CLI's --args flag eats flags like "-c".
export async function registerService(spriteName, serviceName, command) {
  log.debug(`[sprite] Registering service "${serviceName}" on ${spriteName}`);
  const scriptPath = `/tmp/service-${serviceName}.sh`;
  await exec(spriteName, `cat > ${scriptPath} << 'SVCEOF'\n#!/usr/bin/env bash\n${command}\nSVCEOF\nchmod +x ${scriptPath}`);
  await exec(spriteName, `/.sprite/bin/sprite-env services create ${serviceName} --cmd ${scriptPath}`);
  log.debug(`[sprite]   Service "${serviceName}" registered`);
}
