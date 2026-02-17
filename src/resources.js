/**
 * Resource limits: cap vCPU and memory per service instance.
 *
 * Uses environmentPatchCommit to set deploy limits.
 * To disable resource limits, comment out the call in railway.js createService.
 */

import { gql } from "./railway.js";

/** Set CPU and memory limits on a Railway service. */
export async function setResourceLimits(serviceId, { cpu = 4, memoryGB = 8 } = {}) {
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  try {
    await gql(
      `mutation($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String) {
        environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage)
      }`,
      {
        environmentId,
        patch: {
          services: {
            [serviceId]: {
              deploy: {
                limitOverride: {
                  containers: {
                    cpu,
                    memoryBytes: memoryGB * 1024 * 1024 * 1024,
                  },
                },
              },
            },
          },
        },
        commitMessage: `Set resource limits: ${cpu} vCPU, ${memoryGB} GB RAM`,
      }
    );
    console.log(`[resources] Set limits: ${cpu} vCPU, ${memoryGB} GB RAM`);
  } catch (err) {
    console.warn(`[resources] Failed to set limits for ${serviceId}: ${err.message}`);
  }
}
