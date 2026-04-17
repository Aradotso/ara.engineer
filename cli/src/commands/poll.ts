// ae poll — watch Linear for In Progress issues assigned to Adi, spawn ae wt,
// then track PR lifecycle: open → In Review, merged → Done.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// ─── hardcoded Linear IDs (Ara workspace) ────────────────────────────────────
const LINEAR_USER_ID = "a6217c40-e40f-4cb6-8608-814a2ff16083";
const STATE_IN_PROGRESS = "414a4dc5-5be4-4144-b912-fc2412dab51c";
const STATE_IN_REVIEW = "ef4c2075-b93d-4a8a-87c2-0b2d632481a7";
const STATE_DONE = "2d48ea35-d79a-47fb-a3f1-c94fb29e2592";

const STATE_FILE = resolve(homedir(), ".ae-poll-state.json");
const PLIST_PATH = resolve(homedir(), "Library/LaunchAgents/so.ara.ae-poll.plist"); // kept for --uninstall cleanup
const ARA_REPO = resolve(homedir(), "github/Ara");

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
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json() as any;
  if (json.errors) throw new Error(json.errors[0]?.message ?? "Linear API error");
  return json.data;
}

async function getInProgressIssues(apiKey: string): Promise<Array<{ id: string; identifier: string; title: string }>> {
  const data = await linearGql(apiKey, `{
    issues(filter: {
      assignee: { id: { eq: "${LINEAR_USER_ID}" } }
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
  const repoDir = existsSync(ARA_REPO) ? ARA_REPO : process.cwd();
  try {
    const r = Bun.spawnSync(
      [GH_BIN, "pr", "list", "--head", branch, "--json", "number,state", "--limit", "1"],
      { stdout: "pipe", stderr: "pipe", cwd: repoDir },
    );
    if (r.exitCode !== 0) return null;
    const prs = JSON.parse(r.stdout.toString().trim()) as Array<{ number: number; state: string }>;
    return prs[0] ?? null;
  } catch { return null; }
}

const SPAWN_PATH = [
  `${homedir()}/.bun/bin`,
  `${homedir()}/.local/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
  "/Applications/cmux.app/Contents/Resources/bin",
].join(":");

const SESSION_FILE = resolve(homedir(), ".ae-cmux-session");
const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

function loadCmuxSession(): { ws: string; surface: string } | null {
  try {
    const [ws, surface] = readFileSync(SESSION_FILE, "utf8").trim().split(" ");
    return ws && surface ? { ws, surface } : null;
  } catch { return null; }
}

function saveCmuxSession(ws: string, surface: string): void {
  writeFileSync(SESSION_FILE, `${ws} ${surface}\n`);
}

function spawnWt(title: string): void {
  const safe = title.replace(/'/g, "'\\''").replace(/"/g, '\\"');
  const ae = Bun.which("ae") ?? `${homedir()}/.bun/bin/ae`;
  const session = loadCmuxSession();

  if (session) {
    // cmux send works from background processes — inject ae wt into an existing shell
    const cmd = `ae wt '${safe}'\n`;
    const r = Bun.spawnSync([CMUX_BIN, "send", "--workspace", session.ws, "--surface", session.surface, cmd],
      { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) { console.log(`[poll] ✓ ae wt injected to cmux surface ${session.surface}`); return; }
    console.warn(`[poll] cmux send failed (${r.exitCode}): ${r.stderr.toString().trim()}`);
  }

  // Fallback: background bash (services only, no cmux layout)
  const cmd = `cd '${ARA_REPO}'; ${ae} wt '${safe}' >> /tmp/ae-wt-spawn.log 2>&1`;
  Bun.spawnSync(["bash", "-c", `${cmd} &`]);
}

// ─── core poll ────────────────────────────────────────────────────────────────

async function pollOnce(apiKey: string): Promise<void> {
  const state = loadState();

  const activeIssues = await getInProgressIssues(apiKey);
  const activeIds = new Set(activeIssues.map(i => i.id));

  // Spawn ae wt for any newly In Progress issues
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

async function getApiKeyFromRailway(): Promise<string | null> {
  try {
    // `railway run` injects Railway env vars — grab LINEAR_API_KEY from ara-api
    const r = Bun.spawnSync(
      ["railway", "run", "--service", "ara-api", "--environment", "prd", "--", "bash", "-c", "printf '%s' \"$LINEAR_API_KEY\""],
      { stdout: "pipe", stderr: "pipe", cwd: ARA_REPO },
    );
    const val = r.stdout.toString().trim();
    return val || null;
  } catch { return null; }
}

function installAsBackground(apiKey: string): void {
  // Run without nohup — cmux checks process credentials and rejects nohup-detached processes.
  // Running as a direct background job keeps us in the cmux process hierarchy.
  // We use disown to detach from the shell's job table without losing cmux credentials.
  const ae = Bun.which("ae") ?? `${homedir()}/.bun/bin/ae`;
  // caffeinate -si: -s prevents system sleep (AC only), -i prevents idle sleep
  const cmd = `caffeinate -si '${ae}' poll --loop >> ~/.ae-poll.log 2>&1 & disown\necho "ae-poll PID: $!"`;
  // (replace LINEAR_API_KEY inline so it's visible to the process)
  const finalCmd = cmd.replace("caffeinate", `LINEAR_API_KEY='${apiKey}' caffeinate`);
  Bun.spawnSync(["bash", "-c", finalCmd], { stdio: ["inherit", "inherit", "inherit"] });
}

// ─── command ──────────────────────────────────────────────────────────────────

export async function pollCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`ae poll — Linear → ae wt → PR lifecycle automation

Usage:
  ae poll                start the daemon (run from a cmux terminal, then leave)
  ae poll --stop         kill the running daemon
  ae poll --status       show currently tracked issues

Flow:
  In Progress  →  ae wt <title>  (creates full cmux workspace)
  PR opened    →  Linear: In Review
  PR merged    →  Linear: Done

Logs: ~/.ae-poll.log   State: ~/.ae-poll-state.json
`);
    return 0;
  }

  if (argv.includes("--status")) {
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

  if (argv.includes("--stop") || argv.includes("--uninstall")) {
    Bun.spawnSync(["pkill", "-9", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH], { stdout: "pipe", stderr: "pipe" });
    if (existsSync(PLIST_PATH)) Bun.spawnSync(["rm", PLIST_PATH]);
    console.log("ae poll stopped.");
    return 0;
  }

  // Default (no flags): full setup + start daemon
  if (!argv.includes("--loop")) {
    if (!process.env.CMUX_WORKSPACE_ID) {
      console.error("ae poll must be run from inside a cmux terminal.");
      return 1;
    }
    let apiKey = process.env.LINEAR_API_KEY ?? null;
    if (!apiKey) {
      console.log("Fetching LINEAR_API_KEY from Railway (ara-api)...");
      apiKey = await getApiKeyFromRailway();
    }
    if (!apiKey) {
      console.error("Could not find LINEAR_API_KEY. Set it in your env or ensure `railway` is linked.");
      return 1;
    }
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
      Bun.spawnSync([CMUX_BIN, "send", "--workspace", ws, "--surface", spawnSurface, "\n"]);
      saveCmuxSession(ws, spawnSurface);
    } else {
      saveCmuxSession(ws, process.env.CMUX_SURFACE_ID ?? "");
    }
    Bun.spawnSync(["pkill", "-9", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
    installAsBackground(apiKey);
    console.log(`✓ ae poll running — move a Linear issue to In Progress to spawn ae wt`);
    console.log(`  Logs:  tail -f ~/.ae-poll.log`);
    return 0;
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error("LINEAR_API_KEY not set.");
    return 1;
  }

  if (argv.includes("--loop")) {
    process.on("exit", (code) => console.error(`[poll] EXIT code=${code}`));
    process.on("SIGTERM", () => { console.error("[poll] SIGTERM received"); process.exit(0); });
    process.on("SIGINT",  () => { console.error("[poll] SIGINT received");  process.exit(0); });
    process.on("uncaughtException", (e) => console.error("[poll] uncaughtException:", e.message));
    process.on("unhandledRejection", (r) => console.error("[poll] unhandledRejection:", r));
    console.log(`[poll] daemon started — polling every 5s`);
    while (true) {
      try { await pollOnce(apiKey); }
      catch (e) { console.error("[poll] error:", (e as Error).message); }
      await Bun.sleep(5_000);
    }
  }

  await pollOnce(apiKey);
  return 0;
}
