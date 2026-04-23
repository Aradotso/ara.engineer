// Idempotent installer for the hooks that make aracli's skill-updates feel live
// across BOTH Claude Code and Cursor:
//
//   SessionStart / sessionStart        → `aracli update`   (once per session: pull + sync)
//   PreToolUse/Skill + preToolUse      → `aracli tick`     (fast check on every tool invocation)
//   beforeSubmitPrompt (Cursor)        → `aracli tick`     (covers first prompt in a session)
//
// We merge into ~/.claude/settings.json AND ~/.cursor/hooks.json without touching
// anything else the user has configured. Our entries are marked by a well-known
// command string so re-runs detect "already installed" and are no-ops.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

// These exact strings are what we scan for when deciding "already installed".
// Keep them stable — renaming is a breaking change for existing users.
const HOOK_UPDATE_CMD = "aracli update >/dev/null 2>&1 || true";
const HOOK_TICK_CMD = "aracli tick >/dev/null 2>&1 || true";
const BASH_UPDATE = `bash -lc '${HOOK_UPDATE_CMD}'`;
const BASH_TICK = `bash -lc '${HOOK_TICK_CMD}'`;

// ─── Claude Code hooks (settings.json) ────────────────────────────────────

type ClaudeSettings = {
  hooks?: {
    SessionStart?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>;
    PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function claudeSettingsPath(): string {
  return process.env.AE_CLAUDE_SETTINGS_PATH || resolve(homedir(), ".claude/settings.json");
}

function readJson<T>(path: string): T | {} {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : {};
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

function installClaudeHooks(result: HookInstallResult): void {
  const path = claudeSettingsPath();
  const settings = readJson<ClaudeSettings>(path) as ClaudeSettings;
  settings.hooks = (settings.hooks ?? {}) as NonNullable<ClaudeSettings["hooks"]>;

  let changed = false;

  if (hasCommand(settings.hooks.SessionStart, "aracli update")) {
    result.alreadyPresent.push("claude:SessionStart:aracli-update");
  } else {
    settings.hooks.SessionStart = addGroup(
      settings.hooks.SessionStart as any,
      { hooks: [{ type: "command", command: BASH_UPDATE }] },
    );
    result.installed.push("claude:SessionStart:aracli-update");
    changed = true;
  }

  const pre = settings.hooks.PreToolUse as any[] | undefined;
  const skillGroups = (pre ?? []).filter((g) => (g.matcher ?? "") === "Skill");
  if (hasCommand(skillGroups, "aracli tick")) {
    result.alreadyPresent.push("claude:PreToolUse/Skill:aracli-tick");
  } else {
    settings.hooks.PreToolUse = addGroup(
      settings.hooks.PreToolUse as any,
      { matcher: "Skill", hooks: [{ type: "command", command: BASH_TICK }] },
    );
    result.installed.push("claude:PreToolUse/Skill:aracli-tick");
    changed = true;
  }

  if (!changed) return;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    result.paths.push(path);
  } catch {
    result.skipped = true;
  }
}

// ─── Cursor hooks (hooks.json) ────────────────────────────────────────────
//
// Cursor config format differs slightly from Claude's — it's a flat
// {version,hooks:{eventName:[{command,matcher?}]}} structure, no nested
// "hooks" array inside groups.

type CursorHookEntry = { command: string; matcher?: string };
type CursorHooks = {
  version?: number;
  hooks?: {
    sessionStart?: CursorHookEntry[];
    preToolUse?: CursorHookEntry[];
    beforeSubmitPrompt?: CursorHookEntry[];
    [k: string]: CursorHookEntry[] | undefined;
  };
  [k: string]: unknown;
};

function cursorHooksPath(): string {
  return process.env.AE_CURSOR_HOOKS_PATH || resolve(homedir(), ".cursor/hooks.json");
}

function cursorHasCommand(entries: CursorHookEntry[] | undefined, needle: string): boolean {
  if (!entries) return false;
  return entries.some((e) => (e.command ?? "").includes(needle));
}

function installCursorHooks(result: HookInstallResult): void {
  // Only install for Cursor if Cursor is present (parent dir exists).
  // We don't create ~/.cursor/ for users who don't have Cursor.
  const cursorDir = resolve(homedir(), ".cursor");
  if (!existsSync(cursorDir)) return;

  const path = cursorHooksPath();
  const raw = readJson<CursorHooks>(path) as CursorHooks;
  raw.version = raw.version ?? 1;
  raw.hooks = (raw.hooks ?? {}) as NonNullable<CursorHooks["hooks"]>;

  let changed = false;

  if (cursorHasCommand(raw.hooks.sessionStart, "aracli update")) {
    result.alreadyPresent.push("cursor:sessionStart:aracli-update");
  } else {
    raw.hooks.sessionStart = [...(raw.hooks.sessionStart ?? []), { command: BASH_UPDATE }];
    result.installed.push("cursor:sessionStart:aracli-update");
    changed = true;
  }

  // beforeSubmitPrompt: fires on every user message, so first invocation
  // in a new session gets a fresh tick even if sessionStart hasn't yet
  // completed pulling.
  if (cursorHasCommand(raw.hooks.beforeSubmitPrompt, "aracli tick")) {
    result.alreadyPresent.push("cursor:beforeSubmitPrompt:aracli-tick");
  } else {
    raw.hooks.beforeSubmitPrompt = [...(raw.hooks.beforeSubmitPrompt ?? []), { command: BASH_TICK }];
    result.installed.push("cursor:beforeSubmitPrompt:aracli-tick");
    changed = true;
  }

  if (!changed) return;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
    result.paths.push(path);
  } catch {
    result.skipped = true;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

export type HookInstallResult = {
  installed: string[];
  alreadyPresent: string[];
  skipped: boolean;
  paths: string[];
  // Kept for back-compat — most callers reference result.path[0]-equivalent.
  path?: string;
};

export function ensureHooksInstalled(): HookInstallResult {
  const result: HookInstallResult = {
    installed: [],
    alreadyPresent: [],
    skipped: false,
    paths: [],
  };

  if (process.env.AE_NO_HOOK_INSTALL === "1") {
    result.skipped = true;
    return result;
  }

  installClaudeHooks(result);
  installCursorHooks(result);

  // Legacy single-path field for callers that only want the Claude path.
  result.path = result.paths[0] ?? claudeSettingsPath();
  return result;
}

export function formatHookInstallResult(r: HookInstallResult): string | null {
  if (r.skipped) return null;
  if (r.installed.length === 0) return null;
  return `hooks → ${r.paths.join(" + ")}: added ${r.installed.join(", ")}`;
}
