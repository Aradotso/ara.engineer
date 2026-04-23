// Sync <repo>/cli/skills/* into ~/.claude/skills/* via symlinks so Claude
// Code discovers every ae skill globally (anywhere on the user's machine,
// not just inside this repo). Called by `aracli update` and once on first
// install so the user never has to think about it.
//
// Rules:
//   - Real dirs / files we never clobber (user's own skills are safe).
//   - Foreign symlinks (pointing outside this repo and still working) are
//     preserved — could be the user's own managed link.
//   - Broken symlinks OR symlinks already pointing into this repo → replaced
//     with a fresh link to the current skill dir.
//   - After linking, prune dead symlinks that USED to point into this repo
//     but the skill has been renamed/removed upstream.
//
// Idempotent — running it twice is a no-op (everything reports "already
// linked"). Never errors out on a single-entry failure — skips and moves on.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

export type SyncResult = {
  linked: string[];     // newly-created symlinks
  replaced: string[];   // replaced a broken / ae-owned symlink
  preserved: string[];  // skipped — real dir or foreign working symlink
  pruned: string[];     // removed a dead symlink that pointed into ae
  alreadyLinked: string[];
};

export function targetSkillsDir(): string {
  return process.env.AE_TARGET_SKILLS_DIR || resolve(homedir(), ".claude/skills");
}

export function sourceSkillsDir(): string {
  // This file lives at <repo>/cli/src/skills-sync.ts. After the monorepo
  // unification, skills/ is a top-level sibling of cli/.
  const self = realpathSync(import.meta.url.replace(/^file:\/\//, ""));
  const repoRoot = resolve(dirname(self), "..", "..");
  const newLayout = resolve(repoRoot, "skills");
  const oldLayout = resolve(dirname(self), "..", "skills");
  // Pre-unify installs that haven't pulled yet still have cli/skills/ and
  // nothing at root. Keep the fallback so a one-off `aracli list` on an old
  // checkout doesn't look empty.
  if (existsSync(newLayout)) {
    // Post-unify: sweep the stale cli/skills/ if it's still there as leftover.
    if (existsSync(oldLayout)) {
      try { rmSync(oldLayout, { recursive: true, force: true }); } catch {}
    }
    return newLayout;
  }
  return oldLayout;
}

function classify(path: string): "none" | "symlink" | "real" {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "symlink" : "real";
  } catch {
    return "none";
  }
}

function pointsInto(symlinkPath: string, rootAbs: string): { working: boolean; pointsIntoRoot: boolean } {
  const working = existsSync(symlinkPath);
  if (working) {
    try {
      const rp = realpathSync(symlinkPath);
      return { working: true, pointsIntoRoot: rp === rootAbs || rp.startsWith(rootAbs + "/") };
    } catch {
      return { working: false, pointsIntoRoot: false };
    }
  }
  // Broken symlink — inspect the raw target string for a best-effort
  // "was this ever ours" check used by prune logic.
  try {
    const raw = readlinkSync(symlinkPath);
    const abs = resolve(dirname(symlinkPath), raw);
    return { working: false, pointsIntoRoot: abs === rootAbs || abs.startsWith(rootAbs + "/") };
  } catch {
    return { working: false, pointsIntoRoot: false };
  }
}

export function syncSkills(): SyncResult {
  const result: SyncResult = {
    linked: [],
    replaced: [],
    preserved: [],
    pruned: [],
    alreadyLinked: [],
  };

  const src = sourceSkillsDir();
  const dst = targetSkillsDir();

  if (!existsSync(src)) return result;
  try { mkdirSync(dst, { recursive: true }); } catch { return result; }

  const srcAbs = realpathSync(src);

  // 1. Enumerate skills shipped in this ae repo (dirs with SKILL.md).
  const ours = new Set<string>();
  let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[] = [];
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".")) continue;
    const skillMd = resolve(src, e.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    ours.add(e.name);
  }

  // 2. Link each skill into ~/.claude/skills.
  for (const name of ours) {
    const from = resolve(src, name);
    const to = resolve(dst, name);
    const kind = classify(to);

    if (kind === "real") {
      result.preserved.push(name);
      continue;
    }
    if (kind === "symlink") {
      const { working, pointsIntoRoot } = pointsInto(to, srcAbs);
      if (working && !pointsIntoRoot) {
        // Foreign, working symlink — someone else manages this. Leave it.
        result.preserved.push(name);
        continue;
      }
      if (working && pointsIntoRoot) {
        // Already ours. Confirm it's the right target (handles the case
        // where a skill got moved within the repo).
        try {
          if (realpathSync(to) === realpathSync(from)) {
            result.alreadyLinked.push(name);
            continue;
          }
        } catch {}
      }
      // Broken OR points into us at a stale target — replace.
      try { unlinkSync(to); } catch {}
      try {
        symlinkSync(from, to);
        result.replaced.push(name);
      } catch {}
      continue;
    }
    // kind === "none" — fresh link.
    try {
      symlinkSync(from, to);
      result.linked.push(name);
    } catch {}
  }

  // 3. Prune dead symlinks that used to point into this ae repo.
  let dstEntries: { name: string; isSymbolicLink: () => boolean }[] = [];
  try {
    dstEntries = readdirSync(dst, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of dstEntries) {
    if (!e.isSymbolicLink()) continue;
    if (ours.has(e.name)) continue;
    const to = resolve(dst, e.name);
    const { pointsIntoRoot } = pointsInto(to, srcAbs);
    if (!pointsIntoRoot) continue;
    try {
      unlinkSync(to);
      result.pruned.push(e.name);
    } catch {}
  }

  return result;
}

export function formatSyncResult(r: SyncResult): string | null {
  const parts: string[] = [];
  if (r.linked.length) parts.push(`linked ${r.linked.length}`);
  if (r.replaced.length) parts.push(`replaced ${r.replaced.length} stale`);
  if (r.pruned.length) parts.push(`pruned ${r.pruned.length} dead`);
  if (r.preserved.length) parts.push(`preserved ${r.preserved.length} user`);
  // alreadyLinked omitted from the happy-path summary — it's the silent case.
  return parts.length ? `skills → ~/.claude/skills: ${parts.join(", ")}` : null;
}
