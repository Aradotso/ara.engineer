// aracli poll — watch Linear for In Progress issues assigned to Adi, spawn aracli wt,
// then track PR lifecycle: open → In Review, merged → Done.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// ─── Linear IDs (Ara workspace) ──────────────────────────────────────────────
const STATE_IN_PROGRESS = "414a4dc5-5be4-4144-b912-fc2412dab51c";
const STATE_IN_REVIEW = "ef4c2075-b93d-4a8a-87c2-0b2d632481a7";
const STATE_DONE = "2d48ea35-d79a-47fb-a3f1-c94fb29e2592";

const STATE_FILE = resolve(homedir(), ".ae-poll-state.json");
const PLIST_PATH = resolve(homedir(), "Library/LaunchAgents/so.ara.ae-poll.plist"); // kept for --uninstall cleanup

// Presume the user runs `aracli poll` from their Ara checkout. Fall back to a
// per-user hardcoded path only if cwd isn't a git repo.
function findAraRepo(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, ".git"))) return cwd;
  const home = homedir();
  const candidates = [
    home === "/Users/sve" ? "/Users/sve/Ara" : null,
    home === "/Users/adisingh" ? "/Users/adisingh/github/Ara" : null,
    resolve(home, "Ara"),
    resolve(home, "github/Ara"),
  ].filter((p): p is string => p !== null);
  for (const p of candidates) {
    if (existsSync(resolve(p, ".git"))) return p;
  }
  return cwd;
}
const ARA_REPO = findAraRepo();

// ─── state ────────────────────────────────────────────────────────────────────

type TrackedIssue = {
  id: string;
  identifier: string;
  title: string;
  branch: string;
  spawnedAt: string;
  prNumber?: number;
  linearState: "in-progress" | "in-review" | "done";
};

type PollState = { tracked: Record<string, TrackedIssue> };

function loadState(): PollState {
  if (!existsSync(STATE_FILE)) return { tracked: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { tracked: {} }; }
}

function saveState(s: PollState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function titleToBranch(title: string): string {
  return "wt/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

async function linearGql(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  let delay = 2_000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
    // Rate limited — back off and retry
    if (res.status === 429 || res.status === 503) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "0", 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : delay;
      console.error(`[poll] rate limited (${res.status}), retrying in ${wait / 1000}s…`);
      await Bun.sleep(wait);
      delay *= 2;
      continue;
    }
    const json = await res.json() as any;
    if (json.errors) {
      const msg = json.errors[0]?.message ?? "Linear API error";
      if (msg.includes("rate") || msg.includes("limit")) {
        await Bun.sleep(delay);
        delay *= 2;
        continue;
      }
      throw new Error(msg);
    }
    return json.data;
  }
  throw new Error("Linear API rate limit exceeded after retries");
}

async function getViewerId(apiKey: string): Promise<string> {
  const data = await linearGql(apiKey, `{ viewer { id } }`);
  return data.viewer.id;
}

async function getInProgressIssues(apiKey: string, userId: string): Promise<Array<{ id: string; identifier: string; title: string }>> {
  const data = await linearGql(apiKey, `{
    issues(filter: {
      assignee: { id: { eq: "${userId}" } }
      state: { id: { eq: "${STATE_IN_PROGRESS}" } }
    }, first: 50) {
      nodes { id identifier title }
    }
  }`);
  return data.issues.nodes;
}

async function updateIssueState(apiKey: string, issueId: string, stateId: string): Promise<void> {
  await linearGql(apiKey, `
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }
  `, { id: issueId, stateId });
}

const GH_BIN = Bun.which("gh") ?? resolve(homedir(), ".local/bin/gh");

async function getPrForBranch(branch: string): Promise<{ number: number; state: string } | null> {
  try {
    const r = Bun.spawnSync(
      [GH_BIN, "pr", "list", "--head", branch, "--json", "number,state", "--limit", "1"],
      { stdout: "pipe", stderr: "pipe", cwd: ARA_REPO },
    );
    if (r.exitCode !== 0) return null;
    const prs = JSON.parse(r.stdout.toString().trim()) as Array<{ number: number; state: string }>;
    return prs[0] ?? null;
  } catch { return null; }
}

