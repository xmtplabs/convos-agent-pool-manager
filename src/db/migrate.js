import { sql } from "./connection.js";

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS pool_instances (
      id TEXT PRIMARY KEY,
      sprite_name TEXT NOT NULL,
      sprite_url TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      checkpoint_id TEXT,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      invite_url TEXT,
      conversation_id TEXT,
      instructions TEXT,
      join_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pool_instances_status
    ON pool_instances (status)
  `;

  console.log("Migration complete.");
  await sql.end();
  process.exit(0);
}

migrate().catch(async (err) => {
  console.error("Migration failed:", err);
  await sql.end().catch(() => {});
  process.exit(1);
});
