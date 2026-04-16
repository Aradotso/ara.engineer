import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import oauthRouter from "./auth/oauth.js";
import { requireAuth, type AuthenticatedRequest } from "./middleware/auth.js";
import { registerInstacartTools } from "./tools/instacart.js";
import { registerHiggsFieldTools } from "./tools/higgsfield.js";
import { registerPrompts } from "./prompts/index.js";

const PORT = Number(process.env.PORT) || 3000;

// ─── Express app ───
const app = express();
// Parse JSON/form bodies for all routes EXCEPT /mcp (MCP transport reads raw body)
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  express.urlencoded({ extended: true })(req, res, next);
});

// ─── OAuth routes (unauthenticated) ───
app.use(oauthRouter);

// ─── Health check ───
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ara-connectors", version: "1.0.0" });
});

// ─── MCP over Streamable HTTP ───
// We create a new MCP server + transport per session.
// The transport handles POST/GET/DELETE on the /mcp path.

const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

function createMcpSession(): { server: McpServer; transport: StreamableHTTPServerTransport } {
  const server = new McpServer({
    name: "ara-connectors",
    version: "1.0.0",
  });

  // Register all tools and prompts
  registerInstacartTools(server);
  registerHiggsFieldTools(server);
  registerPrompts(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  server.connect(transport);

  return { server, transport };
}

// MCP endpoint — auth required
app.all("/mcp", requireAuth, async (req: AuthenticatedRequest, res) => {
  // Check for existing session
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // New session (only on POST with initialize)
  if (req.method === "POST") {
    const { server, transport } = createMcpSession();

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await transport.handleRequest(req, res);

    // After handling, the transport will have a session ID
    if (transport.sessionId) {
      sessions.set(transport.sessionId, { server, transport });
    }
    return;
  }

  // GET/DELETE without valid session
  res.status(400).json({ error: "No valid session. Send a POST with an initialize request first." });
});

// ─── Start ───
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ara Connectors MCP server running on port ${PORT}`);
  console.log(`  OAuth discovery: /.well-known/oauth-authorization-server`);
  console.log(`  MCP endpoint:    /mcp`);
  console.log(`  Health:          /health`);
});
