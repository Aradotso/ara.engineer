import { listSkills, candidateRoots } from "../skills.ts";

type Args = { json: boolean; help: boolean; verbose: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { json: false, help: false, verbose: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "-v" || a === "--verbose") out.verbose = true;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

export function listCommand(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`aracli list — list all available skills

Usage:
  aracli list [--json] [--verbose]

Flags:
  --json       machine-readable output for agents
  --verbose    show where each skill was discovered

Roots searched (first match per skill id wins):
${candidateRoots().map((r) => `  ${r}`).join("\n")}
`);
    return 0;
  }

  const skills = listSkills();

  if (args.json) {
    console.log(JSON.stringify(
      skills.map((s) => ({ id: s.id, name: s.name, description: s.description, version: s.version, path: s.path, source: s.source })),
      null,
      2,
    ));
    return 0;
  }

  const pad = Math.max(...skills.map((s) => s.id.length), 4);
  console.log(`aracli skills (${skills.length})`);
  console.log("");
  if (args.verbose) {
    console.log(`  ${"ID".padEnd(pad)}   DESCRIPTION                                                      SOURCE`);
  } else {
    console.log(`  ${"ID".padEnd(pad)}   DESCRIPTION`);
  }
  for (const s of skills) {
    const desc = s.description.length > 90 ? s.description.slice(0, 87) + "…" : s.description;
    if (args.verbose) {
      console.log(`  ${s.id.padEnd(pad)}   ${desc.padEnd(90)}  ${s.source}`);
    } else {
      console.log(`  ${s.id.padEnd(pad)}   ${desc}`);
    }
  }
  console.log("");
  console.log(`Invoke any skill with:  aracli <id>`);
  console.log(`JSON for agents:        aracli list --json`);
  return 0;
}
