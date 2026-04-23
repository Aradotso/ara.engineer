// First-run skills sync. The first time `ae` runs on a machine (and once a
// day thereafter) we silently link the repo's skills into ~/.claude/skills
// so a fresh install is immediately useful — the user shouldn't have to run
// `aracli update` / `aracli skills sync` just to get the skills.
//
// Keeps its own stamp so we don't walk the filesystem on every invocation.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { syncSkills, formatSyncResult } from "./skills-sync.ts";
import { ensureHooksInstalled, formatHookInstallResult } from "./hooks-install.ts";

const STATE_DIR = resolve(homedir(), ".ae");
const STAMP = resolve(STATE_DIR, "skills-synced");
const THROTTLE_HOURS = 24;

export function maybeBootstrapSkills(): void {
  if (process.env.AE_NO_SKILLS_SYNC === "1") return;
  if (process.env.AE_UPDATED === "1") return; // just re-exec'd, skip double-work

  let ageHours = Infinity;
  try {
    ageHours = (Date.now() - statSync(STAMP).mtimeMs) / (1000 * 60 * 60);
  } catch {}
  if (ageHours < THROTTLE_HOURS) return;

  try {
    const r = syncSkills();
    const line = formatSyncResult(r);
    if (line) process.stderr.write(`${line}\n`);

    // Also install Claude Code hooks so future skill invocations + session
    // starts auto-refresh against the latest ae. Idempotent — skipped once
    // they're present. Runs at most once per 24h (same stamp as skills).
    const hookRes = ensureHooksInstalled();
    const hookLine = formatHookInstallResult(hookRes);
    if (hookLine) process.stderr.write(`${hookLine}\n`);

    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STAMP, new Date().toISOString());
    } catch {}
  } catch {
    // Never fail ae because of a bootstrap hiccup.
  }
}

// Unused helper kept so future code can force-reset the stamp in tests.
export function _stampPath(): string { return STAMP; }
export function _readStamp(): string | null {
  try { return readFileSync(STAMP, "utf8"); } catch { return null; }
}
