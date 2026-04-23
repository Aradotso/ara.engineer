import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const INFISICAL_BASE = "https://app.infisical.com/api";
const ARA_PASSWORDS_PROJECT_ID = "6d518288-7854-49d2-aa42-8ffd285dafa1";

// Infisical machine-identity auth: token is a short-lived JWT we exchange
// from the universal-auth client-id / client-secret pair.
let cachedAuth: { token: string; expiresAt: number } | null = null;

async function getAuthToken(): Promise<string> {
  if (cachedAuth && cachedAuth.expiresAt > Date.now() + 30_000) {
    return cachedAuth.token;
  }
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Infisical machine identity not configured (INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET)");
  }
  const res = await fetch(`${INFISICAL_BASE}/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) throw new Error(`Infisical login ${res.status}: ${await res.text()}`);
  const body = await res.json() as { accessToken: string; expiresIn: number };
  cachedAuth = { token: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 };
  return cachedAuth.token;
}

async function ifetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getAuthToken();
  const res = await fetch(`${INFISICAL_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`Infisical ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

function ok(data: any) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const envEnum = z.enum(["dev", "staging", "prod"]).describe("Infisical environment");
const pathDesc = "Folder path in Ara-passwords (e.g. '/mcp', '/ara-api', '/shared'). Default '/'.";

export function registerInfisicalTools(server: McpServer) {
  server.tool(
    "infisical_list_secrets",
    "List secrets in Ara-passwords at a given environment + folder path. Returns names + values. Use this to discover what keys are available; prefer folder paths over root to narrow the surface.",
    {
      env: envEnum,
      path: z.string().optional().describe(pathDesc),
      projectId: z.string().optional().describe("Override the project ID (default: Ara-passwords)"),
    },
    async ({ env, path, projectId }) => {
      try {
        const qs = new URLSearchParams({
          workspaceId: projectId ?? ARA_PASSWORDS_PROJECT_ID,
          environment: env,
          secretPath: path ?? "/",
        });
        const data = await ifetch(`/v3/secrets/raw?${qs}`);
        const cleaned = (data.secrets ?? []).map((s: any) => ({
          key: s.secretKey,
          value: s.secretValue,
          type: s.type,
          comment: s.secretComment,
        }));
        return ok({ count: cleaned.length, path: path ?? "/", env, secrets: cleaned });
      } catch (e: any) { return err(e.message); }
    },
  );

  server.tool(
    "infisical_get_secret",
    "Get a single secret value by key. Specify env + path + key. Use when you know exactly which secret you need and don't want to dump the whole folder.",
    {
      env: envEnum,
      key: z.string().describe("The secret key/name"),
      path: z.string().optional().describe(pathDesc),
      projectId: z.string().optional(),
    },
    async ({ env, key, path, projectId }) => {
      try {
        const qs = new URLSearchParams({
          workspaceId: projectId ?? ARA_PASSWORDS_PROJECT_ID,
          environment: env,
          secretPath: path ?? "/",
        });
        const data = await ifetch(`/v3/secrets/raw/${encodeURIComponent(key)}?${qs}`);
        return ok(data.secret ?? data);
      } catch (e: any) { return err(e.message); }
    },
  );

  server.tool(
    "infisical_set_secret",
    "Create or update a secret. Requires confirmation before writing to prod (don't pipe unconfirmed values).",
    {
      env: envEnum,
      key: z.string(),
      value: z.string().describe("The secret value"),
      path: z.string().optional().describe(pathDesc),
      comment: z.string().optional(),
      projectId: z.string().optional(),
    },
    async ({ env, key, value, path, comment, projectId }) => {
      try {
        const data = await ifetch(`/v3/secrets/raw/${encodeURIComponent(key)}`, {
          method: "POST",
          body: JSON.stringify({
            workspaceId: projectId ?? ARA_PASSWORDS_PROJECT_ID,
            environment: env,
            secretPath: path ?? "/",
            secretValue: value,
            type: "shared",
            secretComment: comment ?? "",
          }),
        });
        return ok({ ok: true, key, env, path: path ?? "/", data });
      } catch (e: any) {
        // If it already exists, try PATCH (update)
        if (String(e.message).includes("already exists") || String(e.message).includes("400")) {
          try {
            const data = await ifetch(`/v3/secrets/raw/${encodeURIComponent(key)}`, {
              method: "PATCH",
              body: JSON.stringify({
                workspaceId: projectId ?? ARA_PASSWORDS_PROJECT_ID,
                environment: env,
                secretPath: path ?? "/",
                secretValue: value,
                secretComment: comment,
              }),
            });
            return ok({ updated: true, key, env, path: path ?? "/", data });
          } catch (e2: any) { return err(e2.message); }
        }
        return err(e.message);
      }
    },
  );

  server.tool(
    "infisical_delete_secret",
    "Delete a secret. Dangerous — confirm with user before calling.",
    {
      env: envEnum,
      key: z.string(),
      path: z.string().optional().describe(pathDesc),
      projectId: z.string().optional(),
    },
    async ({ env, key, path, projectId }) => {
      try {
        const data = await ifetch(`/v3/secrets/raw/${encodeURIComponent(key)}`, {
          method: "DELETE",
          body: JSON.stringify({
            workspaceId: projectId ?? ARA_PASSWORDS_PROJECT_ID,
            environment: env,
            secretPath: path ?? "/",
          }),
        });
        return ok({ deleted: true, key, env, path: path ?? "/", data });
      } catch (e: any) { return err(e.message); }
    },
  );

  server.tool(
    "infisical_list_folders",
    "List folders in Ara-passwords at a given env + parent path. Use to discover the service/repo grouping.",
    {
      env: envEnum,
      path: z.string().optional().describe("Parent folder path. Default '/'."),
      projectId: z.string().optional(),
    },
    async ({ env, path, projectId }) => {
      try {
        const qs = new URLSearchParams({
          workspaceId: projectId ?? ARA_PASSWORDS_PROJECT_ID,
          environment: env,
          path: path ?? "/",
        });
        const data = await ifetch(`/v1/folders?${qs}`);
        return ok(data);
      } catch (e: any) { return err(e.message); }
    },
  );
}