// Resolve cmux dynamically — users may have stable (`cmux.app`) or NIGHTLY
// (`cmux NIGHTLY.app`) installs, or cmux on PATH from a manual install.
function findCmuxBin(): string {
  const onPath = Bun.which("cmux");
  if (onPath) return onPath;
  const candidates = [
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
    "/Applications/cmux NIGHTLY.app/Contents/Resources/bin/cmux",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return "/Applications/cmux.app/Contents/Resources/bin/cmux";
}
const CMUX_BIN = findCmuxBin();

const SPAWN_PATH = [
  `${homedir()}/.bun/bin`,
  `${homedir()}/.local/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
  dirname(CMUX_BIN),
].join(":");

const SESSION_FILE = resolve(homedir(), ".ae-cmux-session");

function loadCmuxSession(): { ws: string; surface: string } | null {
  try {
    const [ws, surface] = readFileSync(SESSION_FILE, "utf8").trim().split(" ");
    return ws && surface ? { ws, surface } : null;
  } catch { return null; }
}

function saveCmuxSession(ws: string, surface: string): void {
  writeFileSync(SESSION_FILE, `${ws} ${surface}\n`);
}

const TRIGGER_DIR = resolve(homedir(), ".ae-poll-triggers");

function spawnWt(title: string): void {
  // Write a trigger file — the watcher loop running inside the cmux spawn shell
  // picks it up and runs aracli wt from within cmux (full socket access).
  mkdirSync(TRIGGER_DIR, { recursive: true });
  const safe = title.replace(/'/g, "'\\''");
  const id = Date.now();
  writeFileSync(resolve(TRIGGER_DIR, `${id}.sh`), `aracli wt '${safe}'\n`, { mode: 0o755 });
  console.log(`[poll] ✓ trigger written for: ${title}`);
}

// ─── core poll ────────────────────────────────────────────────────────────────

async function pollOnce(apiKey: string, userId: string): Promise<void> {
  const state = loadState();

  const activeIssues = await getInProgressIssues(apiKey, userId);
  const activeIds = new Set(activeIssues.map(i => i.id));

  // Spawn aracli wt for any newly In Progress issues
  for (const issue of activeIssues) {
    if (!state.tracked[issue.id]) {
      console.log(`[poll] ▶ ${issue.identifier}: ${issue.title}`);
      const branch = titleToBranch(issue.title);
      // Save BEFORE spawn so a crash in spawnWt never causes a double-spawn
      state.tracked[issue.id] = {
        id: issue.id, identifier: issue.identifier, title: issue.title,
        branch, spawnedAt: new Date().toISOString(), linearState: "in-progress",
      };
      saveState(state);
      try { spawnWt(issue.title); } catch (e) { console.error(`[poll] spawn failed: ${(e as Error).message}`); }
    }
  }

  saveState(state); // persist any PR-state changes below

  // Update Linear state based on PR lifecycle
  for (const [id, tracked] of Object.entries(state.tracked)) {
    // Issue was moved out of In Progress externally — stop tracking
    if (tracked.linearState === "in-progress" && !activeIds.has(id)) {
      console.log(`[poll] ✕ ${tracked.identifier} left In Progress externally, untracking`);
      delete state.tracked[id];
      continue;
    }

    if (tracked.linearState === "done") continue;

    const pr = await getPrForBranch(tracked.branch);
    if (!pr) continue;

    if (pr.state === "OPEN" && tracked.linearState === "in-progress") {
      console.log(`[poll] ↗ ${tracked.identifier} PR #${pr.number} open → In Review`);
      await updateIssueState(apiKey, id, STATE_IN_REVIEW);
      state.tracked[id] = { ...tracked, prNumber: pr.number, linearState: "in-review" };
    } else if (pr.state === "MERGED" && tracked.linearState !== "done") {
      console.log(`[poll] ✓ ${tracked.identifier} PR #${pr.number} merged → Done`);
      await updateIssueState(apiKey, id, STATE_DONE);
      state.tracked[id] = { ...tracked, prNumber: pr.number, linearState: "done" };
    }
  }

  saveState(state);
}

// ─── install ──────────────────────────────────────────────────────────────────

const LOCAL_KEY_FILE = resolve(homedir(), ".ae-linear-key");

function getLocalApiKey(): string | null {
  // Priority: env var → ~/.ae-linear-key → (Railway fallback, may not be yours)
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  if (existsSync(LOCAL_KEY_FILE)) return readFileSync(LOCAL_KEY_FILE, "utf8").trim() || null;
  return null;
}

async function getApiKeyFromRailway(): Promise<string | null> {
  try {
    const r = Bun.spawnSync(
      ["railway", "run", "--service", "ara-api", "--environment", "prd", "--", "bash", "-c", "printf '%s' \"$LINEAR_API_KEY\""],
      { stdout: "pipe", stderr: "pipe", cwd: ARA_REPO },
    );
    return r.stdout.toString().trim() || null;
  } catch { return null; }
}

