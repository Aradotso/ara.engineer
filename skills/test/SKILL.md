---
name: test
version: 1.0.0
description: |
  Smart test runner — auto-detects what changed vs main, runs relevant tests (health, browser smoke, go tests). Writes a gate file so /push knows tests passed.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# /test — Smart Test Runner

Auto-detect what changed and run the right tests. Write a gate file for `/push`.

## Usage

- `/test` — auto-detect and run relevant tests
- `/test health` — endpoint health checks only
- `/test browser` — browser smoke test only
- `/test all` — run everything

## Step 1: Detect changes

```bash
CHANGED=$(git diff origin/main --name-only 2>/dev/null || git diff HEAD~1 --name-only)
echo "$CHANGED"
```

| Pattern | Tests to run |
|---------|-------------|
| `*.tsx`, `*.ts`, `src/components/`, `src/pages/` | Browser smoke |
| `Ara-backend/`, `*.py`, `routes/`, `services/` | Health endpoints |
| `*.go` | `go test ./...` |
| `package.json`, `*.config.*`, `*.md` | Syntax check only |

## Step 2: Run in cmux split

```bash
WORKER=$(cmux --json new-split right | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_ref'])")
```

Read the port from `CLAUDE.md` in the worktree root if available, else default to 4000 for API, 5173 for app.

### Backend → health check

```bash
# Must test against local dev server if you have code changes
if lsof -i :$API_PORT -sTCP:LISTEN > /dev/null 2>&1; then
  API_URL="http://localhost:$API_PORT"
else
  echo "ERROR: No local server on :$API_PORT — start dev server before testing"
  exit 1
fi
cmux send --surface "$WORKER" "curl -sf $API_URL/health | python3 -m json.tool\n"
```

### UI → browser smoke test

```bash
BROWSER=$(cmux --json browser open "http://localhost:$APP_PORT" | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_ref'])")
cmux browser $BROWSER wait --load-state complete --timeout-ms 15000
```

Inject auth using the DEV credentials from `CLAUDE.md` (agent email/password):

```bash
SESSION=$(curl -s -X POST "$DEV_SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $DEV_SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$DEV_EMAIL\",\"password\":\"$DEV_PASSWORD\"}")
cmux browser $BROWSER eval "localStorage.setItem('supabase.auth.token', JSON.stringify($SESSION))"
cmux browser $BROWSER goto "http://localhost:$APP_PORT/console"
cmux browser $BROWSER wait --load-state complete --timeout-ms 15000
```

Smoke checks:
1. `cmux browser $BROWSER get title` — must contain "Ara", not "Sign in"
2. `cmux browser $BROWSER errors list` — no JS crashes
3. `cmux browser $BROWSER snapshot --compact` — nav elements visible
4. `cmux browser $BROWSER screenshot` — read the screenshot to visually verify

### Go → go test

```bash
cmux send --surface "$WORKER" "cd $(git rev-parse --show-toplevel) && go test ./... 2>&1\n"
sleep 15
cmux capture-pane --surface "$WORKER"
```

## Step 3: Write gate file

```bash
GATE="$(git rev-parse --show-toplevel)/.worktree-test-gate"
cat > "$GATE" << EOF
branch=$(git rev-parse --abbrev-ref HEAD)
commit=$(git rev-parse HEAD)
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
result=pass
EOF
echo "Gate written: $GATE"
```

## Step 4: Report

```
## Test Results

| Suite   | Result | Detail              |
|---------|--------|---------------------|
| Health  | PASS   | 8/8 endpoints OK    |
| Browser | PASS   | Console loaded, auth OK |

Ready for /push.
```

## Rules

- Only test against local dev server when you have code changes
- Browser tests only for UI changes — skip for backend/config-only
- Always write the gate file (pass or fail)
- Never modify source code during tests
