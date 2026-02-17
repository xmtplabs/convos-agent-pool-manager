import { sql } from "./connection.js";

// Insert metadata when an instance is claimed.
export async function insertMetadata({ id, railwayServiceId, agentName, conversationId, inviteUrl, instructions }) {
  await sql`
    INSERT INTO agent_metadata (id, railway_service_id, agent_name, conversation_id, invite_url, instructions, claimed_at)
    VALUES (${id}, ${railwayServiceId}, ${agentName}, ${conversationId}, ${inviteUrl || null}, ${instructions || null}, NOW())
  `;
}

// Find metadata by Railway service ID.
export async function findByServiceId(railwayServiceId) {
  const rows = await sql`
    SELECT * FROM agent_metadata WHERE railway_service_id = ${railwayServiceId}
  `;
  return rows[0] || null;
}

// Find metadata by instance ID.
export async function findById(id) {
  const rows = await sql`
    SELECT * FROM agent_metadata WHERE id = ${id}
  `;
  return rows[0] || null;
}

// List all metadata rows (for enriching cache with instructions).
export async function listAll() {
  return await sql`
    SELECT * FROM agent_metadata ORDER BY claimed_at DESC
  `;
}

// Delete metadata row (when dismissing crashed agent or killing instance).
export async function deleteByServiceId(railwayServiceId) {
  await sql`DELETE FROM agent_metadata WHERE railway_service_id = ${railwayServiceId}`;
}

export async function deleteById(id) {
  await sql`DELETE FROM agent_metadata WHERE id = ${id}`;
}