function installAsBackground(apiKey: string): void {
  // Run poll loop directly as a background job — no caffeinate wrapper.
  // caffeinate as a parent breaks cmux socket credentials; run it standalone instead.
  // caffeinate -si (no command) prevents sleep until killed alongside the poll loop.
  const ae = Bun.which("ae") ?? `${homedir()}/.bun/bin/ae`;
  const cmd = `LINEAR_API_KEY='${apiKey}' '${ae}' poll --loop >> ~/.ae-poll.log 2>&1 &\ncaffeinate -si &\necho "ae-poll PID: $!"`;
  Bun.spawnSync(["bash", "-c", cmd], { stdio: ["inherit", "inherit", "inherit"] });
}

// ─── dashboard display ────────────────────────────────────────────────────────

async function showPollDashboard(): Promise<void> {
  const DOTS = ["⋯", " ⋯", "  ⋯"];
  let tick = 0;
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
  process.stdout.write("\x1b[?25l");
  while (true) {
    const state = loadState();
    const entries = Object.values(state.tracked);
    const dot = DOTS[tick % DOTS.length];
    const lines: string[] = [""];
    lines.push(`  \x1b[1maracli poll\x1b[0m — Linear → cmux  \x1b[2m(Ctrl-C to exit, daemon keeps running)\x1b[0m`);
    lines.push("  " + "─".repeat(72));
    if (entries.length === 0) {
      lines.push("  \x1b[2mNo tracked issues — move a Linear issue to In Progress to spawn aracli wt\x1b[0m");
    } else {
      lines.push(`  \x1b[2m${"ISSUE".padEnd(10)} ${"TITLE".padEnd(38)} STATUS\x1b[0m`);
      for (const t of entries) {
        const title = t.title.length > 36 ? t.title.slice(0, 35) + "…" : t.title;
        let status: string;
        if (t.linearState === "in-progress") status = `\x1b[33m${dot} spawning\x1b[0m`;
        else if (t.linearState === "in-review") status = `\x1b[36mPR open  \x1b[2m#${t.prNumber ?? "?"}\x1b[0m`;
        else status = `\x1b[32m✓ done\x1b[0m`;
        lines.push(`  ${t.identifier.padEnd(10)} ${title.padEnd(38)} ${status}`);
        if (t.prNumber && t.linearState !== "in-progress")
          lines.push(`  ${" ".padEnd(10)} \x1b[2mhttps://github.com/Aradotso/Ara/pull/${t.prNumber}\x1b[0m`);
      }
    }
    lines.push("");
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n"));
    tick++;
    await Bun.sleep(3_000);
  }
}

// ─── command ──────────────────────────────────────────────────────────────────

