---
name: trace
version: 1.0.0
description: |
  Ara agent-trace debugging — inspect and test Braintrust traces for text.ara.so and media-processing. Invoked as `/trace test` (run canonical prod scenarios end-to-end and verify traces), `/trace recent` (last N turns), `/trace search <term>` (filter by content), `/trace user <phone-or-id>` (one user's conversations), `/trace span <id>` (drill into one span), or `/trace <url>` (open a Braintrust permalink).
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# /trace — Agent trace debugging for Ara

Ara emits Braintrust traces from the LLM tool-loop in `website-deploy/server.py`
(`run_turn`) and `media-processing/src/server.ts`. One Braintrust project:
**`Ara`** in org **`Aradotso`**.

For general `bt` CLI reference, see `/braintrust`. This skill is the Ara-specific
layer: canonical test scenarios, span tree shape, and debug workflows.

---

## Span tree shape (what a real turn looks like)

```
turn                          (task)
├── cerebras.chat             (llm)   — one per tool-loop round
├── tool.create_site          (tool)
├── cerebras.chat             (llm)
├── tool.write_file           (tool)
├── cerebras.chat             (llm)
├── tool.preview_url          (tool)
├── tool.fetch_url            (tool)
├── tool.dev_logs             (tool)
└── cerebras.chat             (llm)   — final, no tool_calls → returns reply
```

- Root `turn.input` = `{"messages": [...], "site_slug": "..."}`
- Root `turn.output` = `{"reply": "...", "tool_trace": [...], "site_slug": "..."}`
- Root `turn.metrics` = `tokens_prompt`, `tokens_completion`, `tool_calls`, `rounds`
- Each `cerebras.chat` logs input (message history slice) + output (model choice message) + token metrics
- Each `tool.<name>` logs input (args) + output (result preview, first 2000 chars)

Instrumentation lives in `website-deploy/server.py`:
- `_BT_LOGGER` captured at startup (guarded by `BRAINTRUST_API_KEY`)
- `_bt_span(name, ...)` helper — no-op when key is absent
- `run_turn` wraps the loop; `_cerebras_chat` wraps each LLM call; each `exec_tool` is wrapped per-call

---

## `/trace test` — canonical end-to-end scenarios

Run 4 realistic prod-shaped turns, emit traces, verify each landed in Braintrust.
Scenarios mirror the real distribution of what users ask over SMS:

| # | Intent | Prompt | Expected tools (any order) |
|---|--------|--------|----------------------------|
| 1 | New site, simple | "Make a one-page landing for a dog walker named Fetch. Hero, three service cards, contact." | `write_file`, `preview_url`, `fetch_url` |
| 2 | Edit existing | "Change the hero heading to 'Walks That Wag' and make the CTA button bigger." | `read_file`, `edit_file`, `preview_url`, `fetch_url` |
| 3 | Debug broken page | "The page is blank — fix it." | `fetch_url`, `dev_logs`, `read_file`, `edit_file` |
| 4 | Deploy to prod | "Ship this to production." | `deploy` |

Runner: copy the block below to `website-deploy/bt_trace_scenarios.py` and run.
Re-uses `run_turn` so it exercises the real Cerebras client + sandbox + Braintrust
instrumentation — same code path as production SMS traffic.

```python
"""Run canonical scenarios through run_turn and verify traces landed in Braintrust.
Each scenario shares one site_slug so scenarios 2-4 can work on scenario 1's site."""
from __future__ import annotations

import asyncio
import os
import sys
import time

from env_loader import load_env

load_env()
for k in ("BRAINTRUST_API_KEY", "CEREBRAS_API_KEY", "BL_API_KEY"):
    if not os.environ.get(k):
        sys.exit(f"{k} not set — cannot run scenarios")

from server import run_turn, _BT_LOGGER  # noqa: E402

SLUG = f"trace-test-{int(time.time())}"

SCENARIOS = [
    ("new-site",    "Make a one-page landing for a dog walker named Fetch. Hero, three service cards, contact.", ["write_file", "preview_url", "fetch_url"]),
    ("edit",        "Change the hero heading to 'Walks That Wag' and make the CTA button bigger.",               ["edit_file"]),
    ("debug-blank", "The page is blank — check and fix it.",                                                      ["fetch_url", "dev_logs"]),
    ("deploy",      "Ship this to production.",                                                                   ["deploy"]),
]


async def main() -> None:
    print(f"Using site_slug={SLUG}  project=Ara/Aradotso")
    print(f"Logger ready: {_BT_LOGGER is not None}\n")

    history: list[dict] = []
    results = []
    for name, prompt, expected_tools in SCENARIOS:
        print(f"─── scenario: {name} ───")
        print(f"    prompt: {prompt}")
        turn_msgs = history + [{"role": "user", "content": prompt}]
        t0 = time.time()
        out = await run_turn(turn_msgs, site_slug=SLUG)
        elapsed = time.time() - t0
        tools_used = [t["name"] for t in out.get("tool_trace", [])]
        missing = [t for t in expected_tools if t not in tools_used]
        status = "PASS" if not missing else f"PARTIAL (missing: {missing})"
        print(f"    tools:   {tools_used}")
        print(f"    status:  {status}   elapsed: {elapsed:.1f}s")
        print(f"    reply:   {(out.get('reply') or '')[:120]}\n")
        results.append({"name": name, "tools": tools_used, "status": status, "elapsed": elapsed})
        history.append({"role": "user", "content": prompt})
        history.append({"role": "assistant", "content": out.get("reply", "")})

    print("─── summary ───")
    for r in results:
        print(f"  {r['name']:14s}  {r['status']:20s}  {r['elapsed']:5.1f}s  tools={r['tools']}")
    print(f"\nOpen logs:  https://www.braintrust.dev/app/Aradotso/p/Ara/logs")
    print(f"Search in UI for site_slug={SLUG} to isolate this run.")


if __name__ == "__main__":
    asyncio.run(main())
```

Run it:

```bash
cd /Users/adisingh/github/ara-3-ideas/website-deploy
./.venv/bin/python bt_trace_scenarios.py
```

After it finishes, verify traces landed:

```bash
# All 4 turns should appear — check the count
bt view logs --project Ara --search "trace-test" --limit 10 --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items', [])), 'turns')"
```

The runner already asserts expected tools per scenario and prints PASS/PARTIAL.
If PARTIAL: open the permalink, inspect the `cerebras.chat` span's output message
to see why the model didn't call the expected tool.

---

## `/trace recent` — last N turns

```bash
# Last 10 turns, machine-readable
bt view logs --project Ara --limit 10 --json
```

Interactive TUI (arrow keys + Enter to drill in):

```bash
bt view logs --project Ara
```

---

## `/trace search <term>` — filter by content

Search works against `input` / `output`:

```bash
bt view logs --project Ara --search "Fetch" --limit 20 --json
bt view logs --project Ara --search "deploy" --window 24h --limit 20 --json
```

---

## `/trace user <phone-or-id>` — one user's conversations

**Today's best path** (spans don't yet carry `user_id` metadata — see Next Steps below):

