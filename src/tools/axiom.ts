import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const AXIOM_BASE = "https://api.axiom.co/v1";

async function axiomFetch(path: string, options: RequestInit = {}) {
  const apiKey = process.env.AXIOM_API_TOKEN;
  if (!apiKey) {
    throw new Error("Axiom API token not configured on server (AXIOM_API_TOKEN)");
  }

  const res = await fetch(`${AXIOM_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Axiom API error ${res.status}: ${body}`);
  }
  return res.json();
}

function ok(data: any) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// Ara's default dataset — the api/web/app services all log here
const DEFAULT_DATASET = process.env.AXIOM_DEFAULT_DATASET ?? "logs";

export function registerAxiomTools(server: McpServer) {
  server.tool(
    "axiom_list_datasets",
    "List Axiom datasets available in the organization",
    {},
    async () => {
      try {
        const data = await axiomFetch("/datasets");
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "axiom_query",
    "Run an APL (Axiom Processing Language) query. For Ara, the primary dataset is 'logs' — filter by service (api|web|app), environment, user_id, or runtime_session_id.",
    {
      apl: z.string().describe(
        "APL query string. Example: [\"logs\"] | where service == 'api' and severity == 'error' | take 50. Always quote dataset names with brackets + quotes."
      ),
      start_time: z.string().optional().describe("ISO 8601 start time (default: 1h ago)"),
      end_time: z.string().optional().describe("ISO 8601 end time (default: now)"),
    },
    async ({ apl, start_time, end_time }) => {
      try {
        const body: Record<string, unknown> = { apl };
        if (start_time) body.startTime = start_time;
        if (end_time) body.endTime = end_time;
        const data = await axiomFetch("/datasets/_apl?format=tabular", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "axiom_tail_logs",
    "Quick tail of the Ara 'logs' dataset — last N events, optionally filtered by service and severity. Prefer this over axiom_query for ad-hoc debugging.",
    {
      service: z.enum(["api", "web", "app"]).optional().describe("Filter by Ara service"),
      severity: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
      user_id: z.string().optional().describe("Filter by user_id property"),
      runtime_session_id: z.string().optional().describe("Filter by runtime_session_id property"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max events (default 50)"),
      since_minutes: z.number().int().min(1).max(1440).optional().describe("Lookback window in minutes (default 15)"),
    },
    async ({ service, severity, user_id, runtime_session_id, limit, since_minutes }) => {
      try {
        const filters: string[] = [];
        if (service) filters.push(`service == '${service}'`);
        if (severity) filters.push(`severity == '${severity}'`);
        if (user_id) filters.push(`user_id == '${user_id}'`);
        if (runtime_session_id) filters.push(`runtime_session_id == '${runtime_session_id}'`);
        const whereClause = filters.length ? `| where ${filters.join(" and ")} ` : "";
        const apl = `['${DEFAULT_DATASET}'] ${whereClause}| sort by _time desc | take ${limit ?? 50}`;
        const end = new Date();
        const start = new Date(end.getTime() - (since_minutes ?? 15) * 60_000);
        const data = await axiomFetch("/datasets/_apl?format=tabular", {
          method: "POST",
          body: JSON.stringify({ apl, startTime: start.toISOString(), endTime: end.toISOString() }),
        });
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );

  server.tool(
    "axiom_dataset_info",
    "Get info about a dataset — field types, retention, ingest stats",
    {
      dataset: z.string().describe("Dataset name (e.g. 'logs')"),
    },
    async ({ dataset }) => {
      try {
        const data = await axiomFetch(`/datasets/${encodeURIComponent(dataset)}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    }
  );
}
