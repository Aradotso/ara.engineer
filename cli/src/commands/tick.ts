// `ae tick` — fast, silent poke that keeps a user's global skills current.
//
// Called from Claude Code hooks (PreToolUse/Skill, SessionStart) so every
// slash-command invocation and every new session refreshes against the
// latest ae repo without the user doing anything.
//
// Design: never block for more than a few milliseconds. Skills sync is
// synchronous (pure filesystem ops, <20ms for 20 skills). Git pull is
// deferred to a detached background process when we think we're stale,
// so by the time the user invokes the NEXT skill the new content is
// already on disk via the live symlinks.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { syncSkills } from "../skills-sync.ts";

const STATE_DIR = resolve(homedir(), ".ae");
const BEHIND = resolve(STATE_DIR, "behind");
const LAST_FETCH = resolve(STATE_DIR, "last-update-check");
const LAST_TICK_PULL = resolve(STATE_DIR, "last-tick-pull");
const BG_FETCH_THROTTLE_SEC = 30;        // between synchronous "stale?" checks kicked by tick
const PULL_THROTTLE_SEC = 10;             // minimum gap between spawning detached pulls

function repoRoot(): string {
  const self = realpathSync(import.meta.url.replace(/^file:\/\//, ""));
  // <repo>/cli/src/commands/tick.ts → <repo> is three levels up.
  return resolve(dirname(self), "..", "..", "..");
}

function ageSec(path: string): number {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 1000;
  } catch {
    return Infinity;
  }
}

function readBehind(): number {
  try {
    const n = Number(readFileSync(BEHIND, "utf8").trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function touch(path: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(path, new Date().toISOString());
  } catch {}
}

function kickBackgroundFetch(repo: string): void {
  if (ageSec(LAST_FETCH) < BG_FETCH_THROTTLE_SEC) return;
  touch(LAST_FETCH);
  const script = `cd "${repo}" && git fetch --quiet origin main 2>/dev/null && git rev-list --count HEAD..origin/main > "${BEHIND}" 2>/dev/null || true`;
  try {
    Bun.spawn(["bash", "-c", script], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {}
}

function kickBackgroundPull(repo: string): void {
  if (ageSec(LAST_TICK_PULL) < PULL_THROTTLE_SEC) return;
  touch(LAST_TICK_PULL);
  // Detached `ae update` — re-uses the full pull+install+relink+skills-sync
  // pipeline. Output silenced; orphaned process unref'd.
  try {
    const script = `cd "${repo}/cli" && bun run src/index.ts update >/dev/null 2>&1 || true`;
    Bun.spawn(["bash", "-c", script], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, AE_NO_SKILLS_SYNC: "0", AE_NO_AUTO_UPDATE: "1" },
    }).unref();
  } catch {}
}

export async function tickCommand(argv: string[]): Promise<number> {
  void argv;
  if (process.env.AE_NO_TICK === "1") return 0;

  // 1. Always sync skills synchronously — catches any content the
  //    background pull landed since the last tick. Fast (<20ms).
  try { syncSkills(); } catch {}

  const repo = repoRoot();
  if (!existsSync(resolve(repo, ".git"))) return 0;

  // 2. Kick a background fetch if the cached behind-count is stale.
  kickBackgroundFetch(repo);

  // 3. If we already know we're behind, fire off a detached pull.
  //    Next skill invocation will see the fresh symlink targets.
  if (readBehind() > 0) kickBackgroundPull(repo);

  return 0;
}
