#!/usr/bin/env node
// Destroy all convos-agent sprites and clear the DB.
// Usage: npm run drain:all

import { SpritesClient } from "@fly/sprites";
import { neon } from "@neondatabase/serverless";

const token = process.env.SPRITE_TOKEN;
if (!token) { console.error("SPRITE_TOKEN not set"); process.exit(1); }

const db = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const client = new SpritesClient(token);

const sprites = await client.listAllSprites("convos-agent-");
console.log(`Found ${sprites.length} convos-agent sprite(s)`);

for (const s of sprites) {
  try {
    await client.deleteSprite(s.name);
    console.log(`  Destroyed: ${s.name}`);
  } catch (err) {
    console.warn(`  Failed: ${s.name} — ${err.message}`);
  }
}

if (db) {
  const result = await db`DELETE FROM pool_instances RETURNING id`;
  console.log(`Cleared ${result.length} DB row(s)`);
} else {
  console.log("No DATABASE_URL — skipped DB cleanup");
}

console.log("Done");
