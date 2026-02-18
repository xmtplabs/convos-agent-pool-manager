/**
 * Volume lifecycle: create with retry, query, and cleanup.
 *
 * Depends on railway.js for low-level GraphQL (createVolume, gql).
 */

import { createVolume, gql } from "./railway.js";

/** Try to create a volume for a service. Returns true on success. */
export async function ensureVolume(serviceId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const vol = await createVolume(serviceId, "/data");
      console.log(`[volumes] Created: ${vol.id}`);
      return true;
    } catch (err) {
      console.warn(`[volumes] Attempt ${attempt}/3 failed for ${serviceId}:`, err.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

/** Fetch all project volumes grouped by serviceId.
 *  Returns Map<serviceId, volumeId[]> or null on failure. */
export async function fetchAllVolumesByService() {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  try {
    const data = await gql(
      `query($id: String!) {
        project(id: $id) {
          volumes {
            edges {
              node {
                id
                volumeInstances { edges { node { serviceId } } }
              }
            }
          }
        }
      }`,
      { id: projectId }
    );
    const map = new Map();
    for (const edge of data.project?.volumes?.edges || []) {
      const vol = edge.node;
      for (const vi of vol.volumeInstances?.edges || []) {
        const sid = vi.node?.serviceId;
        if (sid) {
          if (!map.has(sid)) map.set(sid, []);
          map.get(sid).push(vol.id);
        }
      }
    }
    return map;
  } catch (err) {
    console.warn(`[volumes] fetchAllVolumesByService failed: ${err.message}`);
    return null;
  }
}

/** Delete ALL volumes in the project (one-time orphan cleanup at startup). */
export async function deleteAllProjectVolumes() {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  try {
    const data = await gql(
      `query($id: String!) {
        project(id: $id) {
          volumes { edges { node { id } } }
        }
      }`,
      { id: projectId }
    );
    const edges = data.project?.volumes?.edges || [];
    if (edges.length === 0) {
      console.log(`[volumes] No orphan volumes found`);
      return;
    }
    console.log(`[volumes] Deleting ${edges.length} orphan volume(s)...`);
    for (const edge of edges) {
      await deleteVolume(edge.node.id, "(orphan)");
    }
  } catch (err) {
    console.warn(`[volumes] deleteAllProjectVolumes failed: ${err.message}`);
  }
}

/** Delete a single volume by ID. Best-effort. */
export async function deleteVolume(volumeId, serviceId) {
  try {
    await gql(`mutation($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId });
    console.log(`[volumes] Deleted ${volumeId} (was attached to ${serviceId})`);
  } catch (err) {
    console.warn(`[volumes] Failed to delete ${volumeId}: ${err.message}`);
  }
}
