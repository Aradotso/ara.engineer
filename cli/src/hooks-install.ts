// Idempotent installer for the Claude Code hooks that make ae's skill-updates
// feel live:
//
//   SessionStart        → `ae update`    (once per session, pulls + syncs)
//   PreToolUse / Skill  → `ae tick`      (fast, kicks bg refresh every time a
//                                          slash-command skill is invoked)
//
// We merge into the user's ~/.claude/settings.json without touching anything
// else they've configured there. Our hook entries are marked by a well-known
// command string so a re-run detects "already installed" and is a no-op.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

// These exact strings are what we scan for when deciding "already installed".
// Keep them stable — renaming is a breaking change for existing users.
const HOOK_UPDATE_CMD = "ae update >/dev/null 2>&1 || true";
const HOOK_TICK_CMD = "ae tick >/dev/null 2>&1 || true";

type SettingsFile = {
  hooks?: {
    SessionStart?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>;
    PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function settingsPath(): string {
  return process.env.AE_CLAUDE_SETTINGS_PATH || resolve(homedir(), ".claude/settings.json");
}

function readSettings(path: string): SettingsFile {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as SettingsFile) : {};
  } catch {
    return {};
  }
}

function hasCommand(
  groups: Array<{ hooks?: Array<{ command?: string }> }> | undefined,
  needle: string,
): boolean {
  if (!groups) return false;
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if ((h.command ?? "").includes(needle)) return true;
    }
  }
  return false;
}

function addGroup(
  groups: Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }> | undefined,
  group: { matcher?: string; hooks: Array<{ type: string; command: string }> },
) {
  if (!groups) return [group];
  return [...groups, group];
}

export type HookInstallResult = {
  installed: string[];     // hooks we added this run
  alreadyPresent: string[];// hooks that were already installed
  skipped: boolean;        // true if we bailed (env var or write error)
  path: string;
};

export function ensureHooksInstalled(): HookInstallResult {
  const path = settingsPath();
  const result: HookInstallResult = { installed: [], alreadyPresent: [], skipped: false, path };

  if (process.env.AE_NO_HOOK_INSTALL === "1") {
    result.skipped = true;
    return result;
  }

  const settings = readSettings(path);
  settings.hooks = (settings.hooks ?? {}) as NonNullable<SettingsFile["hooks"]>;

  // SessionStart: `ae update`
  if (hasCommand(settings.hooks.SessionStart, "ae update")) {
    result.alreadyPresent.push("SessionStart:ae-update");
  } else {
    settings.hooks.SessionStart = addGroup(
      settings.hooks.SessionStart as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }> | undefined,
      { hooks: [{ type: "command", command: `bash -lc '${HOOK_UPDATE_CMD}'` }] },
    );
    result.installed.push("SessionStart:ae-update");
  }

  // PreToolUse / Skill: `ae tick`
  const pre = (settings.hooks.PreToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> | undefined) ?? [];
  const skillGroups = pre.filter((g) => (g.matcher ?? "") === "Skill");
  if (hasCommand(skillGroups, "ae tick")) {
    result.alreadyPresent.push("PreToolUse/Skill:ae-tick");
  } else {
    settings.hooks.PreToolUse = addGroup(
      settings.hooks.PreToolUse as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }> | undefined,
      { matcher: "Skill", hooks: [{ type: "command", command: `bash -lc '${HOOK_TICK_CMD}'` }] },
    );
    result.installed.push("PreToolUse/Skill:ae-tick");
  }

  if (result.installed.length === 0) return result;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    result.skipped = true;
    return result;
  }
  return result;
}

export function formatHookInstallResult(r: HookInstallResult): string | null {
  if (r.skipped) return null;
  if (r.installed.length === 0) return null;
  return `hooks → ${r.path}: added ${r.installed.join(", ")}`;
}