export async function pollCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`aracli poll — Linear → aracli wt → PR lifecycle automation

Usage:
  aracli poll setup          save your personal Linear API key (~/.ae-linear-key)
  aracli poll                start the daemon (run from a cmux terminal, then leave)
  aracli poll status         show currently tracked issues
  aracli poll kill           kill the running daemon

Flow:
  In Progress  →  aracli wt <title>  (creates full cmux workspace)
  PR opened    →  Linear: In Review
  PR merged    →  Linear: Done

Logs: ~/.ae-poll.log   State: ~/.ae-poll-state.json
`);
    return 0;
  }

  if (argv[0] === "setup") {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const key = await new Promise<string>(r => rl.question("Paste your Linear personal API key: ", r));
    rl.close();
    if (!key.startsWith("lin_api_")) { console.error("Invalid key — must start with lin_api_"); return 1; }
    writeFileSync(LOCAL_KEY_FILE, key.trim() + "\n", { mode: 0o600 });
    console.log(`✓ Saved to ~/.ae-linear-key`);
    return 0;
  }

  if (argv[0] === "status" || argv.includes("--status")) {
    const state = loadState();
    const entries = Object.values(state.tracked);
    if (entries.length === 0) { console.log("No tracked issues."); return 0; }
    for (const t of entries) {
      const pr = t.prNumber ? `  PR #${t.prNumber}` : "";
      console.log(`${t.identifier}  [${t.linearState}]${pr}`);
      console.log(`  ${t.title}`);
      console.log(`  branch: ${t.branch}`);
    }
    return 0;
  }

  if (argv[0] === "kill" || argv.includes("--stop") || argv.includes("--uninstall")) {
    Bun.spawnSync(["pkill", "-9", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["pkill", "-9", "caffeinate"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH], { stdout: "pipe", stderr: "pipe" });
    if (existsSync(PLIST_PATH)) Bun.spawnSync(["rm", PLIST_PATH]);
    console.log("aracli poll stopped.");
    return 0;
  }

  // Default (no flags): full setup + start daemon
  const SUBCOMMANDS = new Set(["status", "kill", "setup", "watch", "--stop", "--uninstall", "--status", "--watch", "--loop"]);
  if (argv.length === 0 || !SUBCOMMANDS.has(argv[0])) {
    if (!process.env.CMUX_WORKSPACE_ID) {
      console.error("aracli poll must be run from inside a cmux terminal.");
      return 1;
    }
    let apiKey = getLocalApiKey();
    if (!apiKey) {
      console.log("No personal key found — fetching from Railway (run `aracli poll setup` to set your own)...");
      apiKey = await getApiKeyFromRailway();
    }
    if (!apiKey) {
      console.error("No LINEAR_API_KEY found. Run `aracli poll setup` to save your personal key.");
      return 1;
    }
    // Clear stale in-progress entries so fresh start doesn't retry old spawns
    const stale = loadState();
    const cleaned = Object.fromEntries(
      Object.entries(stale.tracked).filter(([, v]) => v.linearState !== "in-progress")
    );
    saveState({ tracked: cleaned });

    const ws = process.env.CMUX_WORKSPACE_ID;
    let spawnSurface = "";
    let paneRef = "";
    try {
      const pr = Bun.spawnSync([CMUX_BIN, "--json", "list-panes", "--workspace", ws], { stdout: "pipe", stderr: "pipe" });
      if (pr.exitCode === 0) paneRef = JSON.parse(pr.stdout.toString()).panes?.[0]?.ref ?? "";
    } catch {}
    if (paneRef) {
      const r = Bun.spawnSync([CMUX_BIN, "--json", "new-surface", "--type", "terminal", "--pane", paneRef, "--workspace", ws], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode === 0) { try { spawnSurface = JSON.parse(r.stdout.toString()).surface_ref ?? ""; } catch {} }
    }
    if (spawnSurface) {
      // Start a watcher in bash (not zsh — zsh nullglob errors stop the loop).
      // Shows a live feed of spawned issues so the terminal is a useful monitor.
      mkdirSync(TRIGGER_DIR, { recursive: true });
      const watcherCmd = `bash -c 'echo "aracli poll watcher ready"; while :; do for f in ${TRIGGER_DIR}/*.sh; do [ -f "$f" ] || continue; title=$(head -1 "$f" | sed "s/aracli wt //;s/'"'"'//g"); echo "▶ spawning: $title"; bash "$f" && rm -f "$f" && echo "✓ workspace created: $title"; done; sleep 1; done'\n`;
      Bun.spawnSync([CMUX_BIN, "send", "--workspace", ws, "--surface", spawnSurface, watcherCmd]);
      saveCmuxSession(ws, spawnSurface);
    } else {
      saveCmuxSession(ws, process.env.CMUX_SURFACE_ID ?? "");
    }
    // Kill any existing daemon — ensures exactly one instance
    Bun.spawnSync(["pkill", "-9", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(500);
    installAsBackground(apiKey);
    await showPollDashboard();
    return 0;
  }

  if (argv[0] === "watch" || argv.includes("--watch")) {
    // Display-only — aracli start uses this so no duplicate daemon/watcher setup
    await showPollDashboard();
    return 0;
  }

  const apiKey = getLocalApiKey();
  if (!apiKey) {
    console.error("LINEAR_API_KEY not set. Run `aracli poll setup` to save your personal Linear API key.");
    return 1;
  }

  if (argv.includes("--loop")) {
    // Guard: exit if another --loop is already running (prevents duplicate spawns)
    const r = Bun.spawnSync(["pgrep", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
    const pids = r.stdout.toString().trim().split("\n").filter(Boolean).map(Number).filter(p => p !== process.pid);
    if (pids.length > 0) { console.error(`[poll] already running (PIDs: ${pids.join(",")}), exiting`); process.exit(0); }
    process.on("exit", (code) => console.error(`[poll] EXIT code=${code}`));
    process.on("SIGTERM", () => { console.error("[poll] SIGTERM received"); process.exit(0); });
    process.on("SIGINT",  () => { console.error("[poll] SIGINT received");  process.exit(0); });
    process.on("uncaughtException", (e) => console.error("[poll] uncaughtException:", e.message));
    process.on("unhandledRejection", (r) => console.error("[poll] unhandledRejection:", r));
    const userId = await getViewerId(apiKey);
    console.log(`[poll] daemon started — polling every 5s (viewer: ${userId})`);
    while (true) {
      try { await pollOnce(apiKey, userId); }
      catch (e) { console.error("[poll] error:", (e as Error).message); }
      await Bun.sleep(15_000);
    }
  }

  await pollOnce(apiKey);
  return 0;
}
