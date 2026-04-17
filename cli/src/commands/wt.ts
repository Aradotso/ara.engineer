// ae wt — Ara worktree + 3-service boot with agent-numbered auto-login + ngrok.
//
// Per-worktree:
//   N          = next agent number (monotonic counter at .worktrees/.agent-counter)
//   email      = agent-$N@test.ara.so   (DEV Supabase — never prod)
//   app        = localhost:(5173+offset)  + https://<prefix>-a$N-app.ngrok.app
//   marketing  = localhost:(3000+offset)  + https://<prefix>-a$N-mkt.ngrok.app
//   api        = localhost:(4000+offset)  + https://<prefix>-a$N-api.ngrok.app
//
// Ports increment past anything already listening.

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { writeWorktreeContext } from "./context.ts";
import { resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";

$.throws(false); // we handle exit codes manually

// ─── DEV Supabase (hardcoded so agent worktrees NEVER hit prod) ──────────────
// Public anon + service-role keys for a dedicated dev project. Safe to embed.
const DEV_SUPABASE_URL = "https://kxylcissrngitlpmdhun.supabase.co";
const DEV_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4eWxjaXNzcm5naXRscG1kaHVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0Njg4NTQsImV4cCI6MjA5MTA0NDg1NH0.er0WHmVnShrE3zeV6Mgt6MXqeB5asM_xsXEj664f3JE";
const DEV_SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4eWxjaXNzcm5naXRscG1kaHVuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTQ2ODg1NCwiZXhwIjoyMDkxMDQ0ODU0fQ.OSGGMnAYAqy4nXtiGXuiU0Zwqz49FIv6Z6-KCesIZoo";
const DEV_TEST_PASSWORD = "test-ara-dev-2026";

type Args = {
  name: string;
  task: string;
  noClaude: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { name: "", task: "", noClaude: false, help: false };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--no-claude") out.noClaude = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else positional.push(a);
  }
  // All positional words joined = task description.
  // Branch name = slugified task, or epoch if none given.
  if (positional.length > 0) {
    out.task = positional.join(" ");
    out.name = out.task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  } else {
    out.name = `wt-${Math.floor(Date.now() / 1000)}`;
  }
  return out;
}

function printHelp() {
  console.log(`ae wt — create an isolated Ara worktree + dev env

Usage:
  ae wt [name] [--no-claude]

Options:
  name           worktree name (default: wt-<epoch>)
  --no-claude    don't auto-spawn claude in the left pane

What it does:
  - creates .worktrees/<name> with branch wt/<name>
  - allocates ports for app/marketing/api (agent-numbered)
  - creates/updates DEV Supabase user agent-<N>@test.ara.so
  - injects an agent-N color banner on index.html
  - starts app (5173+N) · marketing (3000+N) · api (4000+N)
  - publishes ngrok tunnels (adi-a<N>-app/mkt/api.ngrok.app)
  - lays out a cmux workspace (left shell · browser · 4 service tabs)
  - spawns claude in the left pane unless --no-claude
`);
}

// ─── process helpers ─────────────────────────────────────────────────────────

