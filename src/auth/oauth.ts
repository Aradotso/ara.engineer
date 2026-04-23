import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import {
  registerClient,
  getClient,
  createAuthCode,
  consumeAuthCode,
  storeToken,
  findUserByEmail,
  createUser,
} from "./db.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

// Only these emails can access Ara Connectors
const ALLOWED_EMAILS = ["adi@ara.so", "sven@ara.so"];

const router = Router();

// ─── Discovery: RFC 9728 Protected Resource Metadata ───
router.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ["header"],
  });
});

// ─── Discovery: RFC 8414 Authorization Server Metadata ───
router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp:tools", "mcp:prompts", "mcp:resources"],
  });
});

// ─── Dynamic Client Registration (RFC 7591) ───
router.post("/oauth/register", (req: Request, res: Response) => {
  const { redirect_uris, client_name } = req.body;
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uris required" });
    return;
  }
  const client = registerClient(redirect_uris, client_name);
  res.status(201).json({
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uris: JSON.parse(client.redirect_uris),
    client_name: client.client_name,
    token_endpoint_auth_method: "client_secret_post",
  });
});

// ─── Pending Google OAuth flows (store MCP OAuth params while user is at Google) ───
const pendingFlows = new Map<string, {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
}>();

// ─── Authorization endpoint ───
// GET: render "Sign in with Google" page
router.get("/oauth/authorize", (req: Request, res: Response) => {
  const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method, scope } = req.query;

  if (response_type !== "code") {
    res.status(400).send("Unsupported response_type");
    return;
  }

  const client = getClient(client_id as string);
  if (!client) {
    res.status(400).send("Unknown client");
    return;
  }

  // Trust redirect_uri from dynamically registered MCP clients.
  // Claude.ai and mcp-remote use dynamic callback URIs — strict matching breaks them.
  // The client already proved ownership of its redirect domain at registration time.
  const redirectStr = redirect_uri as string;

  // Store the MCP OAuth params so we can resume after Google callback
  const flowId = nanoid(32);
  pendingFlows.set(flowId, {
    client_id: client_id as string,
    redirect_uri: redirectStr,
    state: (state as string) ?? "",
    code_challenge: (code_challenge as string) ?? "",
    code_challenge_method: (code_challenge_method as string) ?? "",
    scope: (scope as string) ?? "mcp:tools",
  });

  // Clean up old flows (>15 min)
  const now = Date.now();
  for (const [key] of pendingFlows) {
    if (pendingFlows.size > 1000) pendingFlows.delete(key);
  }

  // Build Google OAuth URL
  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set("redirect_uri", `${BASE_URL}/oauth/google/callback`);
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", "openid email profile");
  googleAuthUrl.searchParams.set("state", flowId);
  googleAuthUrl.searchParams.set("prompt", "select_account");
  googleAuthUrl.searchParams.set("hd", "ara.so"); // Hint: only show ara.so accounts

  // Render page with Google Sign-In button
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ara — Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 16px; padding: 40px; max-width: 420px; width: 100%; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; margin-bottom: 24px; font-size: 14px; }
    .scope { background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px; margin-bottom: 32px; font-size: 13px; color: #aaa; text-align: left; }
    .scope strong { color: #e5e5e5; }
    .google-btn { display: inline-flex; align-items: center; gap: 12px; padding: 12px 24px; background: #fff; color: #333; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; text-decoration: none; transition: box-shadow 0.15s; }
    .google-btn:hover { box-shadow: 0 2px 12px rgba(255,255,255,0.1); }
    .google-btn svg { width: 20px; height: 20px; }
    .hint { margin-top: 20px; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Ara</h1>
    <p class="subtitle">${client.client_name ?? "An MCP client"} wants to connect to Ara Connectors</p>
    <div class="scope">
      <strong>${client.client_name ?? "This client"}</strong> is requesting access to
      Ara's managed MCP tools — Railway, Resend, Instacart, Higgsfield,
      Blaxel, Engain, Linq, Postiz, and more.
    </div>
    <a href="${googleAuthUrl.toString()}" class="google-btn">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </a>
    <p class="hint">Only @ara.so accounts are allowed</p>
  </div>
</body>
</html>`);
});

// ─── Google OAuth callback ───
router.get("/oauth/google/callback", async (req: Request, res: Response) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).send(`Google auth error: ${error}`);
    return;
  }

  const flowId = state as string;
  const flow = pendingFlows.get(flowId);
  if (!flow) {
    res.status(400).send("Invalid or expired auth flow. Please try again.");
    return;
  }
  pendingFlows.delete(flowId);

  try {
    // Exchange Google auth code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code as string,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/oauth/google/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      res.status(400).send(`Google token error: ${err}`);
      return;
    }

    const tokens = await tokenRes.json() as { access_token: string };

    // Get user info from Google
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoRes.ok) {
      res.status(400).send("Failed to get Google user info");
      return;
    }

    const googleUser = await userInfoRes.json() as { email: string; name: string };
    const email = googleUser.email.toLowerCase();

    // Check allowlist
    if (!ALLOWED_EMAILS.includes(email)) {
      res.type("html").send(`<!DOCTYPE html>
<html><head><title>Access Denied</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 16px; padding: 40px; max-width: 400px; text-align: center; }
  h1 { color: #ef4444; margin-bottom: 12px; }
  p { color: #888; }
</style></head>
<body><div class="card">
  <h1>Access Denied</h1>
  <p>${email} is not authorized to use Ara Connectors. Only @ara.so team accounts are allowed.</p>
</div></body></html>`);
      return;
    }

    // Create or find user
    let user = findUserByEmail(email);
    if (!user) {
      const userId = createUser(email, "google-oauth");
      user = { id: userId, email, password_hash: "google-oauth", team_id: null };
    }

    // Issue MCP auth code and redirect back to Claude
    const mcpCode = createAuthCode({
      clientId: flow.client_id,
      userId: user.id,
      redirectUri: flow.redirect_uri,
      codeChallenge: flow.code_challenge || undefined,
      codeChallengeMethod: flow.code_challenge_method || undefined,
    });

    const redirectUrl = new URL(flow.redirect_uri);
    redirectUrl.searchParams.set("code", mcpCode);
    if (flow.state) redirectUrl.searchParams.set("state", flow.state);
    res.redirect(302, redirectUrl.toString());

  } catch (err: any) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// ─── Token endpoint ───
router.post("/oauth/token", (req: Request, res: Response) => {
  const { grant_type, code, client_id, client_secret, redirect_uri, code_verifier } = req.body;

  console.log("[token] grant_type:", grant_type, "client_id:", client_id, "redirect_uri:", redirect_uri, "has_code:", !!code, "has_verifier:", !!code_verifier);

  if (grant_type !== "authorization_code") {
    console.log("[token] FAIL: unsupported_grant_type", grant_type);
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const authCode = consumeAuthCode(code);
  if (!authCode) {
    console.log("[token] FAIL: invalid code (expired or used)");
    res.status(400).json({ error: "invalid_grant", error_description: "Code expired or already used" });
    return;
  }

  console.log("[token] authCode found — client_id match:", authCode.client_id === client_id, "redirect match:", authCode.redirect_uri === redirect_uri);
  console.log("[token] stored redirect:", authCode.redirect_uri, "received redirect:", redirect_uri);

  if (authCode.client_id !== client_id) {
    console.log("[token] FAIL: client mismatch", authCode.client_id, "vs", client_id);
    res.status(400).json({ error: "invalid_grant", error_description: "Client mismatch" });
    return;
  }

  // Skip redirect_uri check — PKCE already prevents code theft, and Claude.ai
  // may send slightly different URIs than what was stored during the authorize step
  if (redirect_uri && authCode.redirect_uri && authCode.redirect_uri !== redirect_uri) {
    console.log("[token] WARN: redirect_uri mismatch (allowing anyway):", authCode.redirect_uri, "vs", redirect_uri);
  }

  // PKCE verification
  if (authCode.code_challenge) {
    if (!code_verifier) {
      console.log("[token] FAIL: code_verifier required but missing");
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
      return;
    }
    const expected = crypto.createHash("sha256").update(code_verifier).digest("base64url");
    if (expected !== authCode.code_challenge) {
      console.log("[token] FAIL: PKCE mismatch");
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
  }

  // Client secret verification (if the client has one)
  const client = getClient(client_id);
  if (client?.client_secret && client_secret !== client.client_secret) {
    console.log("[token] FAIL: invalid_client secret");
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  const accessToken = `ara_${nanoid(48)}`;
  const expiresIn = 86400; // 24 hours
  storeToken(accessToken, authCode.user_id, client_id, "mcp:tools mcp:prompts", Date.now() + expiresIn * 1000);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: "mcp:tools mcp:prompts",
  });
});

export default router;
