// ae status — dashboard of all agent worktrees: ports, URLs, PR state.
//
// Also auto-GCs any worktree whose PR has been merged (kills processes,
// removes ngrok tunnels, prunes the git worktree + branch).
//
// Usage:
//   ae status          show dashboard + auto-gc merged worktrees
//   ae status --gc     same, but also prompt-confirm before each deletion
//   ae status --no-gc  show only, skip gc

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";

type Tunnel = { name: string; addr: number; domain: string };

type WorktreeInfo = {
  path: string;
  name: string;
  branch: string;
  agentN: number | null;
  tunnels: Tunnel[];
  portAlive: Record<number, boolean>;
  gitStatus: "clean" | "dirty" | "unknown";
  prNumber: number | null;
  prState: "none" | "open" | "merged" | "closed" | "draft";
  prUrl: string;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

async function run(cmd: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out: out.trim() };
}

async function resolveRepoRoot(): Promise<string> {
  const r = await run(["git", "rev-parse", "--git-common-dir"]);
  if (r.code === 0 && r.out) return resolve(r.out.trim(), "..");
  return resolve(homedir(), "lab/Ara");
}

function parseNgrokYml(path: string): Tunnel[] {
  if (!existsSync(path)) return [];
  const tunnels: Tunnel[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    // format:  name-N: { proto: http, addr: PORT, domain: DOMAIN }
    const m = line.match(/^\s+(\S+):\s*\{[^}]*addr:\s*(\d+)[^}]*domain:\s*(\S+)/);
    if (m) tunnels.push({ name: m[1], addr: parseInt(m[2], 10), domain: m[3] });
  }
  return tunnels;
}

async function busyPorts(): Promise<Set<number>> {
  const r = await run(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
  const busy = new Set<number>();
  for (const line of r.out.split("\n").slice(1)) {
    const addr = line.split(/\s+/)[8];
    if (!addr) continue;
    const port = parseInt(addr.split(":").pop() ?? "", 10);
    if (!isNaN(port)) busy.add(port);
  }
  return busy;
}

async function gitWorktrees(repoRoot: string): Promise<{ path: string; branch: string }[]> {
  const r = await run(["git", "worktree", "list", "--porcelain"], repoRoot);
  const result: { path: string; branch: string }[] = [];
  let cur: Partial<{ path: string; branch: string }> = {};
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) cur.path = line.slice(9).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace("refs/heads/", "");
    else if (line === "" && cur.path) {
      result.push({ path: cur.path, branch: cur.branch ?? "" });
      cur = {};
    }
  }
  if (cur.path) result.push({ path: cur.path, branch: cur.branch ?? "" });
  return result;
}

async function isDirty(wtPath: string): Promise<boolean> {
  const r = await run(["git", "status", "--porcelain"], wtPath);
  return r.code === 0 && r.out.trim().length > 0;
}

async function getPrInfo(branch: string, repoRoot: string): Promise<{ number: number; state: string; url: string } | null> {
  const r = await run(
    ["gh", "pr", "list", "--head", branch, "--json", "number,state,url,isDraft", "--limit", "1"],
    repoRoot,
  );
  if (r.code !== 0) return null;
  try {
    const arr = JSON.parse(r.out) as { number: number; state: string; url: string; isDraft: boolean }[];
    if (arr.length === 0) {
      // Also check merged PRs
      const r2 = await run(
        ["gh", "pr", "list", "--head", branch, "--state", "merged", "--json", "number,state,url", "--limit", "1"],
        repoRoot,
      );
      if (r2.code === 0) {
        const arr2 = JSON.parse(r2.out) as { number: number; state: string; url: string }[];
        if (arr2.length > 0) return { ...arr2[0], state: "MERGED" };
      }
      return null;
    }
    const pr = arr[0];
    return { number: pr.number, state: pr.isDraft ? "DRAFT" : pr.state, url: pr.url };
  } catch {
    return null;
  }
}

