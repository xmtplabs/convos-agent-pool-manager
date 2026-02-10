const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

async function gql(query, variables = {}) {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error("RAILWAY_API_TOKEN not set");

  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Project-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
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

  // serviceCreate always deploys from the repo's default branch (main)
  // regardless of the branch field. To build from the correct branch:
  // 1. Cancel the initial main deployment that serviceCreate auto-triggered
  // 2. Fetch the latest commit SHA from the target branch via GitHub API
  // 3. Deploy that specific commit via serviceInstanceDeploy
  //
  // Variables are passed inline to serviceCreate above so that
  // setVariables doesn't trigger another main deployment.
  if (branch) {
    // Cancel the initial main deployment.
    try {
      const depData = await gql(
        `query($id: String!) {
          service(id: $id) {
            deployments(first: 1) { edges { node { id } } }
          }
        }`,
        { id: serviceId }
      );
      const initialDeploy = depData.service?.deployments?.edges?.[0]?.node;
      if (initialDeploy) {
        await gql(
          `mutation($id: String!) { deploymentCancel(id: $id) }`,
          { id: initialDeploy.id }
        );
        console.log(`[railway] Cancelled initial main deployment ${initialDeploy.id}`);
      }
    } catch (err) {
      console.warn(`[railway] Failed to cancel initial deployment for ${serviceId}:`, err);
    }

    // Deploy the latest commit from the correct branch.
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, {
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
      console.log(`[railway] Deployed ${repo}@${branch} (${sha.slice(0, 8)}) to ${serviceId}`);
    } catch (err) {
      console.warn(`[railway] Failed to deploy correct branch for ${serviceId}:`, err);
    }
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

export async function deleteService(serviceId) {
  await gql(
    `mutation($id: String!) {
      serviceDelete(id: $id)
    }`,
    { id: serviceId }
  );
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
