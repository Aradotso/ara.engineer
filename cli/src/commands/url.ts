// aracli url — print ngrok URLs for the current worktree as clickable hyperlinks.
//
// Usage:
//   aracli url          show all tunnel URLs for current worktree
//   aracli url app      filter by name (app / mkt / api)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Tunnel = { name: string; addr: number; domain: string };

const LABELS: Record<string, string> = {
  app: "App",
  mkt: "Marketing",
  api: "API",
};

function parseNgrokYml(path: string): Tunnel[] {
  if (!existsSync(path)) return [];
  const tunnels: Tunnel[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s+(\S+):\s*\{[^}]*addr:\s*(\d+)[^}]*domain:\s*([^\s}]+)/);
    if (m) tunnels.push({ name: m[1], addr: parseInt(m[2], 10), domain: m[3].replace(/,.*/, "") });
  }
  return tunnels;
}

// OSC 8 hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\
function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

async function findNgrokYml(): Promise<string | null> {
  // 1. current worktree
  const cwd = process.cwd();
  const local = resolve(cwd, ".ngrok.yml");
  if (existsSync(local)) return local;

  // 2. git common dir (bare repo or worktree root)
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd, stdout: "pipe", stderr: "pipe" });
    const gitDir = proc.stdout.toString().trim();
    if (gitDir) {
      const repoRoot = resolve(gitDir, "..");
      const repoFile = resolve(repoRoot, ".ngrok.yml");
      if (existsSync(repoFile)) return repoFile;
    }
  } catch {}

  return null;
}

export async function urlCommand(argv: string[]): Promise<number> {
  const filter = argv[0]?.toLowerCase();

  const ngrokPath = await findNgrokYml();
  if (!ngrokPath) {
    console.error("aracli url: no .ngrok.yml found in current worktree or repo root");
    return 1;
  }

  const tunnels = parseNgrokYml(ngrokPath);
  if (!tunnels.length) {
    console.error("aracli url: no tunnels found in", ngrokPath);
    return 1;
  }

  const filtered = filter
    ? tunnels.filter((t) => t.name.toLowerCase().includes(filter))
    : tunnels;

  if (!filtered.length) {
    console.error(`aracli url: no tunnel matching "${filter}"`);
    return 1;
  }

  const pad = Math.max(...filtered.map((t) => {
    const key = t.name.split("-")[0];
    return (LABELS[key] ?? t.name).length;
  }));

  for (const t of filtered) {
    const key = t.name.split("-")[0];
    const label = (LABELS[key] ?? t.name).padEnd(pad);
    const url = `https://${t.domain}`;
    console.log(`  ${label}   ${hyperlink(url, url)}`);
  }

  return 0;
}
