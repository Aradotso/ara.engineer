// aracli sessions — list and clear Ara sandbox sessions via the local DEV API.
//
// Usage:
//   aracli sessions           list active sessions for the current worktree user
//   aracli sessions --clear   terminate all active sessions

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_API = "http://127.0.0.1:4000";

function getApiBase(): string {
  // Walk upward to find .env.local with CLOUD_API_TARGET or fall back to default
  const envLocal = resolve(process.cwd(), "Ara-backend/api/.env.local");
  if (existsSync(envLocal)) {
    for (const line of readFileSync(envLocal, "utf8").split("\n")) {
      const m = line.match(/^CLOUD_API_TARGET=(.+)/);
      if (m) return m[1].trim().replace(/'/g, "");
    }
  }
  // Try to infer from running ngrok tunnels
  return process.env.CLOUD_API_TARGET || DEFAULT_API;
}

async function getToken(): Promise<string | null> {
  // Check for a CLI auth session token stored by `aracli login` (future) or env
  return process.env.ARA_TOKEN || null;
}

export async function sessionsCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`aracli sessions — list and manage Ara sandbox sessions

Usage:
  aracli sessions           list active sessions
  aracli sessions --clear   terminate all active sessions

Reads CLOUD_API_TARGET env or defaults to http://127.0.0.1:4000.
Requires ARA_TOKEN env var (your Supabase JWT) for auth.
`);
    return 0;
  }

  const apiBase = getApiBase();
  const token = await getToken();

  if (!token) {
    console.error("aracli sessions: ARA_TOKEN not set. Export your Supabase JWT:");
    console.error("  export ARA_TOKEN=$(curl -s ... | jq -r .access_token)");
    console.error("");
    console.error("Or log in with:  ae login  (coming soon)");
    return 1;
  }

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const clearing = argv.includes("--clear");

  try {
    const resp = await fetch(`${apiBase}/session/status`, { headers, signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.error(`aracli sessions: API returned ${resp.status} — is the backend running at ${apiBase}?`);
      return 1;
    }
    const data = await resp.json() as { session_id?: string; status?: string; server_url?: string };
    console.log(`API: ${apiBase}`);
    console.log("");

    if (!data.session_id) {
      console.log("No active session found.");
      return 0;
    }

    console.log(`Session:    ${data.session_id}`);
    console.log(`Status:     ${data.status ?? "unknown"}`);
    console.log(`Server URL: ${data.server_url ?? "(none)"}`);

    if (clearing && data.session_id) {
      const del = await fetch(`${apiBase}/session/stop`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (del.ok) {
        console.log("\nSession terminated.");
      } else {
        console.error(`\nFailed to terminate session: ${del.status}`);
        return 1;
      }
    }
  } catch (err) {
    console.error(`aracli sessions: ${err instanceof Error ? err.message : err}`);
    console.error(`Is the backend running at ${apiBase}?`);
    return 1;
  }

  return 0;
}
