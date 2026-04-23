---
name: aracli
description: |
  Meta-guide to the aracli CLI (formerly `ae`) and its skill-sharing pipeline. Covers how aracli ships Claude Code skills to every teammate automatically — first-run bootstrap, live symlinks, PreToolUse/Skill hook, SessionStart hook. Use whenever you need to author a new skill, edit an existing skill, or reason about why a skill change did (or didn't) reach another user.
triggers:
  - "create a new skill"
  - "add an aracli skill"
  - "new aracli skill"
  - "how do skills ship"
  - "share this with the team"
  - "auto-share with teammates"
  - "how does aracli update work"
  - "how does /<skill> get to other users"
  - "ship this skill"
---

# aracli — the CLI and its skill pipeline

`aracli` is the Ara engineer CLI (`~/github/ara.engineer/cli/`). It used to
be named `ae`, which still works as an alias pointing at the same binary.
One of its jobs is to auto-distribute a shared pool of Claude Code skills
across every teammate who has `aracli` installed. Edit a skill here, push
to main, every teammate's Claude Code picks up the change — usually without
even restarting their session.

For cmux (the terminal multiplexer) specifically, see `/cmux-terminal-multiplexer`.
For the narrower cmux surfaces, see `/cmux`, `/cmux-browser`, `/cmux-markdown`,
`/cmux-debug-windows`.

---

## The pipeline at a glance

```
  you: edit cli/skills/<name>/SKILL.md  →  git push origin main
                           │
                           ▼
  teammate's laptop:
    background fetch (≤30s cadence)    →  ~/.ae/behind = N
    PreToolUse/Skill hook fires        →  ae tick     →  if behind>0, detached `aracli update`
    next /<name> invocation            →  reads the file via live symlink
                                              ~/.claude/skills/<name>  →  <repo>/cli/skills/<name>
    → teammate gets the new content, no new session needed
```

On every new Claude Code session start, a `SessionStart` hook also runs
`aracli update`, so sessions always begin with the latest pull.

Kill switches (for advanced/emergency use):

- `AE_NO_HOOK_INSTALL=1` — skip writing hooks into `~/.claude/settings.json`.
- `AE_NO_TICK=1` — make `aracli tick` a no-op.
- `AE_NO_SKILLS_SYNC=1` — skip the `~/.claude/skills/` symlink sync.
- `AE_NO_AUTO_UPDATE=1` — skip the auto-pull on ae invocations.

---

## How a skill is discovered

Every skill lives at:

```
~/github/ara.engineer/cli/skills/<name>/SKILL.md    # required
~/github/ara.engineer/cli/skills/<name>/...         # optional references, scripts, templates
```

On first `aracli` run (and every `aracli update` after), `aracli skills sync` creates:

```
~/.claude/skills/<name>  →  ~/github/ara.engineer/cli/skills/<name>   (symlink)
```

Claude Code scans `~/.claude/skills/` at session start, reads each
`SKILL.md`, registers a slash command named after the `name:` in
frontmatter. That's why symlinks are the right primitive — editing the
file via `git pull` mutates what CC reads through the symlink, live.

---

## Authoring a new skill

Create the directory under `cli/skills/`, write a `SKILL.md`, commit, push.
That's it — it's in teammates' hands by the time they start their next CC
session.

### 1. Pick a name

The directory name is the slash command. Keep it lowercase, short,
hyphen-separated: `sauce`, `health`, `axiom`, `cmux-browser`.

### 2. Write SKILL.md

Required frontmatter:

```markdown
---
name: <slug>                         # must match the dir name
description: |
  One to two sentences. Appears in the slash-command autocomplete AND
  gets injected into the LLM's system reminder at session start, so
  this is the single most important hint for WHEN to invoke the skill.
version: 1.0.0                       # optional but conventional
allowed-tools:                       # optional; restricts what the skill can use
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
triggers:                            # optional; natural-language phrases that should fire it
  - "do thing X"
  - "when I say X, do X"
---
```

Body (everything below `---`):

- Lead with a one-paragraph plain-English explanation of what the skill
  does and when to use it.
- Then the operational recipes: commands, code snippets, examples.
- Then common patterns + a quick-reference table at the bottom.
- Keep it copy-pasteable. The LLM reads this verbatim — ambiguity becomes
  behavior.

### 3. (Optional) Ship references alongside

Extra files live next to `SKILL.md` and are available to the LLM when it
invokes the skill:

```
cli/skills/<name>/SKILL.md
cli/skills/<name>/references/*.md
cli/skills/<name>/scripts/*.sh
cli/skills/<name>/templates/*.tsx
```

The SKILL.md should reference these by relative path.

### 4. Commit + push

```bash
cd ~/github/ara.engineer
git add cli/skills/<name>
git commit -m "skill(<name>): <one-line>"
git push origin main
```

Teammates receive it on their next Claude Code session start (or within
~30s of their next `ae` invocation if they're already in a session).

### 5. Verify locally

```bash
ae skills status                   # see every skill + link state
ae skills sync                     # re-link (idempotent)
```

Then pop a new Claude Code session and type `/<name>` — it should show up.

---

## Editing an existing skill

Just edit the file in the repo and push. No re-linking needed — the
teammate's symlink already points at your repo path, and `git pull`
rewrites the file in place.

**Hot-reload semantics:**

| You changed | Takes effect without new CC session? |
|---|---|
| Body of an existing skill | ✅ Yes — next `/<name>` invocation reads fresh content |
| `description` frontmatter | ⚠️ New text reaches the LLM next turn, but the slash-menu label was cached at session start |
| `name` frontmatter | ❌ Rename = slash-menu entry only refreshes on new session |
| Add a whole new skill dir | ❌ CC only scans `~/.claude/skills/` at session start |
| Delete a skill dir | ❌ Slash menu stays stale until session restart (prune happens, but CC's list is cached) |

Rule of thumb: content changes are live, catalog changes need a new session.

---

## Rules of thumb for LLMs authoring skills here

- **One skill = one responsibility.** If a skill's description has "and"
  in it more than twice, split it.
- **Trigger list is a gift, not a contract.** It biases the LLM toward
  invoking the skill on matching phrases, but the actual routing is done
  by the `description`. A great `description` obsoletes most triggers.
- **Lead with the use-case, not the API.** "When the user asks X, do
  Y." Then recipes. Then reference.
- **Copy-paste, don't paraphrase.** Commands in `SKILL.md` run verbatim —
  don't add `# placeholder` comments where the LLM has to fill in.
- **Never put secrets in SKILL.md.** The file is public on the ae repo.
- **Don't duplicate other skills.** Before adding X, check
  `aracli skills status` / the repo's `cli/skills/`. Cross-link via
  `/other-skill` instead of copying content.

---

## The ae CLI itself

Quick tour of the commands skill authors touch most:

| Command | What it does |
|---|---|
| `aracli skills sync` | Re-link `cli/skills/*` into `~/.claude/skills/*` |
| `aracli skills status` | Per-skill: linked / preserved / broken / missing |
| `aracli update` | `git pull` + reinstall + relink shims + sync skills |
| `aracli update --check` | Just report behind-count, no writes |
| `aracli tick` | Fast silent refresh, used by the PreToolUse/Skill hook |
| `aracli list` | Enumerate every discoverable skill |
| `ae show <id>` | Print a skill's SKILL.md |
| `ae <id>` | Same as `ae show <id>` |

Non-skill commands worth knowing when authoring skills that interact
with the broader ae flow: `aracli wt` (worktree + cmux), `aracli status`,
`ae pr`, `ae prr`, `ae poll`.

---

## Debugging "my skill didn't reach the team"

If a teammate reports `/<name>` isn't showing up, walk through:

1. **Did the push land?** `git log origin/main --oneline -5` on your machine.
2. **Is their `aracli` current?** Have them run `aracli update --check`. If it
   says "N commits behind", they haven't auto-pulled yet — `aracli update`
   fixes.
3. **Is the symlink there?** Have them run `aracli skills status`. Look for
   `<name>  linked`. If it's `missing`, run `aracli skills sync`.
4. **Is their session pre-push?** Catalog changes need a fresh CC session.
   Body changes don't. Have them start a new session.
5. **Did they opt out?** Check for `AE_NO_*` env vars in their shell.

---

## Reference: frontmatter parser

The ae CLI's own parser (`cli/src/skills.ts`) supports:

- `key: value` — single-line
- `key: |` or `key: >` + indented block — multi-line
- Quoted values (`"..."` / `'...'`) — quotes stripped
- `triggers:` / `allowed-tools:` as bulleted lists — parsed loosely, only
  `name` / `description` / `version` are surfaced to the UI

Claude Code itself has a similar-but-stricter parser; sticking to the
shape shown in the template above works for both.

---

## TL;DR for instructing an LLM to add a skill

> "Add an ae skill called `<name>`. Directory at
> `~/github/ara.engineer/cli/skills/<name>/`. Write `SKILL.md` with:
>
> - `name: <name>` in frontmatter
> - a `description:` that explains WHEN to invoke it (1-2 sentences)
> - body: use-case intro → recipes → quick-reference table
>
> Commit as `skill(<name>): <one-liner>`, push to ae `origin/main`.
> No other repo edits needed — the ae pipeline (`SessionStart` hook +
> `PreToolUse/Skill` hook + live symlinks) distributes it to every
> teammate within ~30s of their next ae command, visible as `/<name>`
> on their next new Claude Code session (or immediately for body edits
> to an existing skill)."
