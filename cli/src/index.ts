#!/usr/bin/env bun
import { wtCommand } from "./commands/wt.ts";
import { listCommand } from "./commands/list.ts";
import { showCommand } from "./commands/show.ts";
import { listSkills } from "./skills.ts";

const VERSION = "0.1.0";

type NativeCommand = {
  name: string;
  summary: string;
  run: (argv: string[]) => Promise<number | void> | number | void;
};

const natives: NativeCommand[] = [
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
];

function printHelp() {
  const skills = listSkills();
  const nativePad = Math.max(...natives.map((c) => c.name.length));
  console.log(`ae ${VERSION} — Ara engineer CLI`);
  console.log("");
  console.log("Usage:");
  console.log("  ae <command> [args...]          run a native command (below)");
  console.log("  ae <skill> [--json]             print a skill's SKILL.md");
  console.log("  ae list [--json]                list every discoverable skill");
  console.log("");
  console.log("Native commands:");
  for (const c of natives) {
    console.log(`  ${c.name.padEnd(nativePad)}   ${c.summary}`);
  }
  console.log("");
  if (skills.length === 0) {
    console.log("Skills: (none discovered — run `bash setup` in an astack checkout,");
    console.log("        or set AE_SKILLS_ROOT=/path/to/skills)");
  } else {
    console.log(`Skills (${skills.length}):  ${skills.map((s) => s.id).join(", ")}`);
  }
  console.log("");
  console.log("Agent-friendly:");
  console.log("  ae list --json                  machine-readable skill catalog");
  console.log("  ae <skill> --json               skill metadata + full body");
  console.log("  ae --help                       this screen");
  console.log("");
  console.log("Flow:  ae wt <name>  →  ae feat  →  ae test  →  ae push");
  console.log("Docs:  https://ara.engineer");
}

async function main() {
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
