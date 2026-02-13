// Resolve a GHCR image tag to its pinned digest.
// Uses anonymous token auth (the openclaw image is public).

const GHCR_REGISTRY = "https://ghcr.io";

async function getAnonymousToken(repo) {
  const res = await fetch(
    `${GHCR_REGISTRY}/token?scope=repository:${repo}:pull&service=ghcr.io`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) throw new Error(`GHCR token request failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

/**
 * Resolve an image tag to a digest.
 * @param {string} repo - e.g. "xmtplabs/openclaw"
 * @param {string} tag - e.g. "staging" or "main"
 * @returns {Promise<string>} digest like "sha256:abc123..."
 */
export async function resolveDigest(repo, tag) {
  const token = await getAnonymousToken(repo);
  const res = await fetch(
    `${GHCR_REGISTRY}/v2/${repo}/manifests/${tag}`,
    {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.docker.distribution.manifest.list.v2+json",
      },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) throw new Error(`GHCR manifest lookup failed: ${res.status}`);
  const digest = res.headers.get("docker-content-digest");
  if (!digest) throw new Error("No docker-content-digest header in response");
  return digest;
}

/**
 * Resolve a full pinned image reference.
 * @param {string} tag - e.g. "staging"
 * @returns {Promise<string>} e.g. "ghcr.io/xmtplabs/openclaw@sha256:abc..."
 */
export async function resolveOpenclawImage(tag) {
  const repo = "xmtplabs/openclaw";
  const digest = await resolveDigest(repo, tag);
  const pinned = `ghcr.io/${repo}@${digest}`;
  console.log(`[ghcr] Resolved openclaw:${tag} → ${digest.slice(0, 19)}...`);
  return pinned;
}
