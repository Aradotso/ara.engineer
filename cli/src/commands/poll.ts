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
const PLIST_PATH = resolve(homedir(), "Library/LaunchAgents/so.ara.ae-poll.plist");
const PLIST_LABEL = "so.ara.ae-poll";
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

const AE_BIN = Bun.which("ae") ?? resolve(homedir(), ".bun/bin/ae");

function spawnWt(title: string): void {
  // Spawn ae wt directly — it creates its own cmux workspace.
  // CMUX_WORKSPACE_ID just needs to be non-empty to trigger the cmux path in ae wt.
  const child = Bun.spawn([AE_BIN, "wt", title], {
    cwd: ARA_REPO,
    env: {
      ...process.env,
      CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID ?? "poll",
      PATH: `${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: homedir(),
    },
    stdout: Bun.file("/tmp/ae-wt-spawn.log"),
    stderr: Bun.file("/tmp/ae-wt-spawn.log"),
  });
  child.unref(); // don't block the poll loop
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
      spawnWt(issue.title);
      state.tracked[issue.id] = {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        branch,
        spawnedAt: new Date().toISOString(),
        linearState: "in-progress",
      };
    }
  }

  // Persist spawned issues before PR checks (so a gh failure doesn't re-spawn next cycle)
  saveState(state);

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

function writePlist(apiKey: string): void {
  const aePath = Bun.which("ae") ?? "/usr/local/bin/ae";
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>${aePath}</string>
    <string>poll</string>
    <string>--loop</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LINEAR_API_KEY</key><string>${apiKey}</string>
    <key>HOME</key><string>${homedir()}</string>
    <key>PATH</key><string>${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${homedir()}/.ae-poll.log</string>
  <key>StandardErrorPath</key><string>${homedir()}/.ae-poll.log</string>
</dict>
</plist>`);
}

// ─── command ──────────────────────────────────────────────────────────────────

export async function pollCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`ae poll — Linear → ae wt → PR lifecycle automation

Usage:
  ae poll                run once and exit
  ae poll --loop         run every 60s (used by daemon)
  ae poll --install      fetch LINEAR_API_KEY from Railway, install + start launchd agent
  ae poll --uninstall    stop and remove launchd agent
  ae poll --status       show currently tracked issues

Flow:
  In Progress  →  ae wt <title>  (spawns Terminal window with full env)
  PR opened    →  Linear: In Review
  PR merged    →  Linear: Done

Logs (when daemon): ~/.ae-poll.log
State file:         ~/.ae-poll-state.json
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

  if (argv.includes("--uninstall")) {
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH], { stdio: ["inherit", "inherit", "inherit"] });
    if (existsSync(PLIST_PATH)) Bun.spawnSync(["rm", PLIST_PATH]);
    console.log("ae poll uninstalled.");
    return 0;
  }

  if (argv.includes("--install")) {
    let apiKey = process.env.LINEAR_API_KEY ?? null;
    if (!apiKey) {
      console.log("Fetching LINEAR_API_KEY from Railway (ara-api)...");
      apiKey = await getApiKeyFromRailway();
    }
    if (!apiKey) {
      console.error("Could not find LINEAR_API_KEY. Set it in your env or ensure `railway` is linked.");
      return 1;
    }
    writePlist(apiKey);
    // Unload first (idempotent) then load
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH], { stdout: "pipe", stderr: "pipe" });
    const load = Bun.spawnSync(["launchctl", "load", "-w", PLIST_PATH], { stdio: ["inherit", "inherit", "inherit"] });
    if (load.exitCode !== 0) { console.error("launchctl load failed"); return 1; }
    console.log(`✓ ae poll installed and running (with caffeinate -i)`);
    console.log(`  Logs:  tail -f ~/.ae-poll.log`);
    console.log(`  State: ae poll --status`);
    return 0;
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error("LINEAR_API_KEY not set. Run `ae poll --install` to set up the daemon.");
    return 1;
  }

  if (argv.includes("--loop")) {
    console.log(`[poll] daemon started — polling every 60s`);
    while (true) {
      try { await pollOnce(apiKey); }
      catch (e) { console.error("[poll] error:", (e as Error).message); }
      await Bun.sleep(5_000);
    }
  }

  await pollOnce(apiKey);
  return 0;
}
