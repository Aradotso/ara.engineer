// aracli start — master dashboard workspace:
//   [ aracli status (left 60%) ] [ aracli poll watch (right top)    ]
//                             [ watcher / spawn logs (right bottom) ]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Match the pattern from wt.ts exactly — workspace before panel
async function cmuxJson(args: string[]): Promise<any> {
  const r = Bun.spawnSync(["cmux", "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`cmux ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return JSON.parse(r.stdout.toString().trim());
}

function cmuxSend(ws: string, surface: string, cmd: string): void {
  Bun.spawnSync(["cmux", "send", "--workspace", ws, "--surface", surface, cmd]);
}

const TRIGGER_DIR = resolve(homedir(), ".ae-poll-triggers");
const SESSION_FILE = resolve(homedir(), ".ae-cmux-session");

export async function startCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`aracli start — open the ae dashboard workspace

  Left 60%     aracli status  (live worktree monitor)
  Right top    aracli poll    (Linear issue monitor)
  Right bottom watcher   (spawn logs)

Usage: aracli start
`);
    return 0;
  }

  if (!process.env.CMUX_WORKSPACE_ID) {
    console.error("aracli start must be run from inside a cmux terminal.");
    return 1;
  }

  const ae = Bun.which("ae") ?? `${homedir()}/.bun/bin/ae`;

  // ── Kill stale daemons ────────────────────────────────────────────────────
  Bun.spawnSync(["pkill", "-9", "-f", "index.ts poll --loop"], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["pkill", "-9", "caffeinate"], { stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(400);

  // ── Create workspace ──────────────────────────────────────────────────────
  const wsRaw = Bun.spawnSync(["cmux", "new-workspace", "--name", "ae"], { stdout: "pipe", stderr: "pipe" });
  const wsMatch = wsRaw.stdout.toString().match(/workspace:\S+/);
  if (!wsMatch) { console.error("cmux new-workspace failed"); return 1; }
  const WS = wsMatch[0];

  // ── Get default left pane + surface ──────────────────────────────────────
  const panesData = await cmuxJson(["list-panes", "--workspace", WS]);
  const PANE_L     = panesData.panes[0].ref as string;
  const SURF_STATUS = panesData.panes[0].surface_refs?.[0] as string;

  // ── Split: right column ───────────────────────────────────────────────────
  // --workspace MUST come before --panel (matches aracli wt pattern)
  const trSplit = await cmuxJson(["new-split", "right", "--workspace", WS, "--panel", PANE_L]);
  const PANE_R     = trSplit.pane_ref as string;
  const SURF_POLL  = trSplit.surface_ref as string; // top-right: aracli poll watch

  // ── Split: bottom-right (watcher) ────────────────────────────────────────
  const brSplit    = await cmuxJson(["new-split", "down", "--workspace", WS, "--panel", PANE_R]);
  const SURF_WATCHER = brSplit.surface_ref as string; // bottom-right: watcher logs

  await Bun.sleep(800);

  // ── Watcher in bottom-right ───────────────────────────────────────────────
  mkdirSync(TRIGGER_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, `${WS} ${SURF_WATCHER}\n`);
  const watcherCmd = `bash -c 'echo "aracli poll watcher ready"; while :; do for f in ${TRIGGER_DIR}/*.sh; do [ -f "$f" ] || continue; title=$(head -1 "$f" | sed "s/aracli wt //;s/'"'"'//g"); echo "▶ spawning: $title"; bash "$f" && rm -f "$f" && echo "✓ workspace created: $title"; done; sleep 1; done'\n`;
  cmuxSend(WS, SURF_WATCHER, watcherCmd);

  // ── aracli poll watch in top-right (display only — daemon started separately) ─
  cmuxSend(WS, SURF_POLL, `${ae} poll watch\n`);

  // ── Start daemon (with personal key) ─────────────────────────────────────
  const localKey = resolve(homedir(), ".ae-linear-key");
  const apiKey   = existsSync(localKey) ? readFileSync(localKey, "utf8").trim() : process.env.LINEAR_API_KEY ?? "";
  if (apiKey) {
    Bun.spawnSync(["bash", "-c",
      `LINEAR_API_KEY='${apiKey}' '${ae}' poll --loop >> ~/.ae-poll.log 2>&1 & caffeinate -si &`
    ]);
  } else {
    console.warn("No LINEAR_API_KEY — run `aracli poll setup` to save your key.");
  }

  // ── aracli status in left pane ────────────────────────────────────────────────
  cmuxSend(WS, SURF_STATUS, `${ae} status\n`);

  Bun.spawnSync(["cmux", "focus-panel", "--panel", PANE_L]);

  console.log(`✓ ae  ${WS}`);
  return 0;
}