1. Resolve phone → look up in Supabase:
   ```bash
   cd /Users/adisingh/github/ara-3-ideas/website-deploy
   ./.venv/bin/python -c "from env_loader import load_env; load_env(); import db; u=db.upsert_user_by_phone('<phone>'); print(u)"
   ```
2. Search traces by phone number text (user messages often contain phone context):
   ```bash
   bt view logs --project Ara --search "<phone>" --limit 20 --json
   ```
3. Or pull all turns from the last N hours and correlate by `site_slug` from Supabase:
   ```bash
   # site_slug lives on each user row (users.active_slug)
   bt view logs --project Ara --search "<active-slug>" --limit 20 --json
   ```

For a full session: jump to Supabase `turns` table (source of truth) and use
Braintrust for the span tree of a specific `turn.id`.

---

## `/trace span <id>` — full payload of one span

```bash
# Full (untruncated) span content
bt view span --object-ref project_logs:a748a67d-8213-4245-981d-b36290db4e2e --id <span-id>

# Full trace tree rooted at <root-span-id>
bt view trace --object-ref project_logs:a748a67d-8213-4245-981d-b36290db4e2e --trace-id <root-id>
```

The project id (`a748a67d-...`) is stored at `.bt/config.json` in the repo. Get it:

```bash
python3 -c 'import json; print(json.load(open(".bt/config.json"))["project_id"])'
```

