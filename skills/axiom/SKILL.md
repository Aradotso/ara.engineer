---
name: axiom
version: 1.0.0
description: |
  Ara observability — query logs across api, web, and app. Primary dataset is "logs". Filter by service, environment, user_id, or runtime_session_id.
allowed-tools:
  - Bash
---

# /axiom — Log Queries

All Ara services log to a single Axiom dataset: `logs`.

## Service labels

| `service` | What it is |
|-----------|------------|
| `api` | Python FastAPI on Railway |
| `web` | Web console (React, browser) |
| `desktop` | Tauri desktop app |

## Common fields

| Field | Notes |
|-------|-------|
| `_time` | ISO timestamp |
| `service` | see above |
| `environment` | `production` or `staging` |
| `level` | `info`, `warn`, `error` |
| `message` | log message |
| `user_id` | Supabase user UUID |
| `user_email` | user email |
| `runtime_session_id` | session correlation id |
| `request_id` | request correlation id |

## Auth

```bash
axiom auth login        # one-time browser login
axiom dataset info logs # confirm dataset exists
```

## Common queries

```bash
# Production errors right now
axiom query "['logs'] | where environment == 'production' and level == 'error' | sort by _time desc | limit 20"

# All logs for a user
axiom query "['logs'] | where user_id == 'uuid-here' | sort by _time desc | limit 50"

# Full session trace
axiom query "['logs'] | where runtime_session_id == 'sess-xxx' | sort by _time asc"

# API errors, last hour
axiom query "['logs'] | where service == 'api' and level == 'error'" --start-time -1h

# Tail production live
axiom query "['logs'] | where environment == 'production' | sort by _time desc | limit 50" --start-time -2m
```

## Flags

```bash
--start-time -1h     # last hour (also: -30m, -24h, -7d)
--format table       # pretty table
--format json        # pipe to jq
```

## With jq

```bash
# Unique users with errors today
axiom query "['logs'] | where level == 'error'" --start-time -24h --format json \
  | jq -r '.[] | .user_email' | sort -u

# Full trace as readable lines
axiom query "['logs'] | where runtime_session_id == 'sess-xxx'" --format json \
  | jq -r '.[] | "\(._time) [\(.service)] \(.level): \(.message)"' | sort
```

## Workflow

1. Wide: errors in production, last hour
2. Narrow to service
3. Find `user_id` or `runtime_session_id` from results
4. Full trace: all services for that session, `sort by _time asc`
