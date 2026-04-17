---
name: exa
version: 1.0.0
description: |
  Web search and content extraction via Exa AI. Neural search with auto/deep modes, category filters, domain filters, and Q&A with citations.
allowed-tools:
  - Bash
  - Read
---

# /exa — Web Search

Use Exa MCP tools (`mcp__claude_ai_Exa__web_search_exa`, `mcp__claude_ai_Exa__web_fetch_exa`) when available. Fall back to curl for advanced options.

## Quick commands

| Input | Action |
|-------|--------|
| `/exa <query>` | Auto search with highlights |
| `/exa deep <query>` | Deep thorough search |
| `/exa news <query>` | News category |
| `/exa papers <query>` | Research papers |
| `/exa answer <question>` | Q&A with citations |
| `/exa read <url>` | Fetch content from URL |

## Curl patterns

**Default — highlights (token-efficient):**
```bash
curl -s -X POST 'https://api.exa.ai/search' \
  -H "x-api-key: $EXA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "QUERY",
    "type": "auto",
    "num_results": 10,
    "contents": { "highlights": { "max_characters": 4000 } }
  }' | python3 -c "
import sys,json
for r in json.load(sys.stdin).get('results',[]):
    print(f\"### {r.get('title','')}\\n{r.get('url','')}\\n\")
    for h in r.get('highlights',[]): print(f'  {h[:200]}')
    print()
"
```

**Full text (when you need complete content):**
```bash
-d '{"query":"QUERY","type":"auto","num_results":5,"contents":{"text":{"max_characters":20000}}}'
```

**Category search:**
```bash
-d '{"query":"QUERY","category":"news","type":"auto","num_results":10,"contents":{"highlights":{"max_characters":4000}}}'
# categories: news | research paper | company | people | tweet
```

**Domain filter:**
```bash
-d '{"query":"QUERY","type":"auto","includeDomains":["github.com","arxiv.org"],"num_results":10,"contents":{"highlights":{"max_characters":4000}}}'
```

**Q&A with citations:**
```bash
curl -s -X POST 'https://api.exa.ai/answer' \
  -H "x-api-key: $EXA_API_KEY" -H 'Content-Type: application/json' \
  -d '{"query":"QUESTION","text":true}'
```

**Fetch known URL:**
```bash
curl -s -X POST 'https://api.exa.ai/contents' \
  -H "x-api-key: $EXA_API_KEY" -H 'Content-Type: application/json' \
  -d '{"urls":["URL"],"text":{"max_characters":20000}}'
```

## Parameter notes

- `type`: `auto` (default), `fast`, `deep`, `deep-reasoning`
- `maxAgeHours`: freshness control — `0` = always livecrawl, `-1` = cache only
- **Deprecated** (don't use): `useAutoprompt`, `livecrawl`, `numSentences`, `highlightsPerUrl`
- **Don't exist**: `includeUrls`/`excludeUrls` → use `includeDomains`/`excludeDomains`
- `text`/`highlights` on `/search` must be inside `contents`; on `/contents` they're top-level
