import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BT_BASE = "https://api.braintrust.dev/v1";

async function btFetch(path: string, options: RequestInit = {}) {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  if (!apiKey) {
    throw new Error("Braintrust API key not configured on server (BRAINTRUST_API_KEY)");
  }

  const res = await fetch(`${BT_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Braintrust API error ${res.status}: ${body}`);
  }
  return res.json();
}

function ok(data: any) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

export function registerBraintrustTools(server: McpServer) {
  // ── Projects ──
  server.tool(
    "braintrust_list_projects",
    "List Braintrust projects in the current organization",
    {
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)"),
    },
    async ({ limit }) => {
      try {
        const qs = new URLSearchParams();
        if (limit) qs.set("limit", String(limit));
        const data = await btFetch(`/project${qs.toString() ? `?${qs}` : ""}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "braintrust_get_project",
    "Get a Braintrust project by ID",
    { project_id: z.string().describe("The project ID") },
    async ({ project_id }) => {
      try {
        const data = await btFetch(`/project/${project_id}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  // ── Experiments ──
  server.tool(
    "braintrust_list_experiments",
    "List experiments (evaluation runs) for a project",
    {
      project_id: z.string().describe("The project ID"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ project_id, limit }) => {
      try {
        const qs = new URLSearchParams({ project_id });
        if (limit) qs.set("limit", String(limit));
        const data = await btFetch(`/experiment?${qs}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "braintrust_get_experiment",
    "Get a Braintrust experiment by ID",
    { experiment_id: z.string().describe("The experiment ID") },
    async ({ experiment_id }) => {
      try {
        const data = await btFetch(`/experiment/${experiment_id}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "braintrust_fetch_experiment_events",
    "Fetch the events (rows) of an experiment — inputs, outputs, scores, metadata",
    {
      experiment_id: z.string().describe("The experiment ID"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max events (default 100)"),
    },
    async ({ experiment_id, limit }) => {
      try {
        const data = await btFetch(`/experiment/${experiment_id}/fetch`, {
          method: "POST",
          body: JSON.stringify({ limit: limit ?? 100 }),
        });
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  // ── Logs / traces ──
  server.tool(
    "braintrust_fetch_project_logs",
    "Fetch recent log/trace events for a project — use this to inspect production traces",
    {
      project_id: z.string().describe("The project ID"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max events (default 100)"),
    },
    async ({ project_id, limit }) => {
      try {
        const data = await btFetch(`/project_logs/${project_id}/fetch`, {
          method: "POST",
          body: JSON.stringify({ limit: limit ?? 100 }),
        });
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  // ── Datasets ──
  server.tool(
    "braintrust_list_datasets",
    "List datasets in a project",
    {
      project_id: z.string().describe("The project ID"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ project_id, limit }) => {
      try {
        const qs = new URLSearchParams({ project_id });
        if (limit) qs.set("limit", String(limit));
        const data = await btFetch(`/dataset?${qs}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "braintrust_fetch_dataset_rows",
    "Fetch rows from a Braintrust dataset",
    {
      dataset_id: z.string().describe("The dataset ID"),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ dataset_id, limit }) => {
      try {
        const data = await btFetch(`/dataset/${dataset_id}/fetch`, {
          method: "POST",
          body: JSON.stringify({ limit: limit ?? 100 }),
        });
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  // ── Prompts (Braintrust has a prompt library) ──
  server.tool(
    "braintrust_list_prompts",
    "List prompts in a project",
    {
      project_id: z.string().describe("The project ID"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ project_id, limit }) => {
      try {
        const qs = new URLSearchParams({ project_id });
        if (limit) qs.set("limit", String(limit));
        const data = await btFetch(`/prompt?${qs}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "braintrust_get_prompt",
    "Get a Braintrust prompt by ID (full prompt text, tools, variables)",
    { prompt_id: z.string().describe("The prompt ID") },
    async ({ prompt_id }) => {
      try {
        const data = await btFetch(`/prompt/${prompt_id}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );
}
