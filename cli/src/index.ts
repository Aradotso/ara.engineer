#!/usr/bin/env bun
import { wtCommand } from "./commands/wt.ts";
import { listCommand } from "./commands/list.ts";
import { showCommand } from "./commands/show.ts";
import { updateCommand, maybeKickBackgroundCheck, updateBanner } from "./commands/update.ts";
import { listSkills } from "./skills.ts";
import { SHIMS, shimPath } from "./shims.ts";

const VERSION = "0.2.0";

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
    name: "wt",
    summary: "Spawn an Ara worktree + dev env + cmux layout (+ claude in left pane)",
    run: wtCommand,
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
    name: "update",
    summary: "Pull latest ae, reinstall, relink shims (`--check` to only test)",
    run: updateCommand,
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
  // Fire the daily background update check (non-blocking, silent, ≤1/day).
  maybeKickBackgroundCheck();

  const [sub, ...rest] = Bun.argv.slice(2);

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
