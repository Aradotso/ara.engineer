// ae start — master dashboard workspace:
//   [ ae status (left 60%) ] [ ae poll live dashboard (right top) ]
//                             [ watcher / spawn logs  (right bottom) ]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

async function cmuxJson(ws: string, args: string[]): Promise<any> {
  const r = Bun.spawnSync(["cmux", "--json", ...args, "--workspace", ws], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`cmux ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return JSON.parse(r.stdout.toString().trim());
}

function cmuxSend(ws: string, surface: string, cmd: string): void {
  Bun.spawnSync(["cmux", "send", "--workspace", ws, "--surface", surface, cmd]);
}

function cmuxCall(args: string[]): void {
  Bun.spawnSync(["cmux", ...args], { stdout: "pipe", stderr: "pipe" });
}

const TRIGGER_DIR = resolve(homedir(), ".ae-poll-triggers");
const SESSION_FILE = resolve(homedir(), ".ae-cmux-session");

export async function startCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`ae start — open the ae dashboard workspace

Layout:
  Left 60%     ae status  (live worktree monitor, redraws every 5s)
  Right top    ae poll    (Linear issue monitor, redraws every 3s)
  Right bottom watcher   (spawn logs — shows ▶ / ✓ per issue)

Usage: ae start
`);
    return 0;
  }

  if (!process.env.CMUX_WORKSPACE_ID) {
    console.error("ae start must be run from inside a cmux terminal.");
    return 1;
  }

  const ae = Bun.which("ae") ?? `${homedir()}/.bun/bin/ae`;

  // ── Kill any stale daemons so we get exactly one ──────────────────────────
  Bun.spawnSync(["pkill", "-9", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["pkill", "-9", "caffeinate"], { stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(400);

  // ── Create workspace ──────────────────────────────────────────────────────
  const wsRaw = Bun.spawnSync(["cmux", "new-workspace", "--name", "ae"], { stdout: "pipe", stderr: "pipe" });
  const wsMatch = wsRaw.stdout.toString().match(/workspace:\S+/);
  if (!wsMatch) { console.error("cmux new-workspace failed"); return 1; }
  const WS = wsMatch[0];

  // Default pane (left)
  const panesData = await cmuxJson(WS, ["list-panes"]);
  const PANE_L = panesData.panes[0].ref as string;
  const SURF_STATUS = panesData.panes[0].surface_refs?.[0] as string;

  // Split right column from left pane
  const trSplit = await cmuxJson(WS, ["new-split", "right", "--panel", PANE_L]);
  const PANE_R   = trSplit.pane_ref as string;
  const TR_DEFAULT = trSplit.surface_ref as string;

  // Split right column: down → creates bottom-right pane, surface in top-right stays as SURF_POLL
  const brSplit  = await cmuxJson(WS, ["new-split", "down", "--panel", PANE_R]);
  const SURF_POLL    = TR_DEFAULT;               // top-right: was created by the horizontal split
  const PANE_BR      = brSplit.pane_ref as string;
  const SURF_WATCHER = brSplit.surface_ref as string; // bottom-right: created by vertical split

  // ── Resize: left ≈ 60%, right-top ≈ 70% of right column ─────────────────
  await Bun.sleep(800);
  cmuxCall(["resize-pane", "--workspace", WS, "--pane", PANE_L, "-R", "--amount", "360"]);
  cmuxCall(["resize-pane", "--workspace", WS, "--pane", PANE_R, "-D", "--amount", "200"]);

  // ── Start watcher in bottom-right ────────────────────────────────────────
  mkdirSync(TRIGGER_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, `${WS} ${SURF_WATCHER}\n`);
  const watcherCmd = `bash -c 'echo "ae poll watcher ready"; while :; do for f in ${TRIGGER_DIR}/*.sh; do [ -f "$f" ] || continue; title=$(head -1 "$f" | sed "s/ae wt //;s/'"'"'//g"); echo "▶ spawning: $title"; bash "$f" && rm -f "$f" && echo "✓ workspace created: $title"; done; sleep 1; done'\n`;
  cmuxSend(WS, SURF_WATCHER, watcherCmd);

  // ── Start ae poll in top-right ───────────────────────────────────────────
  cmuxSend(WS, SURF_POLL, `${ae} poll\n`);

  // ── Start ae status in left pane ─────────────────────────────────────────
  cmuxSend(WS, SURF_STATUS, `${ae} status\n`);

  // Focus left pane
  cmuxCall(["focus-panel", "--panel", SURF_STATUS]);

  console.log(`✓ ae dashboard: ${WS}`);
  console.log(`  left:  ae status`);
  console.log(`  right top:    ae poll`);
  console.log(`  right bottom: watcher`);
  return 0;
}
