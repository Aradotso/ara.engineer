---
name: secrets
description: Ara's secrets convention — all runtime credentials live in Railway variables on the ara-api service (project Ara Backend, environment prd). Use the Railway MCP tools to fetch; never ask the user to paste keys; never commit .env.
---

# Ara secrets

**One rule: runtime secrets live in Railway. Humans use 1Password. Don't invent a third thing.**

## Where to look

Start with the `ara-api` service on the `Ara Backend` project, `prd` environment.
Hardcoded IDs (skip the discovery roundtrips):

- Project `Ara Backend`: `5b03413d-9ace-4617-beb5-18b26ce5f339`
- Environment `prd`: `f3d22dae-9e86-4a38-a26e-0d27efa12749`
- Service `ara-api`: `304984ab-6cc0-42cf-80e4-9cc9b6529b21`

Typical fetch:

```json
{
  "tool": "railway_get_variables",
  "args": {
    "projectId": "5b03413d-9ace-4617-beb5-18b26ce5f339",
    "environmentId": "f3d22dae-9e86-4a38-a26e-0d27efa12749",
    "serviceId": "304984ab-6cc0-42cf-80e4-9cc9b6529b21"
  }
}
```

If the key isn't on `ara-api`, check `ara-connectors` or `locomotive` via `railway_list_projects`, then pass their project/environment/service IDs to `railway_get_variables`.

## What lives where

| Category | Location |
|----------|----------|
| Third-party API keys (Stripe, OpenAI, Anthropic, Supabase, Resend, Slack, Google, Cloudflare, Axiom, Braintrust, etc.) | Railway → `ara-api` |
| DB URLs, internal service URLs | Railway → the service that owns them |
| MCP connector keys (the keys ara-connectors uses) | Railway → `ara-connectors` |
| Human logins, personal tokens, SSH keys | **1Password** (Ara Engineering vault) — not Railway |

## What NOT to do

- **Don't ask the user to paste a credential.** If the agent can't find it, the wiring is broken — fix the wiring.
- **Don't read `.env` / `.env.local` hoping they exist.** They're gitignored and almost never present in cloud agent sandboxes.
- **Don't generate fake/placeholder values** to "make the code run." That bug will ship.
- **Don't build your own vault.** No shared sqlite, no `arasecrets` service, no "just for dev" helper. Railway + 1Password is it.
- **Don't commit secrets.** If one leaks, rotate in Railway *first*, then deal with git history.

## Rotation

1. Edit the variable in Railway (dashboard or `railway_set_variable`).
2. The service redeploys on next write; the new value is live.
3. If the key is shared across services, prefer Railway's shared variable feature over copying.

## Escalation

If the key truly isn't in Railway anywhere, *then* ask the user. Be specific: `"the OPENAI_API_KEY variable isn't on ara-api/prd or ara-connectors/production — can you set it in Railway?"` rather than `"please paste your OpenAI key"`.
