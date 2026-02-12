import { sql } from "./connection.js";

export async function insertInstance({ id, spriteName, spriteUrl }) {
  await sql`
    INSERT INTO pool_instances (id, sprite_name, sprite_url, status)
    VALUES (${id}, ${spriteName}, ${spriteUrl}, 'provisioning')
  `;
}

export async function markIdle(id, spriteUrl, checkpointId) {
  await sql`
    UPDATE pool_instances
    SET status = 'idle',
        sprite_url = ${spriteUrl},
        checkpoint_id = COALESCE(${checkpointId || null}, checkpoint_id),
        claimed_by = NULL,
        invite_url = NULL,
        conversation_id = NULL,
        instructions = NULL,
        join_url = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function claimOne(agentName) {
  // Atomically grab one idle instance
  const result = await sql`
    UPDATE pool_instances
    SET status = 'claimed',
        claimed_by = ${agentName},
        claimed_at = NOW(),
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM pool_instances
      WHERE status = 'idle'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return result.rows[0] || null;
}

export async function setClaimed(id, { inviteUrl, conversationId, instructions, joinUrl }) {
  await sql`
    UPDATE pool_instances
    SET invite_url = ${inviteUrl},
        conversation_id = ${conversationId},
        instructions = ${instructions || null},
        join_url = ${joinUrl || null},
        updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function listClaimed() {
  const result = await sql`
    SELECT * FROM pool_instances
    WHERE status = 'claimed'
    ORDER BY claimed_at DESC
  `;
  return result.rows;
}

export async function countByStatus() {
  const result = await sql`
    SELECT status, COUNT(*)::int as count
    FROM pool_instances
    GROUP BY status
  `;
  const counts = { provisioning: 0, idle: 0, claimed: 0 };
  for (const row of result.rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

export async function listProvisioning() {
  const result = await sql`
    SELECT * FROM pool_instances
    WHERE status = 'provisioning'
    ORDER BY created_at ASC
  `;
  return result.rows;
}

export async function listAll() {
  const result = await sql`
    SELECT * FROM pool_instances
    ORDER BY created_at DESC
  `;
  return result.rows;
}

export async function findIdle() {
  const result = await sql`
    SELECT * FROM pool_instances
    WHERE status = 'idle'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return result.rows[0] || null;
}

export async function listIdle(limit) {
  const result = await sql`
    SELECT * FROM pool_instances
    WHERE status = 'idle'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return result.rows;
}

export async function deleteInstance(id) {
  await sql`DELETE FROM pool_instances WHERE id = ${id}`;
}
