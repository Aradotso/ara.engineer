// Skill discovery — enumerate SKILL.md files from a configurable root chain.
//
// Resolution order (first hit that yields >0 skills wins):
//   1. $AE_SKILLS_ROOT                  (explicit override — colon-separated OK)
//   2. ~/.claude/skills/                (where astack/setup symlinks them)
//   3. ~/lab/astack/                    (legacy source of truth, pre-rename)
//   4. ~/lab/ae/                        (future home when skills migrate here)
//   5. <cli>/..                         (sibling layout)
//
// This keeps `ae` standalone: it can be installed anywhere and still find
// every skill the user has locally.

import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

export type Skill = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  path: string;
  dir: string;
  source: string; // which root this skill came from
};

function cliDir(): string {
  const self = realpathSync(import.meta.url.replace(/^file:\/\//, ""));
  // this file: <cli>/src/skills.ts  →  <cli> = one level up from dirname
  return resolve(dirname(self), "..");
}

export function candidateRoots(): string[] {
  const roots: string[] = [];
  const fromEnv = process.env.AE_SKILLS_ROOT;
  if (fromEnv) {
    for (const p of fromEnv.split(":").filter(Boolean)) roots.push(p);
  }
  // New monorepo layout: skills live at <repo>/skills (i.e. <cli>/../skills).
  roots.push(resolve(cliDir(), "..", "skills"));
  // Back-compat: older checkouts had skills under cli/skills.
  roots.push(resolve(cliDir(), "skills"));
  roots.push(resolve(homedir(), ".claude/skills"));
  roots.push(resolve(homedir(), "lab/astack"));
  roots.push(resolve(homedir(), "lab/ae"));
  roots.push(resolve(cliDir(), ".."));
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  return roots.filter((p) => {
    if (!existsSync(p)) return false;
    const key = realpathSync(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Minimal YAML frontmatter parser. Supports: `key: value`, `key: |` + indented
// block, and skips list/object nesting (we only need name/description/version).
function parseFrontmatter(src: string): Record<string, string> {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const body = m[1];
  const out: Record<string, string> = {};
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const [, key, rawValue] = kv;
    let value = rawValue.trim();
    if (value === "|" || value === ">" || value === "") {
      const collected: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i] === "")) {
        collected.push(lines[i].replace(/^ {2}/, ""));
        i++;
      }
      value = collected.join(" ").trim();
    } else {
      value = value.replace(/^["'](.*)["']$/, "$1");
      i++;
    }
    out[key] = value;
  }
  return out;
}

function firstLine(s: string): string {
  const t = s.trim();
  const nl = t.indexOf("\n");
  return (nl === -1 ? t : t.slice(0, nl)).trim();
}

// Fallback description for skills that lack frontmatter: first `# …` heading
// (stripped of leading `#` / `/name —` prefix) or the first non-blank line.
// Skips stray `---` separators or dangling `key:` lines from malformed
// frontmatter so junk never surfaces as a description.
function fallbackDescription(src: string): string {
  const body = src.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "---" || /^[a-z_-]+:\s*\|?$/i.test(line)) continue;
    if (line.startsWith("#")) {
      return line.replace(/^#+\s*/, "").replace(/^\/[\w-]+\s*[—-]\s*/, "");
    }
    return line;
  }
  return "";
}

function readSkillsFromRoot(root: string): Skill[] {
  const skills: Skill[] = [];
  let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "cli" || e.name === "ara.engineer") continue;
    const dir = resolve(root, e.name);
    const skillPath = resolve(dir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const src = readFileSync(skillPath, "utf8");
      const fm = parseFrontmatter(src);
      const description = firstLine(fm.description || "") || fallbackDescription(src);
      skills.push({
        id: e.name,
        name: fm.name || e.name,
        description,
        version: fm.version || null,
        path: skillPath,
        dir,
        source: root,
      });
    } catch {
      // skip unreadable skills
    }
  }

  // Surface the root-level SKILL.md as `astack` (or `ae`) if present.
  const rootSkill = resolve(root, "SKILL.md");
  if (existsSync(rootSkill) && !skills.find((s) => s.id === "astack" || s.id === "ae")) {
    try {
      const src = readFileSync(rootSkill, "utf8");
      const fm = parseFrontmatter(src);
      const description = firstLine(fm.description || "") || fallbackDescription(src) || "Ara engineer skills index";
      skills.push({
        id: fm.name || "astack",
        name: fm.name || "astack",
        description,
        version: fm.version || null,
        path: rootSkill,
        dir: root,
        source: root,
      });
    } catch {}
  }

  return skills;
}

let cached: Skill[] | null = null;

export function listSkills(): Skill[] {
  if (cached) return cached;
  const seen = new Map<string, Skill>();
  for (const root of candidateRoots()) {
    const skills = readSkillsFromRoot(root);
    for (const s of skills) {
      if (!seen.has(s.id)) seen.set(s.id, s);
    }
  }
  cached = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  return cached;
}

export function findSkill(id: string): Skill | null {
  return listSkills().find((s) => s.id === id) ?? null;
}

export function closest(id: string, candidates: string[], max = 3): string[] {
  const scored = candidates.map((c) => ({ c, d: distance(id, c) }));
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, max).filter((s) => s.d <= Math.max(3, Math.floor(id.length / 2))).map((s) => s.c);
}

function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[] = Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

void statSync;
