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
  const repo = process.env.RAILWAY_SOURCE_REPO;
  const branch = process.env.RAILWAY_SOURCE_BRANCH;

  const data = await gql(
    `mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }`,
    {
      input: {
        projectId,
        name,
        source: { repo, branch },
      },
    }
  );

  return data.serviceCreate.id;
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

export async function deleteService(serviceId) {
  await gql(
    `mutation($id: String!) {
      serviceDelete(id: $id)
    }`,
    { id: serviceId }
  );
}
