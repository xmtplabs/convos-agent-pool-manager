// In-memory cache of instance state, rebuilt every tick.
// All API endpoints read from this instead of the DB.

/** @type {Map<string, {serviceId: string, status: string, name: string, url: string, createdAt: string, deployStatus: string|null, inviteUrl?: string, conversationId?: string}>} */
const instances = new Map();

/** @type {Set<string>} */
const claiming = new Set();

export function set(serviceId, data) {
  instances.set(serviceId, data);
}

export function get(serviceId) {
  return instances.get(serviceId) || null;
}

export function remove(serviceId) {
  instances.delete(serviceId);
}

export function getAll() {
  return [...instances.values()];
}

export function getByStatus(status) {
  return getAll().filter((i) => i.status === status);
}

export function getCounts() {
  const counts = { starting: 0, idle: 0, claimed: 0, crashed: 0 };
  for (const inst of instances.values()) {
    if (counts[inst.status] !== undefined) counts[inst.status]++;
  }
  return counts;
}

// Find the first idle instance not currently being claimed.
export function findClaimable() {
  for (const inst of instances.values()) {
    if (inst.status === "idle" && !claiming.has(inst.serviceId)) {
      return inst;
    }
  }
  return null;
}

export function startClaim(serviceId) {
  claiming.add(serviceId);
}

export function endClaim(serviceId) {
  claiming.delete(serviceId);
}

export function isBeingClaimed(serviceId) {
  return claiming.has(serviceId);
}
