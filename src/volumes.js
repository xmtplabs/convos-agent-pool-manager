/**
 * Volume lifecycle: create with retry, query by service, cleanup after delete.
 *
 * Depends on railway.js for low-level GraphQL (createVolume, gql).
 * To disable volume management, comment out the import in pool.js.
 */

import * as railway from "./railway.js";
import { gql } from "./railway.js";

// --- Create / Retry ---

/** Try to create a volume for a service. Returns true on success. */
export async function ensureVolume(serviceId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const vol = await railway.createVolume(serviceId, "/data");
      console.log(`[volumes] Created: ${vol.id}`);
      return true;
    } catch (err) {
      console.warn(`[volumes] Attempt ${attempt}/3 failed for ${serviceId}:`, err.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

// --- Query ---

/** Returns a Set of serviceIds that have volumes attached. */
export async function getServiceIdsWithVolumes() {
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
    const ids = new Set();
    for (const edge of data.project?.volumes?.edges || []) {
      for (const vi of edge.node?.volumeInstances?.edges || []) {
        if (vi.node?.serviceId) ids.add(vi.node.serviceId);
      }
    }
    return ids;
  } catch (err) {
    console.warn(`[volumes] getServiceIdsWithVolumes failed: ${err.message}`);
    return null;
  }
}

// --- Cleanup ---

/** Collect volume IDs attached to a service (call before deleting the service). */
export async function getVolumeIdsForService(serviceId) {
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
    const ids = [];
    for (const edge of data.project?.volumes?.edges || []) {
      const vol = edge.node;
      const attached = vol.volumeInstances?.edges?.some(
        (vi) => vi.node?.serviceId === serviceId
      );
      if (attached) ids.push(vol.id);
    }
    return ids;
  } catch (err) {
    console.warn(`[volumes] getVolumeIdsForService(${serviceId}) failed: ${err.message}`);
    return [];
  }
}

/** Delete orphaned volumes by ID (call after service is deleted). */
export async function deleteVolumes(volumeIds, serviceId) {
  for (const volumeId of volumeIds) {
    try {
      await gql(`mutation($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId });
      console.log(`[volumes] Deleted ${volumeId} (was attached to ${serviceId})`);
    } catch (err) {
      console.warn(`[volumes] Failed to delete ${volumeId}: ${err.message}`);
    }
  }
}
