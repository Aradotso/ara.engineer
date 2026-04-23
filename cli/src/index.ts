#!/usr/bin/env bun
import { wtCommand } from "./commands/wt.ts";
import { prCommand } from "./commands/pr.ts";
import { pollCommand } from "./commands/poll.ts";
import { startCommand } from "./commands/start.ts";
import { prrCommand } from "./commands/prr.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { statusCommand } from "./commands/status.ts";
import { listCommand } from "./commands/list.ts";
import { showCommand } from "./commands/show.ts";
import { updateCommand, maybeKickBackgroundCheck, maybeAutoUpdate, updateBanner } from "./commands/update.ts";
import { urlCommand } from "./commands/url.ts";
import { skillsCommand } from "./commands/skills.ts";
import { tickCommand } from "./commands/tick.ts";
import { listSkills } from "./skills.ts";
import { maybeBootstrapSkills } from "./skills-bootstrap.ts";
import { SHIMS, shimPath } from "./shims.ts";

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { realpathSync } from "node:fs";

const _self = realpathSync(import.meta.url.replace(/^file:\/\//, ""));
const _pkg = JSON.parse(readFileSync(resolve(dirname(_self), "../package.json"), "utf8"));
const [_major, _minor] = ((_pkg.version as string) ?? "0.2").split(".");
const _repoRoot = resolve(dirname(_self), "../..");
const _commitCount = (() => {
  try {
    const r = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: _repoRoot });
    return r.stdout.toString().trim() || "0";
  } catch { return "0"; }
})();
const VERSION = `${_major}.${_minor}.${_commitCount}`;

type NativeCommand = {
  name: string;
  summary: string;
  run: (argv: string[]) => Promise<number | void> | number | void;
};

// Build a native command for each shim — users can invoke them as either
// `ae cc` or the bare `cc` shim on PATH. Both paths exec the same target.
const shimCommands: NativeCommand[] = SHIMS.map((s) => ({
  name: s.name,
  summary: `→ ${s.underlying}`,
  run: async (argv: string[]) => {
    const p = shimPath(s.name);
    if (!p) {
      console.error(`ae ${s.name}: shim missing at cli/shims/${s.name}`);
      return 1;
    }
    const proc = Bun.spawn(["bash", p, ...argv], { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  },
}));

const coreCommands: NativeCommand[] = [
  {
    name: "start",
    summary: "Open ae dashboard: ae status (left 60%) + ae poll + watcher (right)",
    run: startCommand,
  },
  {
    name: "wt",
    summary: "Spawn an Ara worktree + dev env + cmux layout (+ claude in left pane)",
    run: wtCommand,
  },
  {
    name: "status",
    summary: "Dashboard: all agents, ports, URLs, PR state; auto-gc merged worktrees",
    run: statusCommand,
  },
  {
    name: "pr",
    summary: "Create a PR, watch for bot/agent review comments, then auto-fix",
    run: prCommand,
  },
  {
    name: "poll",
    summary: "Watch Linear: spawn ae wt for In Progress issues, track PR → In Review → Done",
    run: pollCommand,
  },
  {
    name: "prr",
    summary: "Fetch PR review comments and fix them with Claude Code",
    run: prrCommand,
  },
  {
    name: "sessions",
    summary: "List or clear your local Ara sandbox sessions",
    run: sessionsCommand,
  },
  {
    name: "list",
    summary: "List all available skills (use `--json` for agents)",
    run: listCommand,
  },
  {
    name: "show",
    summary: "Print a skill's SKILL.md by id (same as `ae <id>`)",
    run: (argv: string[]) => {
      const id = argv[0];
      if (!id) {
        console.error("ae show: missing skill id");
        console.error("Usage: ae show <id> [--json]");
        return 2;
      }
      return showCommand(id, { json: argv.includes("--json") });
    },
  },
  {
    name: "url",
    summary: "Print ngrok URLs for current worktree as clickable hyperlinks",
    run: urlCommand,
  },
  {
    name: "update",
    summary: "Pull latest ae, reinstall, relink shims + skills (`--check` to only test)",
    run: updateCommand,
  },
  {
    name: "skills",
    summary: "Manage ~/.claude/skills symlinks (subcommands: sync, status)",
    run: skillsCommand,
  },
  {
    name: "tick",
    summary: "Fast, silent refresh — wired as a Claude Code PreToolUse/Skill hook",
    run: tickCommand,
  },
];

const natives = [...coreCommands, ...shimCommands];

function printHelp() {
  const skills = listSkills();
  const corePad = Math.max(...coreCommands.map((c) => c.name.length));
  const shimPad = Math.max(...shimCommands.map((c) => c.name.length), 4);

  const banner = updateBanner();
  if (banner) {
    console.log(banner);
    console.log("");
  }

  console.log(`ae ${VERSION} — Ara engineer CLI`);
  console.log("");
  console.log("Usage:");
  console.log("  ae <command> [args...]          run a native command (below)");
  console.log("  ae <skill> [--json]             print a skill's SKILL.md");
  console.log("  ae list [--json]                list every discoverable skill");
  console.log("");
  console.log("Core commands:");
  for (const c of coreCommands) {
    console.log(`  ${c.name.padEnd(corePad)}   ${c.summary}`);
  }
  console.log("");
  console.log("Shortcuts (also linked as bare commands on PATH):");
  for (const c of shimCommands) {
    console.log(`  ${c.name.padEnd(shimPad)}   ${c.summary}`);
  }
  console.log("");
  if (skills.length === 0) {
    console.log("Skills: (none discovered — set AE_SKILLS_ROOT=/path/to/skills)");
  } else {
    const preview = skills.slice(0, 24).map((s) => s.id).join(", ");
    console.log(`Skills (${skills.length}):  ${preview}${skills.length > 24 ? ", …" : ""}`);
  }
  console.log("");
  console.log("Agent-friendly:");
  console.log("  ae list --json                  machine-readable skill catalog");
  console.log("  ae <skill> --json               skill metadata + full body");
  console.log("");
  console.log("Flow:  ae wt <name>  →  ae feat  →  ae test  →  ae push");
  console.log("Docs:  https://ara.engineer");
}

async function main() {
  const argv = Bun.argv.slice(2);

  // First-run bootstrap: silently link this repo's skills into
  // ~/.claude/skills the very first time `ae` runs on this machine (and
  // at most once per day after). Makes `ae` work out of the box without
  // `ae update` / `ae skills sync`.
  maybeBootstrapSkills();

  // Auto-update on every invocation if the cached behind-count > 0.
  // Silent if already up to date. Skips for dev checkouts with local changes.
  // Re-execs the user's command on the fresh code (never returns in that case).
  await maybeAutoUpdate(argv);

  // Background fetch to refresh the cached behind-count (≤1 per 10 min).
  maybeKickBackgroundCheck();

  const [sub, ...rest] = argv;

  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    if (sub === "help" && rest[0]) {
      const name = rest[0];
      const native = natives.find((c) => c.name === name);
      if (native) return (await native.run(["--help"])) ?? 0;
      return showCommand(name);
    }
    printHelp();
    return 0;
  }
  if (sub === "-v" || sub === "--version" || sub === "version") {
    console.log(VERSION);
    return 0;
  }

  const native = natives.find((c) => c.name === sub);
  if (native) {
    const code = await native.run(rest);
    return typeof code === "number" ? code : 0;
  }

  return showCommand(sub, { json: rest.includes("--json") });
}

const exitCode = await main();
process.exit(exitCode ?? 0);
