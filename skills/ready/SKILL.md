---
name: ready
version: 2.0.0
description: |
  Pre-flight check — verifies CLIs (railway, blaxel, gh) and MCP connections (supabase, linear, stripe, vercel, posthog, axiom). CLIs tested via bash, MCPs tested by calling their tools directly.
allowed-tools:
  - Bash
  - Read
  - MCP
---

# /ready — Pre-flight Check

## What's a CLI vs MCP

| Type | Tools | How to test |
|------|-------|-------------|
| CLI | `railway`, `bl` (blaxel), `gh` | Bash commands |
| MCP via claude.ai | supabase, linear, stripe, vercel, posthog | Call MCP tools directly |
| CLI + MCP | axiom | `axiom` CLI for queries; no MCP |

## Step 1: Check CLIs

```bash
echo '=== RAILWAY ===' && railway --version && railway status 2>&1
echo '=== BLAXEL ===' && bl version 2>&1 && bl get sandboxes 2>&1 | head -5
echo '=== GH ===' && gh --version && gh auth status 2>&1
echo '=== AXIOM ===' && axiom version && axiom dataset info logs 2>&1 | head -5
echo '=== GIT ===' && cd ~/github/Ara && git branch --show-current && git worktree list | head -8
```

Railway — link worktree if needed:
```bash
cd ~/github/Ara
if ! railway status 2>&1 | grep -q "Ara Backend"; then
  railway link --workspace "Ara" --project "Ara Backend" --environment "prd" --service "ara-api" --json
fi
```

## Step 2: Check MCPs

Call each MCP tool directly and verify it returns data (not an auth error):

- **Supabase**: `mcp__claude_ai_Supabase__list_projects`
- **Linear**: `mcp__claude_ai_Linear__list_teams`
- **Stripe**: `mcp__claude_ai_Stripe__get_stripe_account_info`
- **Vercel**: `mcp__claude_ai_Vercel__list_projects`
- **PostHog**: `mcp__claude_ai_PostHog__projects-get`

## Output

```
## Ready Check

### CLIs
| Tool    | Version | Status | Detail                    |
|---------|---------|--------|---------------------------|
| railway | 4.x.x   | PASS   | Ara Backend / prd linked  |
| blaxel  | x.x.x   | PASS   | Sandboxes visible         |
| gh      | 2.x.x   | PASS   | Logged in as adi@ara.so   |
| axiom   | 0.x.x   | PASS   | logs dataset OK           |
| git     | 2.x.x   | PASS   | Branch: main              |

### MCPs
| Tool     | Status | Detail               |
|----------|--------|----------------------|
| supabase | PASS   | Projects visible     |
| linear   | PASS   | Ara team visible     |
| stripe   | PASS   | Account connected    |
| vercel   | PASS   | Projects visible     |
| posthog  | PASS   | Project 324142 OK    |

Ready: 10/10
```

## Fix hints

- **railway**: `railway link --workspace "Ara" --project "Ara Backend" --environment "prd" --service "ara-api"`
- **blaxel**: `bl login ara`
- **gh**: `gh auth login`
- **axiom**: `axiom auth login`
- **MCPs**: reconnect via claude.ai settings if auth errors
