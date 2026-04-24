---
name: search
version: 1.0.0
description: |
  Deeply research a technology already in the stack. Pulls latest official docs, changelogs, release notes, production recipes, and pitfalls via heavy web search — then maps findings onto the exact usage pattern in this repo to surface underused features and confirm best practices. Use whenever someone asks "are we using X right?", "what's the best way to use X for Y?", or "what did X ship recently that we should adopt?"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - WebSearch
  - WebFetch
  - Agent
triggers:
  - "are we using this right"
  - "best way to use"
  - "what's new in"
  - "latest docs for"
  - "how should we use"
  - "confirm the right way to"
  - "/search"
---

# /search — Master the Tech You Already Use

`/sauce` answers "what tech should I pick?" — it scans the field.
`/search` answers "how do I use this tech to its full power for *this* project?" — it reads everything that exists about a specific technology and maps it onto the codebase in front of you.

Use it when the stack is already chosen and the question is whether we're extracting its true leverage.

## Commands

| Input | Action |
|-------|--------|
| `/search <tech>` | Full research pass on `<tech>` as used in this repo |
| `/search <tech> for <use-case>` | Same, scoped to a specific feature / pattern |
| `/search <tech> changelog` | Just: what's shipped since our pinned version |
| `/search <tech> pitfalls` | Just: production war stories + anti-patterns |

## Research mode

### Step 1: Anchor in the codebase (before any web search)

Never search blind. First determine:

1. **Version pinned.** `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, Dockerfile tags. Note the *exact* version — e.g. `@blaxel/core@0.2.44`, not "latest Blaxel".
2. **Import sites.** `rg -n "from ['\"]<tech>" -g '!node_modules'` → every entry point.
3. **Surface used.** Which API methods / modules / CLI commands are actually called. Make a short list like: `createIfNotExists`, `fs.write`, `fs.read`, `process.exec`, `previews`, `codegen.fastapply`, `codegen.reranking`.
4. **Config.** Env vars (`BL_API_KEY`, `SANDBOX_IMAGE`…), config files, feature flags.
5. **The question.** One sentence: what is the user actually trying to confirm / improve?

Dump this anchor as a short "Current usage" block — it frames every search.

### Step 2: Generate 12–18 doc-hunting queries

Cover these angles. Always pin the **current year** (`2026`) and the **version** when it matters.

| Bucket | Example query |
|---|---|
| Official docs (current) | `<tech> <version> documentation site:<official-domain>` |
| Official docs (feature) | `<tech> <specific-api> reference` |
| Changelog / release notes | `<tech> changelog v<ours>..latest`, `<tech> release notes 2026` |
| Migration / upgrade | `<tech> migrate from v<ours> to v<latest>` |
| Advanced / underused | `<tech> advanced guide`, `<tech> pro tips`, `<tech> patterns you didn't know` |
| Best practices (official) | `<tech> best practices production site:<official-domain>` |
| Best practices (community) | `<tech> in production engineering blog`, `<tech> HN` |
| Pitfalls / bugs | `<tech> gotchas`, `<tech> common mistakes`, `<tech> github issues <symptom>` |
| Analogous usage | `<tech> <our-use-case>` e.g. `blaxel persistent per-user dev env` |
| Benchmarks | `<tech> benchmark 2026`, `<tech> performance comparison` |

Rule: prefer the official domain first, then GitHub, then engineering blogs, then HN/Reddit.

### Step 3: Run the searches in parallel

Spawn 3–4 agents concurrently, each owning a bucket. Use **WebSearch** + **WebFetch** first (faster for crawling docs), fall back to Exa (`mcp__claude_ai_Exa__web_search_exa`) for semantic / deep research.

**Agent prompt template:**

```
You are a deep-docs research agent. Target tech: "<TECH>@<VERSION>".
Our current usage (anchor):

<paste Step 1 block>

Run these queries (WebSearch first, WebFetch for any doc page that looks authoritative):
1. "<query1>"
2. "<query2>"
…

For each notable find, return:
- Title + canonical URL
- What it says (3–5 bullets, copy exact code/API names)
- Delta vs our current usage (new feature? deprecated? changed default?)
- Applicability score 1–5 for our anchor use-case
- One-line "why this matters"

Prefer primary sources. Distrust blog posts older than 12 months unless they're official. Quote code verbatim.
```

WebFetch the top 3–5 doc pages directly — don't rely on search snippets for anything you'll act on.

### Step 4: Gap analysis (the whole point)

For each finding, classify against the anchor:

| Bucket | Meaning |
|---|---|
| ✅ Already using correctly | Confirm, cite the doc, move on |
| 🟡 Using, but suboptimally | Note the better pattern + code-level change |
| 🔵 Not using, should be | New feature / API that fits the use-case |
| 🔴 Using, but deprecated / footgun | Needs migration or guard |
| ⚪ Not applicable | Skip |

### Step 5: Present

```
## /search: <tech>@<version> — for <use-case>

### Current usage (anchored in this repo)
<copy Step 1 block>

### What we're doing right ✅
- <item> — doc: <url>

### Underused power 🔵  (biggest leverage, ordered by impact)
1. **<Feature>** — <one-line>
   - Doc: <url>
   - Fits us because: <specific tie to our anchor>
   - Concrete change: <file:line> → <what to add>

### Doing, but better way 🟡
- **<Pattern>** — we're calling `x.y()`, docs recommend `x.z()` for <reason>. Doc: <url>

### Footguns 🔴
- **<Gotcha>** — <what breaks>. Mitigation: <code-level fix>. Ref: <url>

### Version delta since <our-version>
- Shipped: <feature> (v<n>)
- Deprecated: <feature> (v<n>)
- Breaking: <feature> (v<n>)

### Primary sources consulted
- <URL> — <one-line what it covers>
- …

### Recommended next steps
1. <highest-leverage action, with file path>
2. …
```

Be opinionated. Rank by leverage for *this* project, not generic "good practice".

## Changelog-only mode (`/search <tech> changelog`)

Skip the anchor depth. Find current pinned version, fetch the project's `CHANGELOG.md` / GitHub Releases, diff `<ours>..latest`, present grouped by feature / fix / breaking. Flag anything that touches a file we actually import.

## Pitfalls-only mode (`/search <tech> pitfalls`)

Skip most of the anchor. Focus Step 2 on:
- `<tech> github issues closed bug`
- `<tech> HN "don't use"`
- `<tech> reddit production horror`
- `<tech> incident postmortem`

Rank by frequency (same gotcha reported by multiple independent sources = real).

## Rules

- **Anchor first, search second.** A search unanchored from the codebase produces a Wikipedia article, not a recommendation.
- **Primary sources beat blog summaries.** Always WebFetch the real doc page, don't trust snippets.
- **Pin the year.** `2026` in queries. Docs rot fast.
- **Pin the version.** A feature from v0.3 doesn't help on v0.2.44.
- **Quote, don't paraphrase.** When citing an API shape or config, copy it exactly.
- **Leverage, not completeness.** Don't list every feature — list the 3–5 that would move *our* project.
- **Reject vibes.** "People say X is better" without a linked source is not evidence.
- **Cross-link `/sauce`.** If research reveals the tech is fundamentally wrong for the job, stop and suggest `/sauce` instead.

## Quick reference

| Want | Run |
|---|---|
| "Are we using Blaxel right?" | `/search blaxel` |
| "Best way to use Cerebras streaming for iMessage" | `/search cerebras for streaming` |
| "What did AI SDK ship since we pinned v6.0.116?" | `/search ai-sdk changelog` |
| "Supabase production gotchas we should know" | `/search supabase pitfalls` |