---

## `/trace <url>` — open a Braintrust permalink

Paste a full URL and fetch the trace:

```bash
bt view trace --url "https://www.braintrust.dev/app/Aradotso/p/Ara/logs?r=<id>&s=<id>"
```

Or just `open "<url>"` to open it in the browser.

---

## SQL debugging (when `view` isn't enough)

Braintrust SQL runs against `project_logs(<project-id>)`:

```bash
PROJ=$(python3 -c 'import json; print(json.load(open("/Users/adisingh/github/ara-3-ideas/.bt/config.json"))["project_id"])')

# Top 10 slowest turns in last 24h
bt sql "SELECT root_span_id, metrics->>'duration' AS dur_s, metadata->>'model' AS model
        FROM project_logs('$PROJ')
        WHERE span_attributes->>'name' = 'turn' AND created > now() - interval '24 hours'
        ORDER BY (metrics->>'duration')::float DESC LIMIT 10"

# Turns that hit max rounds
bt sql "SELECT root_span_id FROM project_logs('$PROJ')
        WHERE metadata->>'exceeded_max_rounds' = 'true'
        ORDER BY created DESC LIMIT 20"

# Tool-call distribution
bt sql "SELECT span_attributes->>'name' AS tool, count(*)
        FROM project_logs('$PROJ')
        WHERE span_attributes->>'type' = 'tool' AND created > now() - interval '7 days'
        GROUP BY 1 ORDER BY 2 DESC"
```

See `/braintrust` for SQL constraints (no joins, subqueries, or window functions).

---

## Workflow: debugging a reported bug

User reports "deploy didn't work for my site". Walk:

1. **Find recent turns for that user** — if phone known: `bt view logs --project Ara --search "<phone>"`. Else: `bt view logs --project Ara --search "deploy" --limit 30`.
2. **Open the `turn` span** — check `metadata.exceeded_max_rounds` and `metadata.model`.
3. **Walk children** — look for the last `cerebras.chat`. Was `deploy` in `tool_calls`? If not, the model never tried.
4. **If `tool.deploy` exists** — open it. Check `output` for the `ok` field and `error` string.
5. **Cross-reference Supabase** — `deployments` table row for that `site_id` has Vercel's view.
6. **If it's a cold-Cerebras hiccup** — look at the first `cerebras.chat`, check whether `reasoning_effort` changed or latency spiked.

---

## Quick reference

| Command | Purpose |
|---------|---------|
| `bt view logs --project Ara` | Interactive log browser |
| `bt view logs --project Ara --json` | Machine-readable, pipe to jq |
| `bt view logs --project Ara --search <term>` | Substring search over input/output |
| `bt view logs --project Ara --window 24h` | Time window (default 1h) |
| `bt view span --object-ref project_logs:<pid> --id <sid>` | Full untruncated span |
| `bt view trace --url <permalink>` | Fetch trace by shared URL |
| `bt sql "<query>"` | Ad-hoc SQL across spans |
| `bt status --json` | Confirm active org/project |

---

## Next steps (known limitations)

- **Span metadata doesn't include `user_id` yet.** To enable true `/trace user
  <phone>` filtering, `run_turn` needs to accept and tag `user_id` on the root
  `turn` span (via `turn_span.log(metadata={"user_id": ...})`). The SMS webhook
  (`_handle_inbound_locked` in `server.py`) already has the user_id in scope —
  plumb it into `run_turn`.
- **No cost metric in spans.** `_compute_cost` in `server.py` is computed per turn
  but not logged as a Braintrust metric. Add `metrics={"cost_usd": ...}` to the
  `turn` span close.
- **media-processing isn't instrumented beyond init.** The TS server has
  `initLogger` but no `startSpan` wrapping the chat agent. Needs the equivalent
  of the Python `run_turn` wrap.
