import { setResourceLimits } from "./resources.js";
import { getVolumeIdsForService, deleteVolumes } from "./volumes.js";

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

export async function gql(query, variables = {}) {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error("RAILWAY_API_TOKEN not set");

  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Railway API returned non-JSON (${res.status}): ${text.slice(0, 120)}`);
  }
  if (json.errors) {
    throw new Error(`Railway API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

export async function createService(name, variables = {}) {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!environmentId) throw new Error("RAILWAY_ENVIRONMENT_ID not set");
  const repo = process.env.RAILWAY_SOURCE_REPO;
  const branch = process.env.RAILWAY_SOURCE_BRANCH;

  const input = {
    projectId,
    environmentId,
    name,
    source: { repo },
    variables,
  };
  if (branch) input.branch = branch;

  console.log(`[railway] createService: ${name}, branch=${branch || "(default)"}, env=${environmentId}`);

  const data = await gql(
    `mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }`,
    { input }
  );

  const serviceId = data.serviceCreate.id;

  // Step 1: Disconnect repo immediately so config changes don't trigger deploys.
  try {
    await gql(
      `mutation($id: String!) { serviceDisconnect(id: $id) { id } }`,
      { id: serviceId }
    );
    console.log(`[railway]   Disconnected repo (auto-deploys disabled)`);
  } catch (err) {
    console.warn(`[railway] Failed to disconnect repo for ${serviceId}:`, err);
  }

  // Step 2: Cancel ALL in-progress deployments (serviceCreate may have triggered one).
  try {
    const depData = await gql(
      `query($id: String!) {
        service(id: $id) {
          deployments(first: 5) { edges { node { id status } } }
        }
      }`,
      { id: serviceId }
    );
    const deployments = depData.service?.deployments?.edges || [];
    for (const { node } of deployments) {
      try {
        await gql(
          `mutation($id: String!) { deploymentCancel(id: $id) }`,
          { id: node.id }
        );
        console.log(`[railway]   Cancelled deployment ${node.id} (status: ${node.status})`);
      } catch (cancelErr) {
        console.warn(`[railway]   Failed to cancel deployment ${node.id}:`, cancelErr);
      }
    }
  } catch (err) {
    console.warn(`[railway] Failed to query/cancel deployments for ${serviceId}:`, err);
  }

  // Step 3: Set startCommand (safe — repo disconnected, no auto-deploy).
  try {
    await updateServiceInstance(serviceId, { startCommand: "node cli/pool-server.js" });
    console.log(`[railway]   Set startCommand: node cli/pool-server.js`);
  } catch (err) {
    console.warn(`[railway] Failed to set startCommand for ${serviceId}:`, err);
  }

  // Step 4: Set rootDirectory for monorepo support (safe — repo disconnected).
  const rootDir = process.env.RAILWAY_SOURCE_ROOT_DIR;
  if (rootDir) {
    try {
      await updateServiceInstance(serviceId, { rootDirectory: rootDir });
      console.log(`[railway]   Set rootDirectory: ${rootDir}`);
    } catch (err) {
      console.warn(`[railway] Failed to set rootDirectory for ${serviceId}:`, err);
    }
  }

  // Step 5: Set resource limits (safe — repo disconnected).
  await setResourceLimits(serviceId);

  // Step 6: Deploy the latest commit from the correct branch — single controlled deploy.
  const deployRef = branch || "HEAD";
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/commits/${deployRef}`, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
    const { sha } = await ghRes.json();

    await gql(
      `mutation($serviceId: String!, $environmentId: String!, $commitSha: String!) {
        serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
      }`,
      { serviceId, environmentId, commitSha: sha }
    );
    console.log(`[railway] Deployed ${repo}@${deployRef} (${sha.slice(0, 8)}) to ${serviceId}`);
  } catch (err) {
    console.warn(`[railway] Failed to deploy correct branch for ${serviceId}:`, err);
  }

  return serviceId;
}

export async function setVariables(serviceId, variables) {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  await gql(
    `mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
    {
      input: {
        projectId,
        environmentId,
        serviceId,
        variables,
      },
    }
  );
}

export async function createDomain(serviceId) {
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  const data = await gql(
    `mutation($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) { domain }
    }`,
    {
      input: { serviceId, environmentId },
    }
  );

  return data.serviceDomainCreate.domain;
}

export async function renameService(serviceId, name) {
  await gql(
    `mutation($id: String!, $input: ServiceUpdateInput!) {
      serviceUpdate(id: $id, input: $input) { id }
    }`,
    { id: serviceId, input: { name } }
  );
}

export async function updateServiceInstance(serviceId, settings = {}) {
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  await gql(
    `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
    { serviceId, environmentId, input: settings }
  );
}

export async function createVolume(serviceId, mountPath = "/data") {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  const data = await gql(
    `mutation($input: VolumeCreateInput!) {
      volumeCreate(input: $input) { id name }
    }`,
    {
      input: { projectId, serviceId, mountPath, environmentId },
    }
  );

  return data.volumeCreate;
}

export async function deleteService(serviceId) {
  // Collect volume IDs before deleting (volumes.js)
  const volumeIds = await getVolumeIdsForService(serviceId);

  await gql(
    `mutation($id: String!) {
      serviceDelete(id: $id)
    }`,
    { id: serviceId }
  );

  // Clean up orphaned volumes (volumes.js)
  await deleteVolumes(volumeIds, serviceId);
}

// List all services in the project with environment info and deploy status.
// Returns [{ id, name, createdAt, environmentIds, deployStatus }] or null on API error.
export async function listProjectServices() {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  try {
    const data = await gql(
      `query($id: String!) {
        project(id: $id) {
          services(first: 500) {
            edges {
              node {
                id
                name
                createdAt
                serviceInstances { edges { node { environmentId } } }
                deployments(first: 1) {
                  edges { node { id status } }
                }
              }
            }
          }
        }
      }`,
      { id: projectId }
    );
    const edges = data.project?.services?.edges;
    if (!edges) return null;
    return edges.map((e) => ({
      id: e.node.id,
      name: e.node.name,
      createdAt: e.node.createdAt,
      environmentIds: (e.node.serviceInstances?.edges || []).map((si) => si.node.environmentId),
      deployStatus: e.node.deployments?.edges?.[0]?.node?.status || null,
    }));
  } catch (err) {
    console.warn(`[railway] listProjectServices failed: ${err.message}`);
    return null;
  }
}

// Get the public domain for a service. Returns domain string or null.
export async function getServiceDomain(serviceId) {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  try {
    const data = await gql(
      `query($serviceId: String!, $environmentId: String!, $projectId: String!) {
        domains(serviceId: $serviceId, environmentId: $environmentId, projectId: $projectId) {
          serviceDomains { domain }
          customDomains { domain }
        }
      }`,
      { serviceId, environmentId, projectId }
    );
    const sd = data.domains;
    return sd?.customDomains?.[0]?.domain || sd?.serviceDomains?.[0]?.domain || null;
  } catch (err) {
    console.warn(`[railway] getServiceDomain(${serviceId}) failed: ${err.message}`);
    return null;
  }
}

// Check if a service still exists on Railway. Returns { id, name } or null.
export async function getServiceInfo(serviceId) {
  try {
    const data = await gql(
      `query($id: String!) {
        service(id: $id) { id name }
      }`,
      { id: serviceId }
    );
    return data.service || null;
  } catch {
    return null;
  }
}
