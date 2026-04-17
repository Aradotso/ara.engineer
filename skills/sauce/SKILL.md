---
name: sauce
version: 1.0.0
description: |
  Find best-in-class tech for any problem. Runs parallel searches across GitHub, startups, research, and community — ranks and saves winners to a sauce list.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
---

# /sauce — Find the Best Tech

Given a problem, run broad parallel searches and surface the best options. Save winners to a persistent list.

## Commands

| Input | Action |
|-------|--------|
| `/sauce <problem>` | Research mode |
| `/sauce list` | Show saved sauce list |
| `/sauce save <name>` | Save a find to the list |
| `/sauce remove <name>` | Remove from list |

## Research mode

### Step 1: Understand the problem

- Core requirement
- Key constraints (performance, cost, simplicity, ecosystem)
- What they've tried

### Step 2: Generate 15–20 diverse queries

Cover these angles:

1. **Direct** — exact problem statement, year (`2025 2026`)
2. **GitHub** — `github stars open source alternative`
3. **Startups** — `YC backed series A startup`
4. **Research** — `benchmark comparison paper`
5. **Community** — `HN discussion production experience`

### Step 3: Run searches in parallel

Spawn 3–4 agents concurrently, each handling a query category. Use Exa MCP tools:

- General + comparisons → `mcp__claude_ai_Exa__web_search_exa`
- Companies + startups → same with `category: "company"`
- Deep research → `mcp__claude_ai_Exa__web_search_exa` with `type: "deep"`
- Code/GitHub → `mcp__claude_ai_Exa__web_fetch_exa` for specific repos

**Agent prompt template:**

```
You are a tech research agent. Search for solutions to: "<PROBLEM>"

Run these queries using mcp__claude_ai_Exa__web_search_exa (numResults: 8, type: "auto"):
1. "<query1>"
2. "<query2>"
...

For each notable find, return: name, URL, one-line description, why it's exceptional, traction signals (stars, funding, usage), maturity (alpha/stable/production).
```

### Step 4: Score and rank

For each unique technology:

| Dimension | Weight |
|-----------|--------|
| Relevance — actually solves the problem | 3× |
| Maturity — production-ready, actively maintained | 2× |
| Traction — stars, funding, adoption | 2× |
| Innovation — genuinely 10× better approach | 2× |
| Ecosystem — docs, integrations, community | 1× |

Composite = weighted sum / 10.

### Step 5: Present

```
## Sauce: "<problem>"

Searched 18 queries. Found 12 unique technologies.

### 1. Technology Name (9.2/10)
**What:** one-line description
**Why it's sauce:** the 10× factor
**URL:** https://...
**Traction:** 20k stars, backed by CNCF, used in production at Cloudflare
**Maturity:** stable

### 2. ...

---
### Honorable Mentions
- **Tech A** — interesting but alpha (URL)

Save anything? Run `/sauce save <name>`.
```

## Sauce list

Lives at `skills/sauce/references/sauce-list.md`.

### List mode

Read and display the file grouped by status (adopted / exploring / rejected).

### Save mode

Append to `sauce-list.md`:

```markdown
## Technology Name
- **Solves:** problem description
- **Why:** what makes it exceptional
- **URL:** primary link
- **Discovered:** YYYY-MM-DD
- **Status:** exploring
- **Notes:** context
```

## Rules

- Breadth first — diverse queries before narrowing
- Prefer technologies active in the last 12 months
- Traction matters — 10 GitHub stars is not sauce unless brand new and exceptional
- No vaporware — must have working code, live product, or published paper
- Be opinionated — the top pick should be obvious
- Deduplicate — same tech found multiple ways counts once
