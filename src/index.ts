import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import oauthRouter from "./auth/oauth.js";
import { requireAuth, type AuthenticatedRequest } from "./middleware/auth.js";
import { registerInstacartTools } from "./tools/instacart.js";
import { registerHiggsFieldTools } from "./tools/higgsfield.js";
import { registerRailwayTools } from "./tools/railway.js";
import { registerBlaxelTools } from "./tools/blaxel.js";
import { registerResendTools } from "./tools/resend.js";
import { registerEngainTools } from "./tools/engain.js";
import { registerLinqTools } from "./tools/linq.js";
import { registerPostizTools } from "./tools/postiz.js";
import { registerPrompts } from "./prompts/index.js";

const PORT = Number(process.env.PORT) || 3000;

// MCP paths — Claude.ai sends requests to "/" while direct connections use "/mcp"
const MCP_PATHS = new Set(["/", "/mcp"]);

// ─── Server instructions shown to every agent on session init ───
// This is the "CLAUDE.md" of the connector. It is sent to the model as the
// system message for any tool-using agent that connects (Claude Desktop,
// Claude Code sandboxes, the Claude API, etc.). Keep it skimmable — agents
// will waste time exploring the filesystem otherwise.
const ARA_INSTRUCTIONS = `# Ara Connectors

You have direct access to Ara's internal tools via MCP. For Railway and
the other services below, just call these tools — don't shell out, don't
curl APIs, don't ask the user for keys.

## 🔑 ALL secrets & API keys for Ara live in Railway variables

API keys, DB URLs, OAuth secrets, third-party tokens (Stripe, OpenAI,
Anthropic, Supabase, GitHub, Slack, Resend, Google, etc.) — all stored
as Railway env vars on one of our services.

**Start with \`ara-api\` — it has almost everything.**

Hardcoded IDs (skip the discovery roundtrips):
- Project \`Ara Backend\`: \`5b03413d-9ace-4617-beb5-18b26ce5f339\`
- Environment \`prd\`: \`f3d22dae-9e86-4a38-a26e-0d27efa12749\`
- Service \`ara-api\`: \`304984ab-6cc0-42cf-80e4-9cc9b6529b21\`

Typical lookup: call \`railway_get_variables\` with the three IDs above.
If the key isn't there, check \`ara-connectors\` or \`locomotive\` via
\`railway_list_projects\`.

Do NOT: ask the user to paste credentials, read \`.env\`/\`.env.local\`
hoping they exist, generate fake values, or search the filesystem. If a
value isn't in any Railway service, THEN ask the user.

## Tools available

- **Railway** (40+ \`railway_*\` tools) — projects, services, deployments,
  variables, domains, volumes, logs, metrics. Replaces the Railway CLI
  entirely (the CLI needs interactive auth that cloud agents can't do).
- **Resend** (\`send_email\`, \`list_emails\`, \`get_email\`) — default from
  \`hello@ara.so\` unless user specifies.
- **Instacart** (\`search_products\`, \`search_stores\`, \`create_cart\`, \`check_order_status\`)
- **Higgsfield** (\`generate_video\`, \`check_video_status\`, \`edit_video\`)
- **Blaxel** (\`blaxel_*\`) — agent deployment.
- **Engain** (\`engain_*\`) — leads / outbound.
- **Linq** (\`linq_*\`) — messaging.
- **Postiz** (\`postiz_*\`) — social scheduling.

Call \`tools/list\` for full schemas.

## This connector's own IDs (if you need to manage it)

- Project \`ara-connectors\`: \`b67dca16-5fea-41b9-ab0e-a7234237adc3\`
- Environment \`production\`: \`f4e22ed4-dde1-4aec-b1b1-375cc715ec38\`
- Service \`ara-connectors\`: \`fcabbab7-ec75-4052-bbcd-b5d1dd974ab8\`

## Working inside a repo vs. standalone

If you're in a repo (e.g. an Aradotso/Ara cloud agent), do your normal
SWE work — just use these tools instead of the \`railway\` CLI, instead
of writing code to hit these APIs, and instead of asking for keys.

If you're standalone (Claude Desktop, Cowork, no repo), the tools above
are likely why the user invoked you.

Either way: call tools directly without asking permission for reads;
confirm before destructive writes (deletes, prod redeploys, sending
real emails). If a tool errors with "API key not configured", tell the
user which env var is missing — don't invent credentials.

Auto-updates: new tools pushed to \`Aradotso/ara-connectors\` on GitHub
appear on the next session.
`;

// ─── Express app ───
const app = express();
// Parse JSON/form bodies for all routes EXCEPT MCP paths (MCP transport reads raw body)
app.use((req, res, next) => {
  if (MCP_PATHS.has(req.path)) return next();
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (MCP_PATHS.has(req.path)) return next();
  express.urlencoded({ extended: true })(req, res, next);
});

// ─── Request logging ───
app.use((req, _res, next) => {
  if (req.path !== "/health") {
    console.log(`${req.method} ${req.path} ${req.query ? JSON.stringify(req.query) : ""}`);
  }
  next();
});

// ─── OAuth routes (unauthenticated) ───
app.use(oauthRouter);

// ─── Health check ───
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ara-connectors", version: "1.0.0" });
});

// ─── MCP over Streamable HTTP ───
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

function createMcpSession(): { server: McpServer; transport: StreamableHTTPServerTransport } {
  const server = new McpServer(
    {
      name: "ara-connectors",
      version: "1.0.0",
    },
    {
      instructions: ARA_INSTRUCTIONS,
    },
  );

  registerInstacartTools(server);
  registerHiggsFieldTools(server);
  registerRailwayTools(server);
  registerBlaxelTools(server);
  registerResendTools(server);
  registerEngainTools(server);
  registerLinqTools(server);
  registerPostizTools(server);
  registerPrompts(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  server.connect(transport);
  return { server, transport };
}

// MCP handler — shared between "/" and "/mcp"
async function handleMcp(req: AuthenticatedRequest, res: express.Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === "POST") {
    const { server, transport } = createMcpSession();

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await transport.handleRequest(req, res);

    if (transport.sessionId) {
      sessions.set(transport.sessionId, { server, transport });
    }
    return;
  }

  res.status(400).json({ error: "No valid session. Send a POST with an initialize request first." });
}

// Serve MCP on both "/" and "/mcp" — Claude.ai uses "/", direct clients use "/mcp"
app.all("/mcp", requireAuth, handleMcp);
app.all("/", requireAuth, handleMcp);

// ─── Start ───
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ara Connectors MCP server running on port ${PORT}`);
  console.log(`  OAuth discovery: /.well-known/oauth-authorization-server`);
  console.log(`  MCP endpoint:    / and /mcp`);
  console.log(`  Health:          /health`);
});