async function runCapture(cmd: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function mustCapture(cmd: string[], opts: { cwd?: string } = {}): Promise<string> {
  const r = await runCapture(cmd, opts);
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}

// ─── repo + worktree paths ───────────────────────────────────────────────────

async function resolveRepoRoot(): Promise<string> {
  const r = await runCapture(["git", "rev-parse", "--git-common-dir"]);
  if (r.code === 0 && r.stdout.trim()) return resolve(r.stdout.trim(), "..");
  return resolve(homedir(), "lab/Ara");
}

// ─── port allocation ─────────────────────────────────────────────────────────

async function busyListenPorts(): Promise<Set<number>> {
  // lsof -iTCP -sTCP:LISTEN -P -n — field 9 like "127.0.0.1:5173" or "*:3000"
  const r = await runCapture(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
  const busy = new Set<number>();
  if (r.code !== 0) return busy;
  for (const line of r.stdout.split("\n").slice(1)) {
    const parts = line.split(/\s+/);
    const addr = parts[8];
    if (!addr) continue;
    const port = addr.split(":").pop();
    if (port && /^\d+$/.test(port)) busy.add(Number(port));
  }
  return busy;
}

function freePort(start: number, busy: Set<number>): number {
  let p = start;
  while (busy.has(p)) p++;
  busy.add(p);
  return p;
}

// ─── ngrok orchestration ─────────────────────────────────────────────────────

type Tunnel = { name: string; addr: number; domain: string };

async function ngrokAgentRunning(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function postTunnelsToRunningAgent(tunnels: Tunnel[]): Promise<void> {
  for (const t of tunnels) {
    try {
      await fetch("http://127.0.0.1:4040/api/tunnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: t.name, proto: "http", addr: String(t.addr), domain: t.domain }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 409 conflict (already exists) is fine; any other error we ignore — the
      // user will see it in their own ngrok pane if it matters.
    }
  }
}

function writeNgrokConfig(path: string, tunnels: Tunnel[]): void {
  const lines = ["version: \"3\"", "tunnels:"];
  for (const t of tunnels) {
    lines.push(`  ${t.name}: { proto: http, addr: ${t.addr}, domain: ${t.domain} }`);
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

async function waitForNgrokReady(timeoutSec = 30): Promise<void> {
  for (let i = 0; i < timeoutSec; i++) {
    if (await ngrokAgentRunning()) return;
    await Bun.sleep(1000);
  }
}

// ─── cmux orchestration ──────────────────────────────────────────────────────

function cmuxAvailable(): boolean {
  return Boolean(process.env.CMUX_WORKSPACE_ID) && Bun.which("cmux") !== null;
}

async function cmuxJson(args: string[]): Promise<any> {
  const out = await mustCapture(["cmux", "--json", ...args]);
  return JSON.parse(out);
}

async function cmuxCall(args: string[]): Promise<string> {
  const r = await runCapture(["cmux", ...args]);
  return r.stdout;
}

// ─── the command ─────────────────────────────────────────────────────────────

export async function wtCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const NAME = args.name;
  const REPO = await resolveRepoRoot();
  const WT = resolve(REPO, ".worktrees", NAME);
  const isAraMonorepo = existsSync(resolve(REPO, "app.ara.so"));

  // Sync origin/main without touching the checked-out branch (avoids "refusing
  // to fetch into branch checked out" error when main is the current branch).
  console.log("[wt] syncing main with origin...");
  const fetchResult = await runCapture(["git", "fetch", "origin", "main"], { cwd: REPO });
  if (fetchResult.code !== 0) {
    console.warn(`[wt] warning: could not sync main (${fetchResult.stderr.trim()}); proceeding with local HEAD`);
  }

  await mustCapture(["git", "worktree", "add", WT, "-b", `wt/${NAME}`, "origin/main"], { cwd: REPO });

  if (!isAraMonorepo) {
    // Simple worktree for non-Ara repos — no services, ports, or Supabase.
    const skillsSrc = resolve(import.meta.dir, "../../skills");
    const skillsDst = resolve(WT, ".claude/skills");
    if (existsSync(skillsSrc)) {
      try {
        mkdirSync(resolve(WT, ".claude"), { recursive: true });
        if (existsSync(skillsDst)) unlinkSync(skillsDst);
        symlinkSync(skillsSrc, skillsDst);
      } catch {}
    }

    console.log(`worktree:  ${WT}`);
    console.log(`branch:    wt/${NAME}`);

    if (!args.noClaude && cmuxAvailable()) {
      const wsRaw = await mustCapture(["cmux", "new-workspace", "--name", NAME]);
      const wsMatch = wsRaw.match(/workspace:\d+/);
      if (wsMatch) {
        const WS = wsMatch[0];
        const panes = await cmuxJson(["list-panes", "--workspace", WS]);
        const leftSurface = panes.panes[0].surface_refs?.[0];
        if (leftSurface) {
          await cmuxCall(["send", "--workspace", WS, "--surface", leftSurface, `cd '${WT}' && claude --dangerously-skip-permissions\n`]);
        }
      }
    }

    void statSync; void basename; void $;
    return 0;
  }

  const NGROK_PREFIX = process.env.WT_NGROK_PREFIX || "ae";
  const WT_ROOT = resolve(REPO, ".worktrees");

  // Before computing the next agent number, sweep abandoned worktrees:
  // any worktree whose ports are all dead and has no open/draft PR gets
  // removed so its slot is freed and numbers stay low.
  if (existsSync(WT_ROOT)) {
    const busyNow = await busyListenPorts();
    for (const entry of readdirSync(WT_ROOT)) {
      if (entry.startsWith(".")) continue;
      const wtPath = resolve(WT_ROOT, entry);
      const yml = resolve(wtPath, ".ngrok.yml");
      if (!existsSync(yml)) continue;

      // Parse ports from ngrok.yml
      const ports: number[] = [];
      for (const line of readFileSync(yml, "utf8").split("\n")) {
        const m = line.match(/addr:\s*(\d+)/);
        if (m) ports.push(Number(m[1]));
      }
      if (ports.length === 0) continue;

      // All ports dead → check for open PR before GC-ing
      const allDead = ports.every(p => !busyNow.has(p));
      if (!allDead) continue;

      // Check PR state via gh
      let branchName = "";
      const branchR = await runCapture(["git", "branch", "--show-current"], { cwd: wtPath });
      if (branchR.code === 0) branchName = branchR.stdout.trim();

      let hasOpenPr = false;
      if (branchName) {
        const prR = await runCapture(["gh", "pr", "list", "--head", branchName, "--json", "state", "--limit", "1"], { cwd: REPO });
        if (prR.code === 0) {
          try {
            const prs = JSON.parse(prR.stdout);
            hasOpenPr = prs.some((p: { state: string }) => p.state === "OPEN");
          } catch {}
        }
      }

      if (hasOpenPr) continue;

      // Safe to GC — kill any lingering pids, remove worktree + branch
      console.log(`[wt] sweeping abandoned worktree: ${entry}`);
      for (const port of ports) {
        const lsR = await runCapture(["lsof", "-ti", `tcp:${port}`]);
        if (lsR.code === 0 && lsR.stdout.trim()) {
          for (const pid of lsR.stdout.trim().split("\n")) await runCapture(["kill", "-9", pid.trim()]);
        }
        try {
          await fetch(`http://127.0.0.1:4040/api/tunnels/${encodeURIComponent(`app-${entry}`)}`, {
            method: "DELETE", signal: AbortSignal.timeout(1000),
          });
        } catch {}
      }
      await runCapture(["git", "worktree", "remove", "--force", wtPath], { cwd: REPO });
      if (branchName?.startsWith("wt/")) {
        await runCapture(["git", "branch", "-D", branchName], { cwd: REPO });
      }
    }
  }

  // Pick the lowest agent number not already claimed by a live worktree.
  function nextAgentNumber(): number {
    const used = new Set<number>();
    if (existsSync(WT_ROOT)) {
      for (const entry of readdirSync(WT_ROOT)) {
        const yml = resolve(WT_ROOT, entry, ".ngrok.yml");
        if (!existsSync(yml)) continue;
        for (const line of readFileSync(yml, "utf8").split("\n")) {
          const m = line.match(/app-(\d+):/);
          if (m) used.add(Number(m[1]));
        }
      }
    }
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  const N = nextAgentNumber();

  // Slot-based port allocation keyed to agent number — deterministic, avoids
  // the race where back-to-back runs both see the same "free" port because the
  // previous agent's server hasn't called listen() yet. Busy-scan still runs
  // so we jump slots forward if an unrelated process happens to hold a slot
  // (e.g. a prod Ara dev instance on :3000).
  const busy = await busyListenPorts();
  const SLOT = N - 1;
  let APP = freePort(5173 + SLOT, busy);
  let MKT = freePort(3000 + SLOT, busy);
  let API = freePort(4000 + SLOT, busy);
  // Distinct-check safety net (shouldn't trigger given the base offsets).
  if (MKT === APP) MKT = freePort(MKT + 1, busy);
  if (API === APP || API === MKT) API = freePort(API + 1, busy);

  const DEV_EMAIL = `agent-${N}@test.ara.so`;
  const APP_DOMAIN = `${NGROK_PREFIX}-a${N}-app.ngrok.app`;
  const MKT_DOMAIN = `${NGROK_PREFIX}-a${N}-mkt.ngrok.app`;
  const API_DOMAIN = `${NGROK_PREFIX}-a${N}-api.ngrok.app`;

  // Idempotent admin-upsert — fine if the user already exists (422 returned).
  try {
    await fetch(`${DEV_SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: DEV_SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_TEST_PASSWORD, email_confirm: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // fine — user creation is best-effort; password is stable so reuse works.
  }

  // Register the new worktree path in ~/.railway/config.json so `railway run`
  // works without needing `railway link`. We clone any existing Ara-backend/api
  // entry so no IDs are hardcoded here.
  try {
    const railwayCfgPath = resolve(homedir(), ".railway/config.json");
    if (existsSync(railwayCfgPath)) {
      const cfg = JSON.parse(readFileSync(railwayCfgPath, "utf8"));
      const apiPath = resolve(WT, "Ara-backend/api");
      if (!cfg.projects[apiPath]) {
        // Find any existing entry whose key ends with Ara-backend/api
        const donor = Object.values(cfg.projects as Record<string, any>).find(
          (v: any) => typeof v.projectPath === "string" && v.projectPath.endsWith("Ara-backend/api")
        );
        if (donor) {
          cfg.projects[apiPath] = { ...donor, projectPath: apiPath };
          writeFileSync(railwayCfgPath, JSON.stringify(cfg, null, 2) + "\n");
        }
      }
    }
  } catch {
    // non-fatal — user will see "No linked project" and can railway link manually
  }

  // Symlink bundled skills into the worktree so Claude Code discovers them as slash commands.
  const skillsSrc = resolve(import.meta.dir, "../../skills");
  const skillsDst = resolve(WT, ".claude/skills");
  if (existsSync(skillsSrc)) {
    try {
      mkdirSync(resolve(WT, ".claude"), { recursive: true });
      if (existsSync(skillsDst)) unlinkSync(skillsDst);
      symlinkSync(skillsSrc, skillsDst);
    } catch {}
  }

  // Symlink gitignored files from main tree into the worktree.
  // .env.local carries shared secrets; .venv avoids re-installing Python deps per worktree.
  const symlinks: { src: string; dst: string }[] = [
    ...["app.ara.so", "ara.so", "Ara-backend", "Ara-backend/api"].map((d) => ({
      src: resolve(REPO, d, ".env.local"),
      dst: resolve(WT, d, ".env.local"),
    })),
    { src: resolve(REPO, "Ara-backend/api/.venv"), dst: resolve(WT, "Ara-backend/api/.venv") },
  ];
  for (const { src, dst } of symlinks) {
    if (existsSync(src)) {
      try { if (existsSync(dst)) unlinkSync(dst); } catch {}
      try {
        mkdirSync(dirname(dst), { recursive: true });
        symlinkSync(src, dst);
      } catch {}
    }
  }

  // Visual badge — inject a fixed-position "agent-N" banner into index.html of
  // app and marketing so every agent is instantly distinguishable. Hue rotates by N.
  const HUE = (N * 47) % 360;
  const BADGE = `<style>body::before{content:'agent-${N}';position:fixed;top:0;left:0;z-index:2147483647;padding:3px 10px;background:hsl(${HUE},75%,45%);color:#fff;font:600 11px/1.4 ui-monospace,monospace;border-bottom-right-radius:6px;letter-spacing:0.05em;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,0.3)}</style>`;
  for (const f of [resolve(WT, "app.ara.so/index.html"), resolve(WT, "ara.so/index.html")]) {
    if (existsSync(f)) {
      const html = readFileSync(f, "utf8");
      writeFileSync(f, html.replace("</head>", `${BADGE}</head>`));
    }
  }

  // Single root install — workspaces share one node_modules.
  await runCapture(["bun", "install", "--silent"], { cwd: WT });

  // Vite env-var precedence: process env > .env.local. Override Supabase to
  // DEV so the frontend cannot touch prod data even if the symlinked
  // .env.local points at a prod project. Per-worktree email + shared dev
  // password round out auto-login.
  const frontEnv = [
    `VITE_SUPABASE_URL='${DEV_SUPABASE_URL}'`,
    `VITE_SUPABASE_ANON_KEY='${DEV_SUPABASE_ANON_KEY}'`,
    `VITE_DEV_USER_EMAIL='${DEV_EMAIL}'`,
    `VITE_DEV_USER_PASSWORD='${DEV_TEST_PASSWORD}'`,
    `VITE_CLOUD_API_URL='https://${API_DOMAIN}'`,
    `CLOUD_API_TARGET='http://127.0.0.1:${API}'`,
  ].join(" ");

  const APP_CMD = `cd '${WT}/app.ara.so' && ${frontEnv} bun dev -- --port ${APP} --host 127.0.0.1`;
  const MKT_CMD = `cd '${WT}/ara.so' && ${frontEnv} bun dev -- --port ${MKT} --host 127.0.0.1`;
  // Backend gets DEV Supabase too so JWTs from agent-${N}@test.ara.so verify
  // locally; `railway run` re-injects Railway's prod env AFTER our shell env,
  // so set DEV overrides INSIDE the subshell it spawns — that wins over
  // Railway's. CLOUD_API_PUBLIC_URL pinpoints the Linq webhook to this
  // agent's ngrok tunnel (backend auto-registers on startup).
  const API_CMD = `cd '${WT}/Ara-backend/api' && railway run bash -c "SUPABASE_URL='${DEV_SUPABASE_URL}' SUPABASE_ANON_KEY='${DEV_SUPABASE_ANON_KEY}' SUPABASE_SERVICE_ROLE_KEY='${DEV_SUPABASE_SERVICE_ROLE_KEY}' SUPABASE_JWT_ISSUER='${DEV_SUPABASE_URL}/auth/v1' CLOUD_API_PUBLIC_URL='https://${API_DOMAIN}' CORS_EXTRA_ORIGINS='https://${APP_DOMAIN},https://${MKT_DOMAIN}' ENVIRONMENT=local .venv/bin/python3 -m uvicorn main:app --host 127.0.0.1 --port ${API}"`;

  // Ngrok: ONE agent per authtoken — multiple `ngrok start` calls kick each
  // other offline. Detect a running agent on 4040 and append tunnels via its
  // REST API; else spawn a fresh agent with these 3 tunnels baked in.
  const NG_CFG = resolve(WT, ".ngrok.yml");
  const NG_BASE = resolve(homedir(), "Library/Application Support/ngrok/ngrok.yml");
  const tunnels: Tunnel[] = [
    { name: `app-${N}`, addr: APP, domain: APP_DOMAIN },
    { name: `mkt-${N}`, addr: MKT, domain: MKT_DOMAIN },
    { name: `api-${N}`, addr: API, domain: API_DOMAIN },
  ];
  writeNgrokConfig(NG_CFG, tunnels);

  let ngNeedsReady = false;
  let NG_CMD: string;
  if (await ngrokAgentRunning()) {
    await postTunnelsToRunningAgent(tunnels);
    NG_CMD = `echo '[ngrok] tunnels appended to running agent (http://127.0.0.1:4040)'; sleep infinity`;
  } else {
    // First wt run in the session — spawn the shared ngrok agent. We block
    // below waiting for :4040 so later wt runs detect it reliably.
    NG_CMD = `ngrok start --all --config '${NG_BASE}' --config '${NG_CFG}' --log=stdout`;
    ngNeedsReady = true;
  }

  // ─── layout ──────────────────────────────────────────────────────────────
  let exec: string;
  let _WS: string | null = null;
  let _BROWSER: string | null = null;
  if (cmuxAvailable()) {
    // Build an isolated workspace for this agent and lay out:
    //   [ pane_L (empty terminal) ] [ pane_TR (browser) ]
    //                               [ pane_BR (4 service tabs) ]
    // Every cmux command carries --workspace so nothing leaks into Claude's
    // workspace — learned the hard way: --surface alone still uses
    // $CMUX_WORKSPACE_ID to route the split.
    const wsRaw = await mustCapture(["cmux", "new-workspace", "--name", `agent-${N}`]);
    const wsMatch = wsRaw.match(/workspace:\d+/);
    if (!wsMatch) throw new Error(`cmux new-workspace failed: ${wsRaw}`);
    const WS = wsMatch[0];

    const panes = await cmuxJson(["list-panes", "--workspace", WS]);
    const PANE_L = panes.panes[0].ref as string;

    // Right column: new-split right creates a pane with a default terminal
    // surface — we capture that ref so we can drop it after adding the
    // browser (keeps the browser as the only tab, auto-selected on focus).
    const trSplit = await cmuxJson(["new-split", "right", "--workspace", WS, "--panel", PANE_L]);
    const TR_DEFAULT = trSplit.surface_ref as string;
    const PANE_TR = trSplit.pane_ref as string;
    const browserOut = await cmuxJson(["new-surface", "--type", "browser", "--pane", PANE_TR, "--workspace", WS, "--url", `https://${APP_DOMAIN}`]);
    const BROWSER = browserOut.surface_ref as string;
    await cmuxCall(["close-surface", "--workspace", WS, "--surface", TR_DEFAULT]);

    // Bottom-right pane for services: split down from PANE_TR. The default
    // terminal in the split becomes service #1 (app).
    const brSplit = await cmuxJson(["new-split", "down", "--workspace", WS, "--panel", PANE_TR]);
    const S1 = brSplit.surface_ref as string;
    const PANE_BR = brSplit.pane_ref as string;
    const s2 = await cmuxJson(["new-surface", "--type", "terminal", "--pane", PANE_BR, "--workspace", WS]);
    const S2 = s2.surface_ref as string;
    const s3 = await cmuxJson(["new-surface", "--type", "terminal", "--pane", PANE_BR, "--workspace", WS]);
    const S3 = s3.surface_ref as string;
    const s4 = await cmuxJson(["new-surface", "--type", "terminal", "--pane", PANE_BR, "--workspace", WS]);
    const S4 = s4.surface_ref as string;

    // Resize: browser area ≈ 70% width × 70% height. Default splits are 50/50.
    // --amount is pixels (confirmed empirically), so grow PANE_TR left ~240px
    // and down ~200px to hit 70/70 on a typical 1440x900 cmux window.
    // Tiny delay first — resize silently no-ops if called before render.
    await Bun.sleep(1000);
    await cmuxCall(["resize-pane", "--workspace", WS, "--pane", PANE_TR, "-L", "--amount", "240"]);
    await cmuxCall(["resize-pane", "--workspace", WS, "--pane", PANE_TR, "-D", "--amount", "200"]);

    // `cmux send` defaults --workspace to $CMUX_WORKSPACE_ID (Claude's).
    // Without the explicit --workspace it can't find surfaces we just created
    // in $WS and errors with "Surface is not a terminal".
    await cmuxCall(["send", "--workspace", WS, "--surface", S1, APP_CMD + "\n"]);
    await cmuxCall(["send", "--workspace", WS, "--surface", S2, MKT_CMD + "\n"]);
    await cmuxCall(["send", "--workspace", WS, "--surface", S3, API_CMD + "\n"]);
    await cmuxCall(["send", "--workspace", WS, "--surface", S4, NG_CMD + "\n"]);

    writeWorktreeContext({ name: NAME, task: args.task, wt: WT, n: N, devEmail: DEV_EMAIL, devPassword: DEV_TEST_PASSWORD, app: APP, mkt: MKT, api: API, appDomain: APP_DOMAIN, mktDomain: MKT_DOMAIN, apiDomain: API_DOMAIN, ws: WS, browser: BROWSER, s1: S1, s2: S2, s3: S3, s4: S4 });

    // Auto-spawn claude in the left pane and send an initial prompt so it
    // immediately reads CLAUDE.md and orients itself without the user having to ask.
    if (!args.noClaude) {
      const leftPanes = await cmuxJson(["list-panes", "--workspace", WS]);
      const leftSurface = leftPanes.panes[0].surface_refs?.[0];
      if (leftSurface) {
        await cmuxCall(["send", "--workspace", WS, "--surface", leftSurface, `cd '${WT}' && claude --dangerously-skip-permissions\n`]);
        await cmuxCall(["focus-panel", "--panel", leftSurface]);
        // Wait for Claude to fully render its input prompt, then send the
        // orientation message and a separate \n so Enter actually submits.
        const taskLine = args.task ? `\n\nYour task: ${args.task}` : "";
        await Bun.sleep(8000);
        await cmuxCall(["send", "--workspace", WS, "--surface", leftSurface, `Read CLAUDE.md — it has your full environment context (ports, ngrok URLs, browser surface, axiom queries scoped to your test user). Tell me what branch we're on and what's already committed.${taskLine}`]);
        await Bun.sleep(500);
        await cmuxCall(["send", "--workspace", WS, "--surface", leftSurface, `\n`]);
      }
    }

    _WS = WS;
    _BROWSER = BROWSER;
    exec = `cmux ws=${WS} browser=${BROWSER} app=${S1} mkt=${S2} api=${S3} ngrok=${S4}`;
  } else {
    const LOG = `/tmp/wt-${NAME}`;
    mkdirSync(LOG, { recursive: true });
    for (const [tag, cmd] of [["app", APP_CMD], ["mkt", MKT_CMD], ["api", API_CMD], ["ngrok", NG_CMD]] as const) {
      Bun.spawn(["bash", "-c", `${cmd} >"${LOG}/${tag}.log" 2>&1`], { stdio: ["ignore", "ignore", "ignore"] });
    }
    exec = `logs:${LOG}/{app,mkt,api,ngrok}.log`;
  }

  if (ngNeedsReady) await waitForNgrokReady(30);

  // Reload browser now that ngrok tunnels are up and services are starting.
  if (_BROWSER) {
    await cmuxCall(["browser", _BROWSER, "goto", `https://${APP_DOMAIN}`]);
  }

  console.log(`worktree:  ${WT}`);
  console.log(`branch:    wt/${NAME}`);
  console.log(`agent:     ${N} (${DEV_EMAIL})`);
  console.log(`app:       http://localhost:${APP}   →  https://${APP_DOMAIN}`);
  console.log(`marketing: http://localhost:${MKT}   →  https://${MKT_DOMAIN}`);
  console.log(`api:       http://localhost:${API}   →  https://${API_DOMAIN}`);
  console.log(`exec:      ${exec}`);

  // Touch to satisfy unused-import-if-any linters in strict mode.
  void statSync;
  void basename;
  void $;
  return 0;
}
