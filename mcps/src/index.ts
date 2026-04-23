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
import { registerBraintrustTools } from "./tools/braintrust.js";
import { registerAxiomTools } from "./tools/axiom.js";
import { registerInfisicalTools } from "./tools/infisical.js";
import { registerPrompts } from "./prompts/index.js";

const PORT = Number(process.env.PORT) || 3000;

// MCP paths — some clients (e.g. claude.ai) send requests to "/" while
// direct connections and most CLIs use "/mcp". We serve both.
const MCP_PATHS = new Set(["/", "/mcp"]);

// ─── Server instructions shown to every agent on session init ───
// Sent as the system message to any MCP-speaking agent that connects
// (ChatGPT, Codex CLI, Cursor, Claude Desktop/Code, etc.). Keep it
// skimmable — agents waste time exploring the filesystem otherwise.
const ARA_INSTRUCTIONS = `# Ara MCP

You have direct access to Ara's internal tools via MCP. For Railway and
the other services below, just call these tools — don't shell out, don't
curl APIs, don't ask the user for keys.

## 🔑 ALL secrets & API keys live in Infisical (project: Ara-passwords)

API keys, DB URLs, OAuth secrets, third-party tokens (Stripe, OpenAI,
Anthropic, Supabase, GitHub, Slack, Resend, Google, etc.) are in
Infisical, organized by folder per service.

**Use the \`infisical_*\` tools, not \`railway_*\` for secrets.**

Hardcoded IDs (skip the discovery roundtrips):
- Ara-passwords project ID: \`6d518288-7854-49d2-aa42-8ffd285dafa1\`
- Environments: \`dev\`, \`staging\`, \`prod\`

Folder layout:
- \`/shared/\` — used by multiple services (LLM keys, Supabase, Stripe, etc.)
- \`/ara-api/\` — the main backend service (ara-api on Railway)
- \`/ara-web/\` — frontend web app (VITE_* vars)
- \`/text-ara-so/\` — text.ara.so SMS service (LINQ_*)
- \`/mcp/\` — this MCP server's own keys
- \`/cli/\` — the ae CLI

Typical lookup: call \`infisical_list_secrets\` with env + path to see
what's there, or \`infisical_get_secret\` for a specific key. Railway
is still where services **run** and where Railway's own platform vars
(RAILWAY_*, PORT) live — but it is NOT the source of truth for app
secrets anymore. Do not add new secrets to Railway.

Do NOT: ask the user to paste credentials, read \`.env\`/\`.env.local\`
hoping they exist, generate fake values, or search the filesystem. If a
value isn't in Infisical, THEN ask the user.

## Tools available

- **Railway** (60 \`railway_*\` tools) — projects, services, deployments,
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
- **Braintrust** (\`braintrust_*\`) — eval experiments, trace logs, datasets, prompts.
- **Axiom** (\`axiom_query\`, \`axiom_tail_logs\`, \`axiom_list_datasets\`) — Ara logs
  (\`logs\` dataset). Use \`axiom_tail_logs\` for ad-hoc debugging.
- **Infisical** (\`infisical_list_secrets\`, \`infisical_get_secret\`,
  \`infisical_set_secret\`, \`infisical_delete_secret\`, \`infisical_list_folders\`) —
  canonical secret store for everything runtime.

Call \`tools/list\` for full schemas.

## This MCP's own IDs (if you need to manage it)

- Project \`ara.engineer\`: \`07bb290d-ae52-4491-936b-7e56d2165840\`
- Environment \`production\`: \`813c7fb7-7eeb-4ab3-b74b-0aaab0694508\`
- Service \`mcp\`: \`81a874eb-1c6c-40c7-b014-1b06507a1e64\`

## Working inside a repo vs. standalone

If you're in a repo (e.g. an Aradotso/Ara cloud agent), do your normal
SWE work — just use these tools instead of the \`railway\` CLI, instead
of writing code to hit these APIs, and instead of asking for keys.

If you're standalone (no repo, e.g. a desktop chat client), the tools
above are likely why the user invoked you.

Either way: call tools directly without asking permission for reads;
confirm before destructive writes (deletes, prod redeploys, sending
real emails). If a tool errors with "API key not configured", tell the
user which env var is missing — don't invent credentials.

Auto-updates: this MCP lives at \`Aradotso/ara.engineer\` → \`mcps/\`.
Pushes to main auto-deploy; new tools appear on the next session.
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
  res.json({ status: "ok", service: "ara-mcp", version: "1.0.0" });
});

// ─── MCP over Streamable HTTP ───
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

function createMcpSession(): { server: McpServer; transport: StreamableHTTPServerTransport } {
  const server = new McpServer(
    {
      name: "ara-mcp",
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
  registerBraintrustTools(server);
  registerAxiomTools(server);
  registerInfisicalTools(server);
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

// Serve MCP on both "/" and "/mcp" — claude.ai uses "/", direct clients use "/mcp"
app.all("/mcp", requireAuth, handleMcp);
app.all("/", requireAuth, handleMcp);

// ─── Start ───
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ara MCP server running on port ${PORT}`);
  console.log(`  OAuth discovery: /.well-known/oauth-authorization-server`);
  console.log(`  MCP endpoint:    / and /mcp`);
  console.log(`  Health:          /health`);
});
