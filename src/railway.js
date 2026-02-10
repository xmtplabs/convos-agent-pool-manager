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

export async function createService(name) {
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

  // serviceCreate deploys from the repo's default branch regardless of the
  // branch field. Use serviceConnect to explicitly set the build source to
  // the correct branch, so that the redeploy triggered by setVariables
  // (in pool.js) builds from the right branch.
  if (branch) {
    await gql(
      `mutation($id: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $id, input: $input) { id }
      }`,
      { id: serviceId, input: { repo, branch } }
    );
    console.log(`[railway] Connected service to ${repo}@${branch}`);

    // Also create a deployment trigger so future pushes to this branch
    // auto-deploy (serviceConnect only sets the current source).
    try {
      await gql(
        `mutation($input: DeploymentTriggerCreateInput!) {
          deploymentTriggerCreate(input: $input) { id }
        }`,
        {
          input: {
            serviceId,
            projectId,
            environmentId,
            provider: "github",
            repository: repo,
            branch,
          },
        }
      );
      console.log(`[railway] Created deployment trigger: ${repo}@${branch}`);
    } catch (err) {
      console.warn(`[railway] Failed to create deployment trigger for ${serviceId}:`, err);
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
