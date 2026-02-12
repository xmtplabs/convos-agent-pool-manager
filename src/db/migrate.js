import { sql } from "./connection.js";

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS pool_instances (
      id TEXT PRIMARY KEY,
      sprite_name TEXT NOT NULL,
      sprite_url TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      claimed_by TEXT,
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

  // Rename column if upgrading from older schema
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'claimed_by_concierge_id'
      ) THEN
        ALTER TABLE pool_instances RENAME COLUMN claimed_by_concierge_id TO claimed_by;
      END IF;
    END $$
  `;

  // Add instructions column if missing
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'instructions'
      ) THEN
        ALTER TABLE pool_instances ADD COLUMN instructions TEXT;
      END IF;
    END $$
  `;

  // Add join_url column if missing
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'join_url'
      ) THEN
        ALTER TABLE pool_instances ADD COLUMN join_url TEXT;
      END IF;
    END $$
  `;

  // Add checkpoint_id column if missing
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'checkpoint_id'
      ) THEN
        ALTER TABLE pool_instances ADD COLUMN checkpoint_id TEXT;
      END IF;
    END $$
  `;

  // Rename Railway columns to Sprite columns
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'railway_service_id'
      ) THEN
        ALTER TABLE pool_instances RENAME COLUMN railway_service_id TO sprite_name;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pool_instances' AND column_name = 'railway_url'
      ) THEN
        ALTER TABLE pool_instances RENAME COLUMN railway_url TO sprite_url;
      END IF;
    END $$
  `;

  console.log("Migration complete.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
