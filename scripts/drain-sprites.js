#!/usr/bin/env node
// Destroy all sprites for the current environment and clear the DB.
// Respects POOL_ENVIRONMENT — only touches sprites with the matching prefix.
// Usage: npm run drain:all

import * as sprite from "../src/sprite.js";
import { sql } from "../src/db/connection.js";

const env = process.env.POOL_ENVIRONMENT || "dev";
const prefix = `convos-agent-${env}-`;

console.log(`Draining all "${env}" sprites (prefix: ${prefix})`);

const sprites = await sprite.listSprites(prefix);
console.log(`Found ${sprites.length} sprite(s)`);

for (const s of sprites) {
  try {
    await sprite.deleteSprite(s.name);
    console.log(`  Destroyed: ${s.name}`);
  } catch (err) {
    console.warn(`  Failed: ${s.name} — ${err.message}`);
  }
}

const result = await sql`DELETE FROM pool_instances RETURNING id`;
console.log(`Cleared ${result.length} DB row(s)`);

await sql.end();
console.log("Done");
