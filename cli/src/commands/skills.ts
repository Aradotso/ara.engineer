// `aracli skills` — explicit management of the ~/.claude/skills/ symlinks we own.
//
// Subcommands:
//   aracli skills sync      link every repo skill into ~/.claude/skills (idempotent)
//   aracli skills status    show what's linked, preserved, or missing
//
// `aracli update` runs `sync` automatically at the end, so most users never need
// to touch this directly.

import { readdirSync, existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { syncSkills, formatSyncResult, sourceSkillsDir, targetSkillsDir } from "../skills-sync.ts";

function runSync(): number {
  const r = syncSkills();
  const line = formatSyncResult(r);
  if (line) {
    console.log(line);
  } else {
    console.log(`skills → ~/.claude/skills: up to date (${r.alreadyLinked.length} linked)`);
  }
  return 0;
}

function runStatus(): number {
  const src = sourceSkillsDir();
  const dst = targetSkillsDir();
  if (!existsSync(src)) {
    console.error(`aracli skills: no skills dir at ${src}`);
    return 1;
  }

  const srcAbs = realpathSync(src);
  const ours = new Set<string>();
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (!(e.isDirectory() || e.isSymbolicLink())) continue;
    if (e.name.startsWith(".")) continue;
    if (!existsSync(resolve(src, e.name, "SKILL.md"))) continue;
    ours.add(e.name);
  }

  type Row = { name: string; status: string; detail: string };
  const rows: Row[] = [];
  for (const name of [...ours].sort()) {
    const to = resolve(dst, name);
    let st: { isSymbolicLink: () => boolean } | null = null;
    try { st = lstatSync(to); } catch {}
    if (!st) {
      rows.push({ name, status: "missing", detail: "(not linked — run `aracli skills sync`)" });
      continue;
    }
    if (!st.isSymbolicLink()) {
      rows.push({ name, status: "preserved", detail: "(real dir — not managed by ae)" });
      continue;
    }
    const working = existsSync(to);
    if (!working) {
      rows.push({ name, status: "broken", detail: `(→ ${readlinkSync(to)})` });
      continue;
    }
    const rp = realpathSync(to);
    const inUs = rp === srcAbs || rp.startsWith(srcAbs + "/");
    if (inUs) {
      rows.push({ name, status: "linked", detail: "" });
    } else {
      rows.push({ name, status: "foreign", detail: `(→ ${rp})` });
    }
  }

  const pad = Math.max(...rows.map((r) => r.name.length), 4);
  for (const r of rows) {
    const tag = r.status.padEnd(9);
    console.log(`  ${r.name.padEnd(pad)}  ${tag}  ${r.detail}`);
  }
  console.log("");
  console.log(`source: ${src}`);
  console.log(`target: ${dst}`);
  return 0;
}

function printHelp() {
  console.log(`aracli skills — manage ~/.claude/skills symlinks into this ae repo

Usage:
  aracli skills sync     link every repo skill into ~/.claude/skills (idempotent)
  aracli skills status   show per-skill status (linked / preserved / missing / broken)

\`aracli update\` runs \`sync\` automatically.
`);
}

export async function skillsCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  void rest;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printHelp();
    return 0;
  }
  if (sub === "sync") return runSync();
  if (sub === "status" || sub === "list") return runStatus();
  console.error(`aracli skills: unknown subcommand '${sub}'`);
  printHelp();
  return 2;
}
