import { sql } from "@vercel/postgres";

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS pool_instances (
      id TEXT PRIMARY KEY,
      railway_service_id TEXT NOT NULL,
      railway_url TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      claimed_by_concierge_id TEXT,
      claimed_at TIMESTAMPTZ,
      invite_url TEXT,
      conversation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pool_instances_status
    ON pool_instances (status)
  `;

  console.log("Migration complete.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
