import { readFileSync } from "node:fs";
import { findSkill, listSkills, closest } from "../skills.ts";

// `ae <skill-id>` → print the skill's SKILL.md so an agent can load the
// instructions. Also reachable as `ae show <id>`. Unknown ids produce a
// "did you mean" hint.

export function showCommand(id: string, opts: { json?: boolean } = {}): number {
  const skill = findSkill(id);
  if (!skill) {
    const all = listSkills().map((s) => s.id);
    const hints = closest(id, all);
    console.error(`ae: no skill "${id}"`);
    if (hints.length) {
      console.error("");
      console.error("Did you mean:");
      for (const h of hints) console.error(`  ae ${h}`);
    }
    console.error("");
    console.error("See all skills:  ae list");
    return 1;
  }

  if (opts.json) {
    const src = readFileSync(skill.path, "utf8");
    console.log(JSON.stringify({ ...skill, body: src }, null, 2));
    return 0;
  }

  const src = readFileSync(skill.path, "utf8");
  process.stdout.write(src);
  if (!src.endsWith("\n")) process.stdout.write("\n");
  return 0;
}
