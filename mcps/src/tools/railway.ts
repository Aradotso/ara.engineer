import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const RAILWAY_BASE = "https://backboard.railway.com/graphql/v2";

async function railwayFetch(query: string, variables: Record<string, unknown> = {}) {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    throw new Error("Railway API token not configured on server");
  }

  const res = await fetch(RAILWAY_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Railway API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Railway GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: any) {
  return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true as const };
}

export function registerRailwayTools(server: McpServer) {

  // ─── Account ───────────────────────────────────────────────────────────────

  server.tool("railway_whoami", "Identify what Railway credential this MCP is using. Detects personal / team / project token types and returns the relevant context.", {}, async () => {
    // Railway has three token kinds with different query access.
    //   personal access token → `me { ... }`
    //   project token         → `projectToken { project { ... } }`
    //   team/workspace token  → neither, but `projects { ... }` works for listing
    // Try them in order, return whatever sticks.
    try {
      return ok({ tokenType: "personal", ...(await railwayFetch(`query { me { id name email } }`)) });
    } catch {}
    try {
      const data = await railwayFetch(`query { projectToken { projectId environmentId } }`);
      return ok({ tokenType: "project", ...data });
    } catch {}
    // Team tokens: can list projects but not introspect self. Prove the token
    // works by counting accessible projects.
    try {
      const data = await railwayFetch(`query { projects(first: 1) { edges { node { id name team { name } } } } }`);
      const first = (data as any)?.projects?.edges?.[0]?.node;
      return ok({ tokenType: "team-or-api", note: "token has no self-introspection query but can read projects", sampleProject: first });
    } catch (e: any) {
      return err(e);
    }
  });

  // ─── Projects ──────────────────────────────────────────────────────────────

  server.tool("railway_list_projects", "List all Railway projects", {}, async () => {
    try {
      return ok(await railwayFetch(`query {
        projects { edges { node { id name description updatedAt services { edges { node { id name } } } environments { edges { node { id name } } } } } }
      }`));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_project", "Get full details of a Railway project including services, environments, volumes", {
    id: z.string().describe("The Railway project ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`query ($id: String!) {
        project(id: $id) {
          id name description isPublic prDeploys updatedAt createdAt
          services { edges { node { id name icon updatedAt } } }
          environments { edges { node { id name isEphemeral } } }
          volumes { edges { node { id name } } }
        }
      }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_create_project", "Create a new Railway project", {
    name: z.string().describe("Project name"),
    description: z.string().optional().describe("Project description"),
    isPublic: z.boolean().optional().describe("Whether project is public"),
    prDeploys: z.boolean().optional().describe("Enable PR deploy environments"),
  }, async (args) => {
    try {
      return ok(await railwayFetch(`mutation ($input: ProjectCreateInput!) {
        projectCreate(input: $input) { id name description }
      }`, { input: args }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_update_project", "Update a Railway project's settings", {
    id: z.string().describe("Project ID"),
    name: z.string().optional().describe("New name"),
    description: z.string().optional().describe("New description"),
    prDeploys: z.boolean().optional().describe("Enable/disable PR deploys"),
  }, async ({ id, ...input }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) { id name description }
      }`, { id, input }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_project", "Delete a Railway project permanently", {
    id: z.string().describe("Project ID to delete"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { projectDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  // ─── Services ──────────────────────────────────────────────────────────────

  server.tool("railway_list_services", "List all services in a Railway project", {
    projectId: z.string().describe("The Railway project ID"),
  }, async ({ projectId }) => {
    try {
      return ok(await railwayFetch(`query ($id: String!) {
        project(id: $id) { services { edges { node { id name icon updatedAt } } } }
      }`, { id: projectId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_service", "Get detailed info about a single Railway service", {
    id: z.string().describe("Service ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`query ($id: String!) {
        service(id: $id) { id name icon projectId createdAt updatedAt }
      }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_service_instance", "Get a service instance's config (build command, start command, replicas, health check, etc.)", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().describe("Environment ID"),
  }, async ({ serviceId, environmentId }) => {
    try {
      return ok(await railwayFetch(`query ($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id serviceName buildCommand startCommand rootDirectory builder
          cronSchedule dockerfilePath healthcheckPath healthcheckTimeout
          numReplicas region sleepApplication
          domains { serviceDomains { id domain } customDomains { id domain } }
        }
      }`, { serviceId, environmentId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_create_service", "Create a new service in a Railway project", {
    projectId: z.string().describe("Project ID"),
    name: z.string().optional().describe("Service name"),
    branch: z.string().optional().describe("Git branch to deploy"),
  }, async (args) => {
    try {
      return ok(await railwayFetch(`mutation ($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id name }
      }`, { input: args }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_update_service", "Rename or change icon of a Railway service", {
    id: z.string().describe("Service ID"),
    name: z.string().optional().describe("New name"),
    icon: z.string().optional().describe("New icon"),
  }, async ({ id, ...input }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!, $input: ServiceUpdateInput!) {
        serviceUpdate(id: $id, input: $input) { id name icon }
      }`, { id, input }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_service", "Delete a Railway service", {
    id: z.string().describe("Service ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { serviceDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_connect_repo", "Connect a GitHub repo to a Railway service", {
    id: z.string().describe("Service ID"),
    repo: z.string().describe("GitHub repo in owner/name format"),
    branch: z.string().optional().describe("Branch to deploy from"),
  }, async ({ id, repo, branch }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $id, input: $input) { id name }
      }`, { id, input: { repo, branch } }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_update_service_instance", "Update service instance config (build command, start command, replicas, health checks, cron, etc.)", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().optional().describe("Environment ID (optional)"),
    buildCommand: z.string().optional().describe("Build command"),
    startCommand: z.string().optional().describe("Start command"),
    rootDirectory: z.string().optional().describe("Root directory"),
    healthcheckPath: z.string().optional().describe("Health check path"),
    healthcheckTimeout: z.number().optional().describe("Health check timeout seconds"),
    numReplicas: z.number().optional().describe("Number of replicas"),
    cronSchedule: z.string().optional().describe("Cron schedule expression"),
    sleepApplication: z.boolean().optional().describe("Enable sleep when idle"),
  }, async ({ serviceId, environmentId, ...input }) => {
    try {
      const vars: Record<string, unknown> = { serviceId, input };
      if (environmentId) vars.environmentId = environmentId;
      return ok(await railwayFetch(`mutation ($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_set_service_limits", "Set CPU and memory limits for a service instance", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().describe("Environment ID"),
    memoryGB: z.number().optional().describe("Memory limit in GB"),
    vCPUs: z.number().optional().describe("vCPU limit"),
  }, async ({ serviceId, environmentId, memoryGB, vCPUs }) => {
    try {
      return ok(await railwayFetch(`mutation ($input: ServiceInstanceLimitsUpdateInput!) {
        serviceInstanceLimitsUpdate(input: $input)
      }`, { input: { serviceId, environmentId, memoryGB, vCPUs } }));
    } catch (e: any) { return err(e); }
  });

  // ─── Deployments ───────────────────────────────────────────────────────────

  server.tool("railway_list_deployments", "List deployments for a service/environment", {
    projectId: z.string().optional().describe("Project ID"),
    serviceId: z.string().optional().describe("Service ID"),
    environmentId: z.string().optional().describe("Environment ID"),
  }, async ({ projectId, serviceId, environmentId }) => {
    try {
      const input: Record<string, unknown> = {};
      if (projectId) input.projectId = projectId;
      if (serviceId) input.serviceId = serviceId;
      if (environmentId) input.environmentId = environmentId;
      return ok(await railwayFetch(`query ($input: DeploymentListInput!) {
        deployments(input: $input) { edges { node {
          id status url staticUrl serviceId environmentId
          meta { repo branch commitHash commitMessage commitAuthor image }
          createdAt updatedAt
        } } }
      }`, { input }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_deployment", "Get details of a specific deployment", {
    id: z.string().describe("Deployment ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`query ($id: String!) {
        deployment(id: $id) {
          id status url staticUrl canRedeploy canRollback
          meta { repo branch commitHash commitMessage commitAuthor image }
          createdAt updatedAt
        }
      }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_redeploy", "Trigger a redeploy of a Railway service in a specific environment", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().describe("Environment ID"),
  }, async ({ serviceId, environmentId }) => {
    try {
      return ok(await railwayFetch(`mutation ($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
      }`, { serviceId, environmentId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_deploy_from_commit", "Deploy a specific git commit to a service", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().describe("Environment ID"),
    commitSha: z.string().optional().describe("Specific commit SHA (omit for latest)"),
  }, async ({ serviceId, environmentId, commitSha }) => {
    try {
      const vars: Record<string, unknown> = { serviceId, environmentId };
      if (commitSha) vars.commitSha = commitSha;
      return ok(await railwayFetch(`mutation ($serviceId: String!, $environmentId: String!, $commitSha: String) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_restart_deployment", "Restart a deployment", {
    id: z.string().describe("Deployment ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { deploymentRestart(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_rollback_deployment", "Rollback to a previous deployment", {
    id: z.string().describe("Deployment ID to rollback to"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { deploymentRollback(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_cancel_deployment", "Cancel a running deployment", {
    id: z.string().describe("Deployment ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { deploymentCancel(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_stop_deployment", "Stop a running deployment", {
    id: z.string().describe("Deployment ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { deploymentStop(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_remove_deployment", "Remove a deployment permanently", {
    id: z.string().describe("Deployment ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { deploymentRemove(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  // ─── Environments ──────────────────────────────────────────────────────────

  server.tool("railway_list_environments", "List all environments for a project", {
    projectId: z.string().describe("Project ID"),
  }, async ({ projectId }) => {
    try {
      return ok(await railwayFetch(`query ($projectId: String!) {
        environments(projectId: $projectId) { edges { node { id name isEphemeral createdAt updatedAt } } }
      }`, { projectId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_create_environment", "Create a new environment (e.g., staging, preview)", {
    projectId: z.string().describe("Project ID"),
    name: z.string().describe("Environment name"),
    sourceEnvironmentId: z.string().optional().describe("Source environment to clone from"),
    ephemeral: z.boolean().optional().describe("Whether this is an ephemeral environment"),
  }, async (args) => {
    try {
      return ok(await railwayFetch(`mutation ($input: EnvironmentCreateInput!) {
        environmentCreate(input: $input) { id name isEphemeral }
      }`, { input: args }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_environment", "Delete an environment", {
    id: z.string().describe("Environment ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { environmentDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_trigger_environment_deploy", "Trigger deploys for all services in an environment", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    serviceId: z.string().describe("Service ID"),
  }, async (args) => {
    try {
      return ok(await railwayFetch(`mutation ($input: EnvironmentTriggersDeployInput!) {
        environmentTriggersDeploy(input: $input)
      }`, { input: args }));
    } catch (e: any) { return err(e); }
  });

  // ─── Variables ─────────────────────────────────────────────────────────────

  server.tool("railway_get_variables", "Get all environment variables for a service (or project-level if no serviceId)", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    serviceId: z.string().optional().describe("Service ID (omit for project-level vars)"),
    unrendered: z.boolean().optional().describe("Return raw template values instead of rendered"),
  }, async ({ projectId, environmentId, serviceId, unrendered }) => {
    try {
      const vars: Record<string, unknown> = { projectId, environmentId };
      if (serviceId) vars.serviceId = serviceId;
      if (unrendered) vars.unrendered = unrendered;
      return ok(await railwayFetch(`query ($projectId: String!, $environmentId: String!, $serviceId: String, $unrendered: Boolean) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: $unrendered)
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_set_variable", "Set a single environment variable", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    name: z.string().describe("Variable name"),
    value: z.string().describe("Variable value"),
    serviceId: z.string().optional().describe("Service ID (omit for project-level)"),
  }, async ({ projectId, environmentId, name, value, serviceId }) => {
    try {
      const input: Record<string, unknown> = { projectId, environmentId, name, value };
      if (serviceId) input.serviceId = serviceId;
      return ok(await railwayFetch(`mutation ($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }`, { input }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_set_variables_bulk", "Set multiple environment variables at once", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    serviceId: z.string().optional().describe("Service ID"),
    variables: z.record(z.string()).describe("Key-value pairs to upsert"),
    replace: z.boolean().optional().describe("If true, replaces ALL variables (deletes ones not in the map)"),
  }, async ({ projectId, environmentId, serviceId, variables, replace }) => {
    try {
      const input: Record<string, unknown> = { projectId, environmentId, variables };
      if (serviceId) input.serviceId = serviceId;
      if (replace) input.replace = replace;
      return ok(await railwayFetch(`mutation ($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }`, { input }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_variable", "Delete a single environment variable", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    name: z.string().describe("Variable name to delete"),
    serviceId: z.string().optional().describe("Service ID"),
  }, async ({ projectId, environmentId, name, serviceId }) => {
    try {
      const input: Record<string, unknown> = { projectId, environmentId, name };
      if (serviceId) input.serviceId = serviceId;
      return ok(await railwayFetch(`mutation ($input: VariableDeleteInput!) {
        variableDelete(input: $input)
      }`, { input }));
    } catch (e: any) { return err(e); }
  });

  // ─── Domains ───────────────────────────────────────────────────────────────

  server.tool("railway_list_domains", "List all domains (service domains + custom domains) for a service", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    serviceId: z.string().describe("Service ID"),
  }, async ({ projectId, environmentId, serviceId }) => {
    try {
      return ok(await railwayFetch(`query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
          serviceDomains { id domain environmentId targetPort }
          customDomains { id domain environmentId targetPort status { dnsRecords { hostlabel type requiredValue currentValue status } } }
        }
      }`, { projectId, environmentId, serviceId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_create_service_domain", "Generate a *.railway.app domain for a service", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().describe("Environment ID"),
    targetPort: z.number().optional().describe("Port to route traffic to"),
  }, async ({ serviceId, environmentId, targetPort }) => {
    try {
      const input: Record<string, unknown> = { serviceId, environmentId };
      if (targetPort) input.targetPort = targetPort;
      return ok(await railwayFetch(`mutation ($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) { id domain }
      }`, { input }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_service_domain", "Remove a *.railway.app domain", {
    id: z.string().describe("Service domain ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { serviceDomainDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_add_custom_domain", "Add a custom domain to a service", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    serviceId: z.string().describe("Service ID"),
    domain: z.string().describe("Custom domain (e.g., api.example.com)"),
    targetPort: z.number().optional().describe("Port to route traffic to"),
  }, async (args) => {
    try {
      return ok(await railwayFetch(`mutation ($input: CustomDomainCreateInput!) {
        customDomainCreate(input: $input) { id domain status { dnsRecords { hostlabel type requiredValue } } }
      }`, { input: args }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_custom_domain", "Remove a custom domain", {
    id: z.string().describe("Custom domain ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { customDomainDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  // ─── Volumes ───────────────────────────────────────────────────────────────

  server.tool("railway_create_volume", "Create a persistent volume for a service", {
    projectId: z.string().describe("Project ID"),
    mountPath: z.string().describe("Mount path inside the container (e.g., /data)"),
    serviceId: z.string().optional().describe("Service ID to attach to"),
    environmentId: z.string().optional().describe("Environment ID"),
  }, async (args) => {
    try {
      return ok(await railwayFetch(`mutation ($input: VolumeCreateInput!) {
        volumeCreate(input: $input) { id name }
      }`, { input: args }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_volume", "Delete a persistent volume", {
    volumeId: z.string().describe("Volume ID"),
  }, async ({ volumeId }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { volumeDelete(volumeId: $id) }`, { id: volumeId }));
    } catch (e: any) { return err(e); }
  });

  // ─── TCP Proxies ───────────────────────────────────────────────────────────

  server.tool("railway_list_tcp_proxies", "List TCP proxies for a service (for databases, etc.)", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().describe("Environment ID"),
  }, async ({ serviceId, environmentId }) => {
    try {
      return ok(await railwayFetch(`query ($serviceId: String!, $environmentId: String!) {
        tcpProxies(serviceId: $serviceId, environmentId: $environmentId) { id domain proxyPort applicationPort createdAt }
      }`, { serviceId, environmentId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_tcp_proxy", "Delete a TCP proxy", {
    id: z.string().describe("TCP proxy ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { tcpProxyDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  // ─── Logs ──────────────────────────────────────────────────────────────────

  server.tool("railway_get_deploy_logs", "Get runtime logs for a deployment", {
    deploymentId: z.string().describe("Deployment ID"),
    limit: z.number().optional().describe("Number of log lines (default 100)"),
    filter: z.string().optional().describe("Filter string to search logs"),
  }, async ({ deploymentId, limit, filter }) => {
    try {
      const vars: Record<string, unknown> = { deploymentId, limit: limit || 100 };
      if (filter) vars.filter = filter;
      return ok(await railwayFetch(`query ($deploymentId: String!, $limit: Int, $filter: String) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) { timestamp message severity }
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_build_logs", "Get build logs for a deployment", {
    deploymentId: z.string().describe("Deployment ID"),
    limit: z.number().optional().describe("Number of log lines (default 100)"),
  }, async ({ deploymentId, limit }) => {
    try {
      return ok(await railwayFetch(`query ($deploymentId: String!, $limit: Int) {
        buildLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
      }`, { deploymentId, limit: limit || 100 }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_environment_logs", "Get logs for an entire environment (all services)", {
    environmentId: z.string().describe("Environment ID"),
    filter: z.string().optional().describe("Filter string"),
    beforeLimit: z.number().optional().describe("Number of lines before anchor"),
    afterLimit: z.number().optional().describe("Number of lines after anchor"),
  }, async ({ environmentId, filter, beforeLimit, afterLimit }) => {
    try {
      const vars: Record<string, unknown> = { environmentId };
      if (filter) vars.filter = filter;
      if (beforeLimit) vars.beforeLimit = beforeLimit;
      if (afterLimit) vars.afterLimit = afterLimit;
      return ok(await railwayFetch(`query ($environmentId: String!, $filter: String, $beforeLimit: Int, $afterLimit: Int) {
        environmentLogs(environmentId: $environmentId, filter: $filter, beforeLimit: $beforeLimit, afterLimit: $afterLimit) { timestamp message severity }
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_http_logs", "Get HTTP request logs for a deployment", {
    deploymentId: z.string().describe("Deployment ID"),
    limit: z.number().optional().describe("Number of log entries"),
  }, async ({ deploymentId, limit }) => {
    try {
      const vars: Record<string, unknown> = { deploymentId };
      if (limit) vars.limit = limit;
      return ok(await railwayFetch(`query ($deploymentId: String!, $limit: Int) {
        httpLogs(deploymentId: $deploymentId, limit: $limit) {
          timestamp method path statusCode requestId responseDetails { totalDuration }
        }
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  // ─── Metrics & Usage ───────────────────────────────────────────────────────

  server.tool("railway_get_metrics", "Get CPU, memory, network, and disk metrics for a service", {
    projectId: z.string().describe("Project ID"),
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().optional().describe("Environment ID"),
    startDate: z.string().describe("Start date (ISO 8601)"),
    endDate: z.string().optional().describe("End date (ISO 8601, defaults to now)"),
    measurements: z.array(z.enum([
      "CPU_USAGE", "MEMORY_USAGE_GB", "NETWORK_RX_GB", "NETWORK_TX_GB", "DISK_USAGE_GB",
    ])).optional().describe("Which metrics to fetch (defaults to CPU + memory)"),
  }, async ({ projectId, serviceId, environmentId, startDate, endDate, measurements }) => {
    try {
      const vars: Record<string, unknown> = {
        measurements: measurements || ["CPU_USAGE", "MEMORY_USAGE_GB"],
        startDate,
        projectId,
        serviceId,
      };
      if (endDate) vars.endDate = endDate;
      if (environmentId) vars.environmentId = environmentId;
      return ok(await railwayFetch(`query ($measurements: [MetricMeasurement!]!, $startDate: DateTime!, $endDate: DateTime, $projectId: String, $serviceId: String, $environmentId: String) {
        metrics(measurements: $measurements, startDate: $startDate, endDate: $endDate, projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId) {
          measurement ts value tags { projectId serviceId environmentId deploymentId }
        }
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_get_usage", "Get billing usage data for a project or workspace", {
    projectId: z.string().optional().describe("Project ID"),
    measurements: z.array(z.enum([
      "CPU_USAGE", "MEMORY_USAGE_GB", "NETWORK_RX_GB", "NETWORK_TX_GB", "DISK_USAGE_GB",
    ])).optional().describe("Which usage metrics"),
    startDate: z.string().optional().describe("Start date (ISO 8601)"),
    endDate: z.string().optional().describe("End date (ISO 8601)"),
  }, async ({ projectId, measurements, startDate, endDate }) => {
    try {
      const vars: Record<string, unknown> = {
        measurements: measurements || ["CPU_USAGE", "MEMORY_USAGE_GB", "NETWORK_TX_GB"],
      };
      if (projectId) vars.projectId = projectId;
      if (startDate) vars.startDate = startDate;
      if (endDate) vars.endDate = endDate;
      return ok(await railwayFetch(`query ($measurements: [MetricMeasurement!]!, $projectId: String, $startDate: DateTime, $endDate: DateTime) {
        usage(measurements: $measurements, projectId: $projectId, startDate: $startDate, endDate: $endDate) {
          measurement value tags { projectId serviceId environmentId }
        }
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  // ─── Networking ────────────────────────────────────────────────────────────

  server.tool("railway_list_private_networks", "List private networks in an environment", {
    environmentId: z.string().describe("Environment ID"),
  }, async ({ environmentId }) => {
    try {
      return ok(await railwayFetch(`query ($environmentId: String!) {
        privateNetworks(environmentId: $environmentId) { id name createdAt }
      }`, { environmentId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_list_egress_gateways", "List static egress (outbound) IPs for a service", {
    serviceId: z.string().describe("Service ID"),
    environmentId: z.string().describe("Environment ID"),
  }, async ({ serviceId, environmentId }) => {
    try {
      return ok(await railwayFetch(`query ($serviceId: String!, $environmentId: String!) {
        egressGateways(serviceId: $serviceId, environmentId: $environmentId) { ipv4 region status }
      }`, { serviceId, environmentId }));
    } catch (e: any) { return err(e); }
  });

  // ─── Deployment Triggers ───────────────────────────────────────────────────

  server.tool("railway_list_deploy_triggers", "List deployment triggers (auto-deploy configs) for a service", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    serviceId: z.string().describe("Service ID"),
  }, async ({ projectId, environmentId, serviceId }) => {
    try {
      return ok(await railwayFetch(`query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        deploymentTriggers(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
          edges { node { id provider repository branch checkSuites rootDirectory } }
        }
      }`, { projectId, environmentId, serviceId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_create_deploy_trigger", "Create an auto-deploy trigger (connect GitHub repo to auto-deploy on push)", {
    projectId: z.string().describe("Project ID"),
    environmentId: z.string().describe("Environment ID"),
    serviceId: z.string().describe("Service ID"),
    repository: z.string().describe("GitHub repo (owner/name)"),
    branch: z.string().describe("Branch to watch"),
    provider: z.string().optional().describe("Provider (default: github)"),
    rootDirectory: z.string().optional().describe("Root directory for builds"),
    checkSuites: z.boolean().optional().describe("Wait for CI check suites before deploying"),
  }, async ({ provider, ...rest }) => {
    try {
      return ok(await railwayFetch(`mutation ($input: DeploymentTriggerCreateInput!) {
        deploymentTriggerCreate(input: $input) { id repository branch }
      }`, { input: { provider: provider || "github", ...rest } }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_deploy_trigger", "Delete a deployment trigger", {
    id: z.string().describe("Trigger ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { deploymentTriggerDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });

  // ─── GitHub ────────────────────────────────────────────────────────────────

  server.tool("railway_list_github_repos", "List GitHub repos available to Railway", {}, async () => {
    try {
      return ok(await railwayFetch(`query { githubRepos { fullName defaultBranch isPrivate installationId } }`));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_deploy_github_repo", "Deploy a GitHub repo to a Railway project", {
    projectId: z.string().describe("Project ID"),
    repo: z.string().describe("GitHub repo (owner/name)"),
    branch: z.string().optional().describe("Branch"),
    environmentId: z.string().optional().describe("Environment ID"),
  }, async (args) => {
    try {
      return ok(await railwayFetch(`mutation ($input: GitHubRepoDeployInput!) {
        githubRepoDeploy(input: $input)
      }`, { input: args }));
    } catch (e: any) { return err(e); }
  });

  // ─── Templates ─────────────────────────────────────────────────────────────

  server.tool("railway_deploy_template", "Deploy a Railway template to create a new project", {
    templateCode: z.string().describe("Template code or ID"),
    projectId: z.string().optional().describe("Existing project ID (creates new if omitted)"),
    environmentId: z.string().optional().describe("Environment ID"),
    services: z.array(z.object({
      id: z.string().describe("Template service ID"),
      variables: z.record(z.string()).optional().describe("Variables for this service"),
    })).optional().describe("Service configs"),
  }, async ({ templateCode, projectId, environmentId, services }) => {
    try {
      const input: Record<string, unknown> = { templateCode };
      if (projectId) input.projectId = projectId;
      if (environmentId) input.environmentId = environmentId;
      if (services) input.services = services;
      return ok(await railwayFetch(`mutation ($input: TemplateDeployV2Input!) {
        templateDeployV2(input: $input) { projectId workflowId }
      }`, { input }));
    } catch (e: any) { return err(e); }
  });

  // ─── Regions ───────────────────────────────────────────────────────────────

  server.tool("railway_list_regions", "List available Railway regions", {
    projectId: z.string().optional().describe("Project ID (shows regions available to the project)"),
  }, async ({ projectId }) => {
    try {
      const vars: Record<string, unknown> = {};
      if (projectId) vars.projectId = projectId;
      return ok(await railwayFetch(`query ($projectId: String) {
        regions(projectId: $projectId) { id name }
      }`, vars));
    } catch (e: any) { return err(e); }
  });

  // ─── Webhooks / Notifications ──────────────────────────────────────────────

  server.tool("railway_test_webhook", "Send a test payload to a webhook URL", {
    url: z.string().describe("Webhook URL to test"),
    payload: z.string().optional().describe("JSON payload string (defaults to a test event)"),
  }, async ({ url, payload }) => {
    try {
      return ok(await railwayFetch(`mutation ($url: String!, $payload: String!) {
        webhookTest(url: $url, payload: $payload)
      }`, { url, payload: payload || JSON.stringify({ event: "test", timestamp: new Date().toISOString() }) }));
    } catch (e: any) { return err(e); }
  });

  // ─── Platform Status ───────────────────────────────────────────────────────

  server.tool("railway_platform_status", "Check Railway platform status and stats", {}, async () => {
    try {
      return ok(await railwayFetch(`query { platformStatus { isStable } publicStats { totalProjects totalDeploys totalUsers } }`));
    } catch (e: any) { return err(e); }
  });

  // ─── Integrations ─────────────────────────────────────────────────────────

  server.tool("railway_list_integrations", "List integrations (like Datadog, etc.) for a project", {
    projectId: z.string().describe("Project ID"),
  }, async ({ projectId }) => {
    try {
      return ok(await railwayFetch(`query ($projectId: String!) {
        integrations(projectId: $projectId) { edges { node { id name config projectId } } }
      }`, { projectId }));
    } catch (e: any) { return err(e); }
  });

  server.tool("railway_delete_integration", "Delete an integration from a project", {
    id: z.string().describe("Integration ID"),
  }, async ({ id }) => {
    try {
      return ok(await railwayFetch(`mutation ($id: String!) { integrationDelete(id: $id) }`, { id }));
    } catch (e: any) { return err(e); }
  });
}