function prStateLabel(state: WorktreeInfo["prState"]): string {
  switch (state) {
    case "none":   return "uncommitted";
    case "draft":  return "draft PR";
    case "open":   return "PR open — waiting";
    case "merged": return "✓ merged";
    case "closed": return "closed";
  }
}

function portLabel(alive: boolean): string {
  return alive ? "●" : "○";
}

// ─── gc: destroy a merged worktree ──────────────────────────────────────────

async function killPort(port: number, label: string): Promise<void> {
  const r = await run(["lsof", "-ti", `tcp:${port}`]);
  if (r.code === 0 && r.out.trim()) {
    for (const pid of r.out.trim().split("\n")) {
      await run(["kill", "-9", pid.trim()]);
    }
    console.log(`     killed pids on :${port} (${label})`);
  }
}

async function gcWorktree(wt: WorktreeInfo, repoRoot: string): Promise<void> {
  console.log(`\n  GC: ${wt.name} (PR #${wt.prNumber} merged)`);

  // 1. Kill ports — from ngrok.yml tunnels if present, otherwise derive from
  //    agent number slot (base + N-1) so manually-deleted worktrees still clean up.
  if (wt.tunnels.length > 0) {
    for (const t of wt.tunnels) {
      await killPort(t.addr, t.name);
      try {
        await fetch(`http://127.0.0.1:4040/api/tunnels/${encodeURIComponent(t.name)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(2000),
        });
        console.log(`     removed ngrok tunnel ${t.name}`);
      } catch {}
    }
  } else if (wt.agentN != null) {
    // No ngrok.yml — derive ports from agent slot
    const slot = wt.agentN - 1;
    await killPort(5173 + slot, `app-${wt.agentN} (derived)`);
    await killPort(3000 + slot, `mkt-${wt.agentN} (derived)`);
    await killPort(4000 + slot, `api-${wt.agentN} (derived)`);
  }

  // 2. Remove git worktree (--force handles missing directory)
  await run(["git", "worktree", "remove", "--force", wt.path], repoRoot);
  console.log(`     removed worktree ${wt.path}`);

  // 3. Delete branch
  if (wt.branch && wt.branch.startsWith("wt/")) {
    await run(["git", "branch", "-D", wt.branch], repoRoot);
    console.log(`     deleted branch ${wt.branch}`);
  }

  console.log(`  ✓ ${wt.name} cleaned up`);
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function statusCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`ae status — dashboard of all agent worktrees

Usage:
  ae status          show all agents + auto-gc merged
  ae status --no-gc  show only, skip cleanup

Columns: agent · branch · app/mkt/api ports (●=up ○=down) · PR state
`);
    return 0;
  }

  const noGc = argv.includes("--no-gc");
  const watch = !argv.includes("--no-watch") && !argv.includes("--once");
  const repoRoot = await resolveRepoRoot();
  const wtRoot = resolve(repoRoot, ".worktrees");

  if (!existsSync(wtRoot)) {
    console.log("No .worktrees/ directory found — run `ae wt <name>` to create one.");
    return 0;
  }

  const [allWts, busy] = await Promise.all([gitWorktrees(repoRoot), busyPorts()]);

  // Only worktrees under .worktrees/ (skip the main tree)
  const agentWts = allWts.filter((w) => w.path.startsWith(wtRoot + "/"));

  // Also prune git's worktree refs for directories that no longer exist
  await run(["git", "worktree", "prune"], repoRoot);

  if (agentWts.length === 0) {
    console.log("No agent worktrees active. Run `ae wt <name>` to create one.");
    return 0;
  }

  // Gather info for each worktree in parallel
  const infos: WorktreeInfo[] = await Promise.all(
    agentWts.map(async (w) => {
      const name = basename(w.path);
      const tunnels = parseNgrokYml(resolve(w.path, ".ngrok.yml"));

      // agent number from branch name wt/wt-<epoch> or from ngrok tunnel name (app-N)
      let agentN: number | null = null;
      const appTunnel = tunnels.find((t) => t.name.startsWith("app-"));
      if (appTunnel) agentN = parseInt(appTunnel.name.replace("app-", ""), 10);

      const portAlive: Record<number, boolean> = {};
      for (const t of tunnels) portAlive[t.addr] = busy.has(t.addr);

      const [dirty, prInfo] = await Promise.all([isDirty(w.path), getPrInfo(w.branch, repoRoot)]);

      let prState: WorktreeInfo["prState"] = "none";
      if (prInfo) {
        const s = prInfo.state.toLowerCase();
        prState = s === "merged" ? "merged" : s === "draft" ? "draft" : s === "open" ? "open" : "closed";
      }

      return {
        path: w.path,
        name,
        branch: w.branch,
        agentN,
        tunnels,
        portAlive,
        gitStatus: dirty ? "dirty" : "clean",
        prNumber: prInfo?.number ?? null,
        prState,
        prUrl: prInfo?.url ?? "",
      } satisfies WorktreeInfo;
    }),
  );

  // ─── Print dashboard ────────────────────────────────────────────────────

  console.log("");
  console.log(`  ${"AGENT".padEnd(12)} ${"BRANCH".padEnd(30)} ${"APP".padEnd(6)} ${"MKT".padEnd(6)} ${"API".padEnd(6)} STATUS`);
  console.log("  " + "─".repeat(80));

  for (const wt of infos) {
    const label = wt.agentN != null ? `agent-${wt.agentN}` : wt.name.slice(0, 12);
    const branch = wt.branch.length > 28 ? wt.branch.slice(0, 27) + "…" : wt.branch;
    const appT = wt.tunnels.find((t) => t.name.startsWith("app-"));
    const mktT = wt.tunnels.find((t) => t.name.startsWith("mkt-"));
    const apiT = wt.tunnels.find((t) => t.name.startsWith("api-"));
    const appS = appT ? portLabel(wt.portAlive[appT.addr]) : " ";
    const mktS = mktT ? portLabel(wt.portAlive[mktT.addr]) : " ";
    const apiS = apiT ? portLabel(wt.portAlive[apiT.addr]) : " ";
    const statusStr = prStateLabel(wt.prState) + (wt.gitStatus === "dirty" ? " *" : "");
    const prTag = wt.prNumber ? ` #${wt.prNumber}` : "";

    console.log(`  ${label.padEnd(12)} ${branch.padEnd(30)} ${appS.padEnd(6)} ${mktS.padEnd(6)} ${apiS.padEnd(6)} ${statusStr}${prTag}`);

    if (appT) console.log(`  ${"".padEnd(12)} app  https://${appT.domain}  :${appT.addr}`);
    if (mktT) console.log(`  ${"".padEnd(12)} mkt  https://${mktT.domain}  :${mktT.addr}`);
    if (apiT) console.log(`  ${"".padEnd(12)} api  https://${apiT.domain}  :${apiT.addr}`);
    if (wt.prUrl) console.log(`  ${"".padEnd(12)} pr   ${wt.prUrl}`);
    console.log("");
  }

  // ─── Auto-gc merged + abandoned worktrees ──────────────────────────────

  // Abandoned = all ports dead + no open/draft PR
  const abandoned = infos.filter((w) =>
    w.prState === "none" &&
    w.tunnels.length > 0 &&
    w.tunnels.every((t) => !w.portAlive[t.addr])
  );

  const merged = infos.filter((w) => w.prState === "merged");
  const toGc = [...merged, ...abandoned];
  if (!noGc && toGc.length > 0) {
    if (merged.length > 0) console.log(`  ${merged.length} merged worktree(s) — cleaning up…`);
    if (abandoned.length > 0) console.log(`  ${abandoned.length} abandoned worktree(s) (ports dead, no PR) — cleaning up…`);
    for (const wt of toGc) await gcWorktree(wt, repoRoot);
    console.log("");
  }

  if (!watch) return 0;

  // Live mode — redraw every 5s until Ctrl-C
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
  process.stdout.write("\x1b[?25l");
  while (true) {
    await Bun.sleep(5_000);
    const [allWts2, busy2] = await Promise.all([gitWorktrees(repoRoot), busyPorts()]);
    const agentWts2 = allWts2.filter((w) => w.path.startsWith(wtRoot + "/"));
    if (agentWts2.length === 0) { process.stdout.write("\x1b[2J\x1b[H\n  No agent worktrees active.\n"); continue; }
    const infos2: WorktreeInfo[] = await Promise.all(agentWts2.map(async (w) => {
      const name = basename(w.path);
      const tunnels = parseNgrokYml(resolve(w.path, ".ngrok.yml"));
      let agentN: number | null = null;
      const appTunnel = tunnels.find((t) => t.name.startsWith("app-"));
      if (appTunnel) agentN = parseInt(appTunnel.name.replace("app-", ""), 10);
      const portAlive: Record<number, boolean> = {};
      for (const t of tunnels) portAlive[t.addr] = busy2.has(t.addr);
      const [dirty, prInfo] = await Promise.all([isDirty(w.path), getPrInfo(w.branch, repoRoot)]);
      let prState: WorktreeInfo["prState"] = "none";
      if (prInfo) { const s = prInfo.state.toLowerCase(); prState = s === "merged" ? "merged" : s === "draft" ? "draft" : s === "open" ? "open" : "closed"; }
      return { path: w.path, name, branch: w.branch, agentN, tunnels, portAlive, gitStatus: dirty ? "dirty" : "clean", prNumber: prInfo?.number ?? null, prState, prUrl: prInfo?.url ?? "" } satisfies WorktreeInfo;
    }));
    const lines: string[] = ["", `  \x1b[1mae status\x1b[0m  \x1b[2m(Ctrl-C to exit)\x1b[0m`, "  " + "─".repeat(80), `  \x1b[2m${"AGENT".padEnd(12)} ${"BRANCH".padEnd(30)} ${"APP".padEnd(6)} ${"MKT".padEnd(6)} ${"API".padEnd(6)} STATUS\x1b[0m`, "  " + "─".repeat(80)];
    for (const wt of infos2) {
      const label = wt.agentN != null ? `agent-${wt.agentN}` : wt.name.slice(0, 12);
      const branch = wt.branch.length > 28 ? wt.branch.slice(0, 27) + "…" : wt.branch;
      const appT = wt.tunnels.find((t) => t.name.startsWith("app-")); const mktT = wt.tunnels.find((t) => t.name.startsWith("mkt-")); const apiT = wt.tunnels.find((t) => t.name.startsWith("api-"));
      const appS = appT ? portLabel(wt.portAlive[appT.addr]) : " "; const mktS = mktT ? portLabel(wt.portAlive[mktT.addr]) : " "; const apiS = apiT ? portLabel(wt.portAlive[apiT.addr]) : " ";
      const statusStr = prStateLabel(wt.prState) + (wt.gitStatus === "dirty" ? " *" : ""); const prTag = wt.prNumber ? ` #${wt.prNumber}` : "";
      lines.push(`  ${label.padEnd(12)} ${branch.padEnd(30)} ${appS.padEnd(6)} ${mktS.padEnd(6)} ${apiS.padEnd(6)} ${statusStr}${prTag}`);
      if (appT) lines.push(`  ${" ".padEnd(12)} app  https://${appT.domain}  :${appT.addr}`);
      if (mktT) lines.push(`  ${" ".padEnd(12)} mkt  https://${mktT.domain}  :${mktT.addr}`);
      if (apiT) lines.push(`  ${" ".padEnd(12)} api  https://${apiT.domain}  :${apiT.addr}`);
      if (wt.prUrl) lines.push(`  ${" ".padEnd(12)} pr   ${wt.prUrl}`);
      lines.push("");
    }
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n"));
  }
}
