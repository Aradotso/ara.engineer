# ara.engineer

The Ara engineer monorepo. One repo for the client-side CLI, the team
skill library, the hosted MCP connectors, and the landing site.

| Path | What | Deploy target |
|------|------|---------------|
| [`cli/`](./cli) | The `ae` CLI (Bun + TypeScript). Binary: `ae`. Distributed via the install one-liner. | user machines |
| [`skills/`](./skills) | Team skill library. Each subfolder is a SKILL.md + assets. Auto-linked into `~/.claude/skills/` by the installer. | user machines |
| [`mcps/`](./mcps) | The Ara-managed MCP server. OAuth 2.1 + Railway, Resend, Braintrust, Axiom, Higgsfield, and more. | Railway → `connectors.ara.engineer` |
| [`site/`](./site) | Landing page + `/mcp` catalog + `/install` script. | Vercel → `ara.engineer` |

## Install

```
curl -fsSL https://ara.engineer/install | sh
```

Installs `ae` plus the `cc` / `cct` / `cs` / `cx` / `ccbg` shim shortcuts into `~/.bun/bin`,
and links every skill under `skills/` into `~/.claude/skills/`.

## MCP connectors in one shot

After install, wire every team MCP (Ara-managed + official hosted) into your
agent of choice:

```
ae mcp setup-codex --write      # ~/.codex/config.toml
ae mcp setup-claude --write     # ~/.claude.json
ae mcp setup-chatgpt            # prints URLs to paste into ChatGPT's Connectors UI
ae mcp list                     # show the catalog
```

The catalog is a single static file — [`site/public/mcp.json`](./site/public/mcp.json) —
consumed by both the CLI and the `/mcp` directory page. Add a new server there
and every teammate's next `ae mcp setup-*` picks it up, no CLI release needed.

## Secrets convention

**All runtime secrets for Ara live in Railway variables.**

- `ara-api` (on the `Ara Backend` project, `prd` environment) is the canonical
  source — Stripe, OpenAI, Anthropic, Supabase, GitHub, Slack, Resend, Google,
  Cloudflare, Axiom, Braintrust, etc. all live there.
- `ara-connectors` holds its own keys (Resend, Higgsfield, etc.) for tools the
  MCP server proxies to.
- Agents connected to the Ara MCP discover everything via `railway_get_variables`
  — the `ARA_INSTRUCTIONS` sent on session init tell them to start with
  `ara-api` and fall back to other services.

Rules:
- **Never commit secrets to the repo.** `.env` / `.env.local` are gitignored.
- **Never roll your own vault.** Railway is the store; 1Password is for humans.
- **Rotation:** update in Railway, the service redeploys on next write.

See `mcps/src/index.ts` (`ARA_INSTRUCTIONS`) for the canonical agent-facing
description of where each category of secret lives.

## Repo structure

```
ara.engineer/
├── cli/                          # `ae` binary + shims
│   ├── bin/ae
│   ├── shims/{cc,cct,cs,cx,ccbg}
│   └── src/{commands,skills.ts,...}
├── skills/                       # SKILL.md library — linked into ~/.claude/skills/
│   ├── ae/           demo/        exa/         ...
│   └── <skill>/SKILL.md
├── mcps/                         # Express + MCP server, deployed to Railway
│   ├── src/{index.ts, auth/, middleware/, tools/}
│   ├── Dockerfile
│   └── railway.toml
├── site/                         # Static Vercel site
│   └── public/{index.html, mcp.json, mcp/, install.sh}
├── package.json                  # Bun workspaces: cli, mcps, site
└── README.md
```

## Ship it

- `cli/` + `skills/` — push to `main` on `github.com/Aradotso/ara.engineer`;
  users pick it up on the next `ae update` (or the daily background check).
- `site/` — Vercel auto-deploys on push. Project root: `site/`.
- `mcps/` — Railway auto-deploys on push. Project root: `mcps/` (set in
  Railway dashboard → service → Settings → Source → Root directory).

## Dev

```bash
bun install              # install workspace deps
bun run dev:site         # http://localhost:3210 — landing + /mcp catalog
bun run dev:mcps         # http://localhost:3000 — MCP server
bun run dev:cli          # run the CLI from source
bun run typecheck        # across all workspaces
```
