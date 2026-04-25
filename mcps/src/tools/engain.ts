import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ENGAIN_BASE = "https://api.engain.io/api/v1";

async function engainFetch(
  path: string,
  options: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {},
) {
  const apiKey = process.env.ENGAIN_API_KEY;
  if (!apiKey) {
    throw new Error("Engain API key not configured on server (ENGAIN_API_KEY)");
  }

  const url = new URL(`${ENGAIN_BASE}${path}`);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url.toString(), init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Engain ${res.status}: ${text || res.statusText}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getDefaultProjectId(): Promise<string> {
  const me = (await engainFetch("/me")) as {
    projects?: Array<{ id: string; name: string }>;
  };
  const first = me.projects?.[0]?.id;
  if (!first) {
    throw new Error("No Engain projects found for this API key");
  }
  return first;
}

function asText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function asError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerEngainTools(server: McpServer) {
  server.tool(
    "engain_me",
    "Engain: get current identity and the list of projects this API key can access. Use first to discover projectId.",
    {},
    async () => {
      try {
        return asText(await engainFetch("/me"));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_balance",
    "Engain: get credit balance and free-comment allowance for a project.",
    {
      projectId: z.string().optional().describe("Project ID. Defaults to the first project on this API key."),
    },
    async ({ projectId }) => {
      try {
        const pid = projectId ?? (await getDefaultProjectId());
        return asText(await engainFetch("/balance", { query: { projectId: pid } }));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_list_tasks",
    "Engain: list Reddit comment/post/reply tasks for a project. Tasks are scheduled or in-flight Reddit actions.",
    {
      projectId: z.string().optional().describe("Project ID. Defaults to the first project on this API key."),
      status: z
        .enum([
          "scheduled",
          "assigned",
          "waiting_for_parent_comment",
          "sent_for_posting",
          "published",
          "user_deleted",
          "automod_removed",
          "mod_removed",
          "post_url_broken",
        ])
        .optional()
        .describe("Filter by task status"),
      numItems: z.number().int().min(1).max(100).optional().describe("Page size, 1–100 (default 20)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous response"),
      createdAfter: z.string().optional().describe("ISO 8601 or Unix-ms lower bound"),
      createdBefore: z.string().optional().describe("ISO 8601 or Unix-ms upper bound"),
    },
    async ({ projectId, status, numItems, cursor, createdAfter, createdBefore }) => {
      try {
        const pid = projectId ?? (await getDefaultProjectId());
        return asText(
          await engainFetch("/tasks", {
            query: { projectId: pid, status, numItems, cursor, createdAfter, createdBefore },
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_get_task",
    "Engain: get a single task by ID.",
    {
      taskId: z.string().describe("The task ID"),
    },
    async ({ taskId }) => {
      try {
        return asText(await engainFetch(`/tasks/${encodeURIComponent(taskId)}`));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_list_opportunities",
    "Engain: list Reddit opportunities (threads ranking on Google or freshly relevant) to engage with.",
    {
      type: z
        .enum(["new_opportunities", "seo_opportunities"])
        .describe("Required: 'new_opportunities' (recent threads) or 'seo_opportunities' (Google-ranking threads)"),
      projectId: z.string().optional().describe("Project ID. Defaults to the first project on this API key."),
      sortBy: z
        .enum([
          "relevance",
          "date_newest",
          "date_oldest",
          "comments_most",
          "comments_least",
          "upvotes_most",
          "upvotes_least",
          "traffic_high",
          "traffic_low",
        ])
        .optional(),
      numItems: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    },
    async ({ type, projectId, sortBy, numItems, cursor }) => {
      try {
        const pid = projectId ?? (await getDefaultProjectId());
        return asText(
          await engainFetch("/opportunities", {
            query: { projectId: pid, type, sortBy, numItems, cursor },
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_get_opportunity",
    "Engain: get a single opportunity by ID.",
    {
      opportunityId: z.string().describe("The opportunity ID"),
    },
    async ({ opportunityId }) => {
      try {
        return asText(await engainFetch(`/opportunities/${encodeURIComponent(opportunityId)}`));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_list_mentions",
    "Engain: list brand mentions found on Reddit, optionally filtered by brand or sentiment.",
    {
      projectId: z.string().optional().describe("Project ID. Defaults to the first project on this API key."),
      brand: z.string().optional().describe("Filter by brand name"),
      sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
      sortBy: z.string().optional(),
      numItems: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    },
    async ({ projectId, brand, sentiment, sortBy, numItems, cursor }) => {
      try {
        const pid = projectId ?? (await getDefaultProjectId());
        return asText(
          await engainFetch("/mentions", {
            query: { projectId: pid, brand, sentiment, sortBy, numItems, cursor },
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_mention_stats",
    "Engain: get aggregate mention sentiment stats, optionally scoped to a brand.",
    {
      projectId: z.string().optional().describe("Project ID. Defaults to the first project on this API key."),
      brand: z.string().optional(),
    },
    async ({ projectId, brand }) => {
      try {
        const pid = projectId ?? (await getDefaultProjectId());
        return asText(await engainFetch("/mentions/stats", { query: { projectId: pid, brand } }));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.tool(
    "engain_list_orders",
    "Engain: list upvote/downvote orders for a project.",
    {
      projectId: z.string().optional().describe("Project ID. Defaults to the first project on this API key."),
      status: z.string().optional(),
      campaignId: z.string().optional(),
      numItems: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    },
    async ({ projectId, status, campaignId, numItems, cursor }) => {
      try {
        const pid = projectId ?? (await getDefaultProjectId());
        return asText(
          await engainFetch("/orders", {
            query: { projectId: pid, status, campaignId, numItems, cursor },
          }),
        );
      } catch (err) {
        return asError(err);
      }
    },
  );
}
