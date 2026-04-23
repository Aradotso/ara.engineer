---
name: secrets
description: Ara's secrets convention — all runtime credentials live in Infisical (project "Ara-passwords"), grouped into folders by service (/shared/, /ara-api/, /ara-web/, /text-ara-so/, /mcp/, /cli/). Never ask the user to paste keys; never commit .env; never build a custom vault.
---

# Ara secrets

**One rule: runtime secrets live in Infisical. Railway still runs the services, but the secret values are sourced from Infisical. Humans use 1Password. Don't invent a fourth thing.**

## Where to look

Project **Ara-passwords** in Infisical, folders by service.

- Project ID: `6d518288-7854-49d2-aa42-8ffd285dafa1`
- Environments: `dev`, `staging`, `prod`

Folder layout:

| Folder | Who uses it |
|--------|-------------|
| `/shared/` | Multi-service: Supabase, LLM providers, Stripe, Linear, Exa, Cloudflare, PostHog, Axiom, etc. |
| `/ara-api/` | `ara-api` backend — AUTOMATION_*, CLUSTER_SECRET, ENCRYPTION_KEY, DOMAIN_SUFFIX, Blaxel, etc. |
| `/ara-web/` | Frontend web app — VITE_* build-time vars |
| `/text-ara-so/` | text.ara.so SMS service — LINQ_* |
| `/mcp/` | ara.engineer/mcp (the MCP server) — RESEND_API_KEY and service-specific keys |
| `/cli/` | `ae` CLI — tokens the CLI needs (GH, etc.) |

## How to fetch

### From inside an agent session (MCP tools)

The Ara MCP exposes `infisical_*` tools. Prefer these over Railway for any secret lookup:

```
infisical_get_secret   env=prod  key=OPENAI_API_KEY  path=/shared
infisical_list_secrets env=prod  path=/ara-api
infisical_list_folders env=prod
```

### From a developer machine (CLI)

```bash
infisical run --projectId=6d518288-7854-49d2-aa42-8ffd285dafa1 --env=dev --path=/mcp -- bun run dev
# or just load into env:
infisical secrets --projectId=... --env=dev --path=/mcp -o dotenv > .env.local
```

### From a Railway service runtime

The service's start command wraps itself with `infisical run` and uses a machine identity token. Railway only needs to hold `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` as a bootstrap — everything else is fetched from Infisical at container start.

## What NOT to do

- **Don't ask the user to paste a credential.** If the agent can't find it, the wiring is broken — fix the wiring.
- **Don't read `.env` / `.env.local` hoping they exist.** Run `infisical secrets -o dotenv` to generate one if you need it locally.
- **Don't add new secrets to Railway env vars.** Railway is a runtime host, not a vault. Put new secrets in Infisical.
- **Don't generate fake/placeholder values.**
- **Don't build your own vault.** No shared sqlite, no `arasecrets` service, no "just for dev" helper. Infisical + 1Password is it.
- **Don't commit secrets.** If one leaks, rotate in Infisical *first*, then deal with git history.

## Rotation

1. Edit the secret in Infisical (CLI, dashboard, or `infisical_set_secret` tool).
2. Redeploy the service (Railway redeploys automatically on push; else `railway redeploy`).
3. The new container boots with `infisical run`, which fetches the fresh value.

## When the value isn't in Infisical

Check the root `/` folder (pre-reorg secrets not yet categorized), then check if it's a Railway platform-auto var (`RAILWAY_*`, `PORT`) — those stay in Railway by design.

If it truly isn't anywhere, *then* ask the user. Be specific: `"ANTHROPIC_API_KEY isn't in Ara-passwords/prod at /shared or root — can you add it via Infisical?"` rather than `"paste your Anthropic key"`.

## Why not Railway for secrets

- Drift: the same keys used to exist on multiple Railway services (ara-api, text-ara-so, mcp) — rotation required updating each one by hand
- Access: Railway has no folder/per-project scoping; Infisical does
- Tooling: Infisical has first-class CLI + SDK for local dev; Railway's is painful outside the platform

1Password stays for anything tied to a *human* (personal logins, SSH keys, recovery codes). Infisical is for what *services* need to run.
