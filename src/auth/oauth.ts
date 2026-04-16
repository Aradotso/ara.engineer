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

// ─── Authorization endpoint ───
// GET: render login form / consent page
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

  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirect_uri as string)) {
    res.status(400).send("Invalid redirect_uri");
    return;
  }

  // Render a minimal login + consent page
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ara — Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 16px; padding: 40px; max-width: 400px; width: 100%; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; margin-bottom: 32px; font-size: 14px; }
    label { display: block; font-size: 13px; color: #aaa; margin-bottom: 6px; margin-top: 16px; }
    input { width: 100%; padding: 10px 14px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #e5e5e5; font-size: 15px; }
    input:focus { outline: none; border-color: #6366f1; }
    button { width: 100%; margin-top: 24px; padding: 12px; background: #6366f1; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #4f46e5; }
    .scope { background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 13px; color: #aaa; }
    .scope strong { color: #e5e5e5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Ara</h1>
    <p class="subtitle">Claude Desktop wants to connect to Ara Connectors</p>
    <div class="scope">
      <strong>${client.client_name ?? "Claude Desktop"}</strong> is requesting access to:
      <br>Instacart grocery ordering, Higgsfield video generation, and more.
    </div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${client_id}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <input type="hidden" name="state" value="${state ?? ""}">
      <input type="hidden" name="code_challenge" value="${code_challenge ?? ""}">
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method ?? ""}">
      <input type="hidden" name="scope" value="${scope ?? "mcp:tools"}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required placeholder="you@company.com">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required placeholder="••••••••">
      <button type="submit">Sign in &amp; Authorize</button>
    </form>
  </div>
</body>
</html>`);
});

// POST: handle login + issue auth code
router.post("/oauth/authorize", async (req: Request, res: Response) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope, email, password } = req.body;

  const client = getClient(client_id);
  if (!client) {
    res.status(400).send("Unknown client");
    return;
  }

  // Simple password auth — hash and check
  const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
  let user = findUserByEmail(email);

  if (!user) {
    // Auto-register on first login (swap for invite-only in production)
    const userId = createUser(email, passwordHash);
    user = { id: userId, email, password_hash: passwordHash, team_id: null };
  } else if (user.password_hash !== passwordHash) {
    res.status(401).send("Invalid credentials");
    return;
  }

  const code = createAuthCode({
    clientId: client_id,
    userId: user.id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(302, redirectUrl.toString());
});

// ─── Token endpoint ───
router.post("/oauth/token", (req: Request, res: Response) => {
  const { grant_type, code, client_id, client_secret, redirect_uri, code_verifier } = req.body;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const authCode = consumeAuthCode(code);
  if (!authCode) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code expired or already used" });
    return;
  }

  if (authCode.client_id !== client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "Client mismatch" });
    return;
  }

  if (authCode.redirect_uri !== redirect_uri) {
    res.status(400).json({ error: "invalid_grant", error_description: "Redirect URI mismatch" });
    return;
  }

  // PKCE verification
  if (authCode.code_challenge) {
    if (!code_verifier) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
      return;
    }
    const expected = crypto.createHash("sha256").update(code_verifier).digest("base64url");
    if (expected !== authCode.code_challenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
  }

  // Client secret verification (if the client has one and method is client_secret_post)
  const client = getClient(client_id);
  if (client?.client_secret && client_secret !== client.client_secret) {
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
