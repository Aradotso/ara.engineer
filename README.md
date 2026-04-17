# ae

The Ara engineer monorepo. Two things live here:

| Path | What | Lives at |
|------|------|----------|
| `cli/` | The `ae` CLI (Bun + TypeScript) | binary: `ae` |
| `ara.engineer/` | Landing page that serves the install one-liner | https://ara.engineer |

## ae — the CLI

```
ae                    help + full skill list
ae list [--json]      catalog of every SKILL.md discovered
ae <skill> [--json]   print a skill's SKILL.md (agent-friendly)
ae wt [name]          spawn an Ara worktree + dev env + cmux + claude
ae update             pull latest + relink shims
ae update --check     report if an update is available, no changes
ae --version
```

## Shortcuts

Installed alongside `ae` as bare commands on `$PATH`:

| Shim | Runs |
|------|------|
| `cc` | `claude --dangerously-skip-permissions` |
| `cct` | `cmux claude-teams --dangerously-skip-permissions` |
| `cs` | `agent --yolo` |
| `cx` | `codex --dangerously-bypass-approvals-and-sandbox` |
| `ccbg <cmd>` | Run + tee output to `/tmp/ccbg/<name>-<time>.log` (for agents to watch) |

All shims live in `cli/shims/` and are linked by `install.sh` / `ae update`.
They also work as `ae cc`, `ae cct`, `ae cs`, `ae cx`, `ae ccbg`.

## Updates

A daily background check (≤1 `git fetch` per 24h) writes the commit
count-behind to `~/.ae/behind`. On the next `ae` help invocation the banner
nudges you: `↑ ae is N commits behind — run \`ae update\` to upgrade`.

Disable with `AE_NO_UPDATE_CHECK=1`.

Skill discovery tries roots in this order (first hit wins per skill id):

1. `$AE_SKILLS_ROOT` (colon-separated paths, explicit override)
2. `~/.claude/skills/`
3. `~/lab/astack/` (legacy home pre-rename)
4. `~/lab/ae/`
5. `<cli>/..` (sibling layout)

New skills are picked up automatically — drop a folder with a `SKILL.md`
in any of those roots.

### Dev

```bash
cd cli
bun install
bun run src/index.ts list     # run without installing
bunx tsc --noEmit             # type-check
```

### Install locally

Symlink the shim into a PATH dir:

```bash
ln -snf "$(pwd)/cli/bin/ae" ~/.bun/bin/ae
ae --version
```

## ara.engineer — the landing page

Static site. See `ara.engineer/README.md`.

## Ship it

1. Push this repo to `github.com/Aradotso/ara.engineer`.
2. `cd ara.engineer && vercel deploy --prod` (team `araso`).
3. `curl -fsSL https://ara.engineer/install | sh` should install `ae`.
