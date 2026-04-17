---
name: ready
version: 1.0.0
description: |
  Pre-flight check — verifies all CLIs are authenticated and ready for coding. Checks railway, supabase, axiom, stripe, vercel, linear, cmux, and git. Runs in a cmux split when available.
allowed-tools:
  - Bash
  - Read
---

# /ready — Pre-flight Check

Verify every CLI is installed, authenticated, and pointing at the right project.

## Cmux rules

When `command -v cmux` succeeds:

1. Open a worker split — don't run the full check inline in your shell.
2. Batch checks with `;` not `&&` so one failure doesn't abort the rest.
3. Wait ~12s after sending, then `cmux capture-pane --surface "$WORKER" --scrollback`.
4. Leave the worker pane open after `/ready`.

```bash
WORKER=$(cmux --json new-split right | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_ref'])")
```

Fall back to running inline if cmux is unavailable.

## Procedure

### 1. Run checks

Send as one batch to the worker:

```bash
cmux send --surface "$WORKER" "
echo '=== RAILWAY ===' && railway --version && railway status 2>&1;
echo '=== SUPABASE ===' && supabase --version && supabase projects list 2>&1 | head -5;
echo '=== AXIOM ===' && axiom version && axiom dataset info logs 2>&1 | head -5;
echo '=== STRIPE ===' && stripe version && stripe customers list --limit 1 2>&1 | head -5;
echo '=== VERCEL ===' && vercel --version && vercel whoami 2>&1;
echo '=== LINEAR ===' && linear team list 2>&1 | head -5;
echo '=== CMUX ===' && cmux version 2>&1;
echo '=== GIT ===' && git --version && cd ~/github/Ara && git remote -v && git branch --show-current && git worktree list | head -8;
echo '---DONE---'
\n"
sleep 12
cmux capture-pane --surface "$WORKER" --scrollback
```

### 2. Railway — link worktrees

Railway link metadata is per-directory. Every new worktree needs a one-time link:

```bash
cd ~/github/Ara
if ! railway status 2>&1 | grep -q "Ara Backend"; then
  railway link --workspace "Ara" --project "Ara Backend" --environment "prd" --service "ara-api" --json
fi
railway status
```

### 3. Pass/fail hints

| Tool | PASS | FAIL / Fix |
|------|------|------------|
| railway | `railway status` shows linked project | `railway link ...` (see above) |
| supabase | `projects list` without auth error | `supabase login` |
| axiom | `dataset info logs` works | `axiom auth login` |
| stripe | `customers list` succeeds | `stripe login` — never paste `config --list` |
| vercel | `vercel whoami` | `vercel login` |
| linear | `team list` shows teams | `export LINEAR_API_KEY=lin_api_xxx` |
| cmux | `cmux version` | Install cmux |
| git | sensible remote in Ara | N/A |

## Output

Print a table:

```
## Ready Check

| Tool     | Version | Status | Detail               |
|----------|---------|--------|----------------------|
| railway  | 4.x.x   | PASS   | Ara Backend / prd    |
| supabase | 2.x.x   | PASS   | Projects visible     |
| axiom    | 0.x.x   | PASS   | logs dataset OK      |
| stripe   | 1.x.x   | PASS   | API call OK          |
| vercel   | 50.x    | PASS   | User: adi@ara.so     |
| linear   | 0.3.x   | PASS   | Ara team visible     |
| cmux     | x.x.x   | PASS   | Running              |
| git      | 2.x.x   | PASS   | Branch: main         |

Ready: 8/8 — All systems go.
```
