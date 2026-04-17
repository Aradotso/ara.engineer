---
name: health
version: 1.0.0
description: |
  Test all API endpoints. Discovers routes from code, hits each one, checks Supabase/Railway health — runs in a cmux split.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# /health — Endpoint Health Check

Discover every API route, hit each one, verify responses. Use cmux splits.

## Setup

```bash
WORKER=$(cmux --json new-split right | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_ref'])")
```

## Step 1: Discover endpoints

Search for route definitions:

```bash
# FastAPI / Python
grep -r "@app\.\(get\|post\|put\|delete\|patch\)" Ara-backend/ --include="*.py" -n

# Next.js / TypeScript
find . -path "*/app/api/**/route.ts" -o -path "*/pages/api/**/*.ts" 2>/dev/null
```

Build a list of `METHOD /path` pairs.

## Step 2: Determine base URL

```bash
cmux send --surface "$WORKER" "railway status 2>&1; lsof -i :4000 -sTCP:LISTEN 2>&1 | head -3\n"
sleep 2
cmux capture-pane --surface "$WORKER"
```

Use `http://localhost:4000` if the local API is running (check CLAUDE.md for port), otherwise Railway dev URL.

## Step 3: Test endpoints

```bash
cmux send --surface "$WORKER" "curl -s -w '\\n%{http_code} %{time_total}s' BASE_URL/health\n"
sleep 1
cmux capture-pane --surface "$WORKER"
```

For each response check:
- Status code expected (200, 401 for unauthed is fine)
- Valid JSON if expected
- Response time < 2s
- No 500s

## Step 4: Report

```
## Health Check

| Method | Path         | Status | Time  | Result |
|--------|--------------|--------|-------|--------|
| GET    | /health      | 200    | 0.1s  | PASS   |
| GET    | /api/users   | 200    | 0.3s  | PASS   |
| POST   | /api/webhook | 500    | 0.1s  | FAIL   |
```

## Rules

- No destructive requests (DELETE) unless asked
- POST with minimal valid payloads — don't create real data
- Note auth-required endpoints rather than failing them
- Flag slow endpoints (> 1s) even if 200
