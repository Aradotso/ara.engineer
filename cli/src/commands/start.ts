// ae start — master dashboard workspace:
//   [ ae status (left 60%) ] [ ae poll (right top) ]
//                             [ watcher/spawn logs (right bottom) ]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

async function cmuxJson(args: string[]): Promise<any> {
  const r = Bun.spawnSync(["cmux", "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`cmux ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return JSON.parse(r.stdout.toString().trim());
}

async function cmuxSend(ws: string, surface: string, cmd: string): Promise<void> {
  Bun.spawnSync(["cmux", "send", "--workspace", ws, "--surface", surface, cmd]);
}

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

const TRIGGER_DIR = resolve(homedir(), ".ae-poll-triggers");
const SESSION_FILE = resolve(homedir(), ".ae-cmux-session");
const CMUX_BIN = findCmuxBin();

export async function startCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`ae start — open the ae dashboard workspace

Creates a cmux workspace with:
  Left (60%)     ae status  — live worktree monitor
  Right top      ae poll    — Linear issue monitor
  Right bottom   watcher    — spawn logs

Usage:
  ae start
`);
    return 0;
  }

  if (!process.env.CMUX_WORKSPACE_ID) {
    console.error("ae start must be run from inside a cmux terminal.");
    return 1;
  }

  const ae = Bun.which("ae") ?? `${homedir()}/.bun/bin/ae`;

  // Create a new workspace for the dashboard
  const wsRaw = Bun.spawnSync(["cmux", "new-workspace", "--name", "ae"], { stdout: "pipe", stderr: "pipe" });
  const wsMatch = wsRaw.stdout.toString().match(/workspace:\S+/);
  if (!wsMatch) throw new Error(`cmux new-workspace failed: ${wsRaw.stdout.toString()}`);
  const WS = wsMatch[0];

  // Get default left pane
  const panes = await cmuxJson(["list-panes", "--workspace", WS]);
  const PANE_L = panes.panes[0].ref as string;

  // Split right column from left pane
  const trSplit = await cmuxJson(["new-split", "right", "--workspace", WS, "--panel", PANE_L]);
  const PANE_R = trSplit.pane_ref as string;
  const TR_DEFAULT = trSplit.surface_ref as string;

  // Split right column into top (ae poll) and bottom (watcher)
  const brSplit = await cmuxJson(["new-split", "down", "--workspace", WS, "--panel", PANE_R]);
  const SURF_POLL = brSplit.surface_ref as string; // right-top: this was PANE_R default
  const PANE_BR = brSplit.pane_ref as string;
  const s_watcher = await cmuxJson(["new-surface", "--type", "terminal", "--pane", PANE_BR, "--workspace", WS]);
  const SURF_WATCHER = s_watcher.surface_ref as string;

  // Close the default TR surface (keep only ae poll tab)
  Bun.spawnSync(["cmux", "close-surface", "--workspace", WS, "--surface", TR_DEFAULT]);

  // Resize: left pane ≈ 60% width (grow right by pushing left ~360px on 1440px screen)
  await Bun.sleep(800);
  Bun.spawnSync(["cmux", "resize-pane", "--workspace", WS, "--pane", PANE_L, "-R", "--amount", "360"]);

  // Resize: right top (ae poll) ≈ 70% height of right column
  Bun.spawnSync(["cmux", "resize-pane", "--workspace", WS, "--pane", PANE_R, "-D", "--amount", "200"]);

  // Start watcher in bottom-right (save session so poll daemon can write triggers here)
  mkdirSync(TRIGGER_DIR, { recursive: true });
  const watcherCmd = `bash -c 'echo "ae poll watcher ready"; while :; do for f in ${TRIGGER_DIR}/*.sh; do [ -f "$f" ] || continue; title=$(head -1 "$f" | sed "s/ae wt //;s/'"'"'//g"); echo "▶ spawning: $title"; bash "$f" && rm -f "$f" && echo "✓ workspace created: $title"; done; sleep 1; done'\n`;
  await cmuxSend(WS, SURF_WATCHER, watcherCmd);
  writeFileSync(SESSION_FILE, `${WS} ${SURF_WATCHER}\n`);

  // Start ae status in left pane
  await cmuxSend(WS, TR_DEFAULT === SURF_POLL ? SURF_WATCHER : SURF_POLL, `${ae} poll\n`);

  // Get the left pane's default surface for ae status
  const leftPanes = await cmuxJson(["list-panes", "--workspace", WS]);
  const leftSurface = leftPanes.panes[0].surface_refs?.[0];
  if (leftSurface) {
    await cmuxSend(WS, leftSurface, `${ae} status\n`);
  }

  // Also restart the poll daemon (it may have been killed by ae poll above)
  const LOCAL_KEY_FILE = resolve(homedir(), ".ae-linear-key");
  const apiKey = existsSync(LOCAL_KEY_FILE) ? readFileSync(LOCAL_KEY_FILE, "utf8").trim() : process.env.LINEAR_API_KEY ?? "";
  if (apiKey) {
    Bun.spawnSync(["pkill", "-9", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(300);
    Bun.spawnSync(["bash", "-c", `LINEAR_API_KEY='${apiKey}' '${ae}' poll --loop >> ~/.ae-poll.log 2>&1 & caffeinate -si &`]);
  }

  // Focus the left pane
  Bun.spawnSync(["cmux", "focus-panel", "--panel", leftSurface ?? PANE_L]);

  console.log(`ae dashboard: ${WS}`);
  console.log(`  left:          ae status`);
  console.log(`  right top:     ae poll`);
  console.log(`  right bottom:  watcher`);
  return 0;
}
