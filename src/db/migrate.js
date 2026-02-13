import { sql } from "./connection.js";

async function migrate() {
  // If old table exists, rename and clean up
  const oldTable = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'pool_instances'
  `;

  if (oldTable.rows.length > 0) {
    console.log("Migrating pool_instances → agent_metadata...");

    await sql`ALTER TABLE pool_instances RENAME TO agent_metadata`;

    // Drop unused columns
    await sql`
      DO $$
      BEGIN
        ALTER TABLE agent_metadata DROP COLUMN IF EXISTS railway_url;
        ALTER TABLE agent_metadata DROP COLUMN IF EXISTS status;
        ALTER TABLE agent_metadata DROP COLUMN IF EXISTS health_check_failures;
        ALTER TABLE agent_metadata DROP COLUMN IF EXISTS updated_at;
        ALTER TABLE agent_metadata DROP COLUMN IF EXISTS join_url;
      END $$
    `;

    // Rename claimed_by → agent_name
    await sql`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agent_metadata' AND column_name = 'claimed_by'
        ) THEN
          ALTER TABLE agent_metadata RENAME COLUMN claimed_by TO agent_name;
        END IF;
      END $$
    `;

    // Delete non-claimed rows (no useful metadata)
    const deleted = await sql`DELETE FROM agent_metadata WHERE agent_name IS NULL`;
    console.log(`  Cleaned ${deleted.rowCount || 0} non-claimed rows`);

    // Match fresh install schema: agent_name should be NOT NULL
    await sql`ALTER TABLE agent_metadata ALTER COLUMN agent_name SET NOT NULL`;

    console.log("Migration complete.");
  } else {
    // Check if agent_metadata already exists (idempotent)
    const newTable = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'agent_metadata'
    `;

    if (newTable.rows.length > 0) {
      console.log("agent_metadata table already exists. Nothing to do.");
    } else {
      // Fresh install — create agent_metadata directly
      await sql`
        CREATE TABLE agent_metadata (
          id TEXT PRIMARY KEY,
          railway_service_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          conversation_id TEXT,
          invite_url TEXT,
          instructions TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          claimed_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      console.log("Created agent_metadata table.");
    }
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
