// `ae update` — pull latest from origin, reinstall bun deps, re-link all
// shims. Works against the repo that backs the currently-installed `ae`
// binary (resolved via the symlink at $(which ae)).

import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { SHIMS } from "../shims.ts";

type Args = { help: boolean; check: boolean; force: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { help: false, check: false, force: false };
  for (const a of argv) {
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--check") out.check = true;
    else if (a === "--force") out.force = true;
  }
  return out;
}

export function repoRoot(): string {
  // This file lives at <repo>/cli/src/commands/update.ts, so <repo> is three
  // levels up from its dir.
  const self = realpathSync(import.meta.url.replace(/^file:\/\//, ""));
  return resolve(dirname(self), "..", "..", "..");
}

async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, stdout, stderr };
}

async function behindCount(repo: string): Promise<number> {
  const fetched = await run(["git", "fetch", "--quiet", "origin", "main"], { cwd: repo });
  if (fetched.code !== 0) return 0;
  const rev = await run(["git", "rev-list", "--count", "HEAD..origin/main"], { cwd: repo });
  if (rev.code !== 0) return 0;
  return Number(rev.stdout.trim()) || 0;
}

async function hasLocalChanges(repo: string): Promise<boolean> {
  const r = await run(["git", "status", "--porcelain"], { cwd: repo });
  return r.stdout.trim().length > 0;
}

function binDir(): string {
  return process.env.AE_BIN_DIR || resolve(homedir(), ".bun/bin");
}

export async function updateCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`ae update — pull latest, reinstall deps, relink shims

Usage:
  ae update               pull + install + relink (refuses if repo is dirty)
  ae update --check       report whether an update is available; no changes
  ae update --force       pull even if the working tree has local changes

This updates the repo at $(dirname $(readlink -f $(which ae)))/../..
`);
    return 0;
  }

  const repo = repoRoot();
  if (!existsSync(resolve(repo, ".git"))) {
    console.error(`ae update: ${repo} is not a git checkout — can't self-update`);
    return 1;
  }

  if (args.check) {
    process.stdout.write(`Checking ${repo} ... `);
    const n = await behindCount(repo);
    if (n === 0) {
      console.log("up to date");
    } else {
      console.log(`${n} commit${n === 1 ? "" : "s"} behind origin/main — run \`ae update\``);
    }
    writeCheckStamp(n);
    return 0;
  }

  if (!args.force && (await hasLocalChanges(repo))) {
    console.error(`ae update: ${repo} has uncommitted changes — refusing to pull.`);
    console.error(`Commit/stash first, or rerun with --force to pull anyway.`);
    return 1;
  }

  console.log(`Pulling in ${repo}`);
  const pull = await run(["git", "pull", "--ff-only", "--quiet", "origin", "main"], { cwd: repo });
  if (pull.code !== 0) {
    console.error(`git pull failed:\n${pull.stderr}`);
    return pull.code;
  }

  console.log("Installing dependencies");
  const install = await run(["bun", "install", "--silent"], { cwd: resolve(repo, "cli") });
  if (install.code !== 0) {
    console.error(`bun install failed:\n${install.stderr}`);
    return install.code;
  }

  console.log("Relinking shims");
  const bin = binDir();
  mkdirSync(bin, { recursive: true });
  // Link ae itself too (covers the case where bin dir was wiped).
  const { symlinkSync, unlinkSync, existsSync: _exists } = await import("node:fs");
  const link = (target: string, alias: string) => {
    const dst = resolve(bin, alias);
    try { if (_exists(dst)) unlinkSync(dst); } catch {}
    symlinkSync(target, dst);
  };
  link(resolve(repo, "cli/bin/ae"), "ae");
  for (const s of SHIMS) {
    const src = resolve(repo, "cli/shims", s.name);
    if (_exists(src)) link(src, s.name);
  }

  writeCheckStamp(0);
  console.log(`\nUpdated. ae --version: ${await currentVersion(repo)}`);
  return 0;
}

async function currentVersion(repo: string): Promise<string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repo, "cli/package.json"), "utf8"));
    return String(pkg.version || "?");
  } catch {
    return "?";
  }
}

// ─── Background update check ─────────────────────────────────────────────────
// Fire-and-forget `git fetch` + write commit-count-behind to ~/.ae/behind.
// Called from the main entry on every invocation; skips if the stamp is
// <24h old, so real cost is ~ one fetch per day.

const STATE_DIR = resolve(homedir(), ".ae");
const STAMP = resolve(STATE_DIR, "last-update-check");
const BEHIND = resolve(STATE_DIR, "behind");

function writeCheckStamp(n: number) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STAMP, new Date().toISOString());
    writeFileSync(BEHIND, String(n));
  } catch {}
}

export function maybeKickBackgroundCheck() {
  if (process.env.AE_NO_UPDATE_CHECK === "1") return;
  let age = Infinity;
  try {
    age = (Date.now() - statSync(STAMP).mtimeMs) / 3_600_000;
  } catch {}
  if (age < 24) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STAMP, new Date().toISOString());
  } catch {
    return; // can't write state — don't spawn
  }
  const repo = repoRoot();
  if (!existsSync(resolve(repo, ".git"))) return;
  // Detached background process: fetch + count, write to BEHIND.
  const script = `cd "${repo}" && git fetch --quiet origin main 2>/dev/null && git rev-list --count HEAD..origin/main > "${BEHIND}" 2>/dev/null || true`;
  try {
    Bun.spawn(["bash", "-c", script], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {}
}

export function updateBanner(): string | null {
  try {
    const n = Number(readFileSync(BEHIND, "utf8").trim());
    if (Number.isFinite(n) && n > 0) {
      return `↑ ae is ${n} commit${n === 1 ? "" : "s"} behind — run \`ae update\` to upgrade.`;
    }
  } catch {}
  return null;
}

void basename;
