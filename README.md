# ara.engineer

The Ara engineer monorepo. One repo for the client-side CLI, the team
skill library, the hosted MCP connectors, and the landing site.

| Path | What | Deploy target |
|------|------|---------------|
| [`cli/`](./cli) | The `ae` CLI (Bun + TypeScript). Binary: `ae`. Distributed via the install one-liner. | user machines |
| [`skills/`](./skills) | Team skill library. Each subfolder is a SKILL.md + assets. Auto-linked into `~/.claude/skills/` by the installer. | user machines |
| [`mcps/`](./mcps) | The Ara-managed MCP server. OAuth 2.1 + Railway, Resend, Braintrust, Axiom, Higgsfield, and more. | Railway → `mcp.ara.engineer` |
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

**All runtime secrets live in Infisical. Railway runs services; Infisical holds keys.**

- Project: `Ara-passwords` (id `6d518288-7854-49d2-aa42-8ffd285dafa1`)
- Envs: `dev`, `staging`, `prod`
- Folders: `/shared/`, `/ara-api/`, `/ara-web/`, `/text-ara-so/`, `/mcp/`, `/cli/`

Services wrap their start command with `infisical run --projectId=... --env=prod
--path=/<service> -- <cmd>`. Railway holds only the machine-identity bootstrap
(`INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET`) plus platform-auto vars
(`RAILWAY_*`, `PORT`).

Agents discover secrets via `infisical_list_secrets` / `infisical_get_secret`
tools on the Ara MCP — not `railway_get_variables` anymore.

Rules:
- Never commit secrets. Use `infisical secrets -o dotenv > .env.local` locally.
- Never put new secrets in Railway env vars.
- Never roll your own vault. Infisical = services, 1Password = humans.

See [`site/public/secrets/`](./site/public/secrets/) (public page),
[`skills/secrets/SKILL.md`](./skills/secrets/SKILL.md) (agent skill),
and `mcps/src/index.ts` (`ARA_INSTRUCTIONS`) for the agent-facing rules.

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
