const STUCK_TIMEOUT_MS = parseInt(process.env.POOL_STUCK_TIMEOUT_MS || String(15 * 60 * 1000), 10);

const STARTING_STATUSES = new Set(["QUEUED", "WAITING", "BUILDING", "DEPLOYING"]);
const DEAD_STATUSES = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

// Derive pool status from Railway deploy status + health check result.
// healthCheck is the parsed JSON from /convos/status, or null if unreachable.
export function deriveStatus({ deployStatus, healthCheck = null, createdAt = null }) {
  if (deployStatus === "SLEEPING") return "sleeping";
  if (DEAD_STATUSES.has(deployStatus)) return "dead";
  if (STARTING_STATUSES.has(deployStatus)) return "starting";

  if (deployStatus === "SUCCESS") {
    if (healthCheck) {
      return healthCheck.conversation ? "claimed" : "idle";
    }
    // Unreachable — check age
    const age = createdAt ? Date.now() - new Date(createdAt).getTime() : Infinity;
    return age < STUCK_TIMEOUT_MS ? "starting" : "dead";
  }

  // Unknown or null deploy status — treat as starting if young
  const age = createdAt ? Date.now() - new Date(createdAt).getTime() : Infinity;
  return age < STUCK_TIMEOUT_MS ? "starting" : "dead";
}
