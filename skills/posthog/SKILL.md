---
name: posthog
version: 1.0.0
description: |
  Ara PostHog analytics — what we track, where it's wired, how to query. Covers events, user identification, session replays, and the MCP server.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# /posthog — Analytics for Ara

## Keys & config

| Key | Value |
|-----|-------|
| Project API Key (public) | `phc_eYpkukex3YcO0dK2UtBLdXAkzPOga8mOucwH7gqv2f` |
| Personal API Key | `$POSTHOG_PERSONAL_API_KEY` |
| API Host | `https://us.i.posthog.com` |
| Project ID | `324142` |

## Quick links

| Resource | URL |
|----------|-----|
| Dashboard | `https://us.posthog.com/project/324142/dashboard/1362760` |
| Session Replays | `https://us.posthog.com/project/324142/replay` |
| Live Events | `https://us.posthog.com/project/324142/events` |

## Where it's wired (monorepo)

| Path | Role |
|------|------|
| `ara.so/src/main.tsx` | `PostHogProvider`, marketing |
| `ara.so/src/lib/posthog.ts` | `usePostHogIdentify` |
| `app.ara.so/src/main.tsx` | calls `initPostHog()` |
| `app.ara.so/src/lib/posthog.ts` | `initPostHog`, identify, reset on logout |
| `app.ara.so/src/lib/analytics.ts` | `trackEvent` → Vercel + PostHog |
| `app.ara.so/src/utils/analytics.ts` | event name constants (`APP_ANALYTICS`, `CHAT_ANALYTICS`) |

## What we track

- **Autocapture**: clicks, forms, `$pageview`, `$pageleave`
- **Custom events**: see `app.ara.so/src/utils/analytics.ts` for constants
- **Marketing**: `waitlist_submitted`, `scroll_depth` at 25/50/75/100%

## MCP server

```json
{
  "posthog": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "https://mcp.posthog.com/mcp", "--header", "Authorization:${POSTHOG_AUTH_HEADER}"],
    "env": { "POSTHOG_AUTH_HEADER": "Bearer $POSTHOG_PERSONAL_API_KEY" }
  }
}
```

## API queries

```bash
PH_KEY="$POSTHOG_PERSONAL_API_KEY"

# Recent events
curl -s "https://us.posthog.com/api/projects/324142/events/?limit=10" \
  -H "Authorization: Bearer $PH_KEY"

# Trends query (DAU last 7 days)
curl -s -X POST "https://us.posthog.com/api/projects/324142/query/" \
  -H "Authorization: Bearer $PH_KEY" -H "Content-Type: application/json" \
  -d '{"query":{"kind":"TrendsQuery","series":[{"kind":"EventsNode","event":"$pageview","math":"dau"}],"interval":"day","dateRange":{"date_from":"-7d"}}}'

# Session recordings
curl -s "https://us.posthog.com/api/projects/324142/session_recordings/?limit=10" \
  -H "Authorization: Bearer $PH_KEY"
```

**Debug mode:** add `?__posthog_debug=true` to any ara.so URL to see PostHog events in the browser console.
