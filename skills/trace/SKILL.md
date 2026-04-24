---
name: trace
version: 2.1.0
description: |
  Ara agent-trace debugging — inspect Braintrust traces for the website-agent (TS/Bun, Cerebras, Vercel AI SDK v6). Invoked as `/trace recent`, `/trace turn <turn_id>`, `/trace convo <chat_id>`, `/trace user <phone>`, `/trace tool <name>`, `/trace span <id>`, `/trace <url>`, `/trace test` (run canonical e2e via `website-agent/scripts/bt_e2e.ts`), or `/trace score` (run the three trace-scope scorers across recent prod turns — hallucinations, tool budget, builder outcome).
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# /trace — Agent trace debugging for Ara (TS stack)

Live backend: `website-agent/` (Bun + Hono + Vercel AI SDK v6 + Cerebras).
Braintrust org: **`Aradotso`** · project: **`Ara`**.

Instrumentation lives in `website-agent/src/bt.ts`. Every HTTP turn goes:

```
webhook.inbound                   (task)   ← root; carries phone, chat_id, conversation_id, turn_id
└── builder.run                   (task)   ← one user turn end-to-end
    ├── deploy.force              (tool)   ← safety-net forced deploy (only if triggered)
    └── streamText                (function) ← wrapAISDK child
        ├── doStream              (llm)    ← one per tool-loop round
        ├── tool.create_site      (tool)   ← our span (input args, output, elapsed_ms, round_index, site_slug)
        ├── create_site           (tool)   ← wrapAISDK auto (thinner)
        ├── doStream              (llm)
        ├── tool.write_file       (tool)
        ├── write_file            (tool)
        └── … etc
```

Every span carries (via `SERVICE_META` + `TurnContext`):
`service=website-agent, runtime=bun, env, git_sha, model, conversation_id, turn_id, user_id, phone_number, site_slug, round_index`.

Tags on the root span include:
- `inbound`, `event:message.received`
- `phase:build` | `phase:connect` | `phase:paywall` | `phase:soft_gate` | `phase:unconfigured`
- `conversation:<chat_id>`
- `round:1`, `round:2`, … (one per LLM step)
- `tool:create_site`, `tool:write_file`, … (one per tool invoked)
- `deploy:forced` (only when the safety net fires)

---

## `/trace recent` — last N turns

```bash
bt view logs --project Ara --limit 10 --json \
 | python3 -c "import sys,json; d=json.load(sys.stdin)
for i in d.get('items', []):
    r=i['row']; a=r.get('span_attributes',{}); m=r.get('metrics',{}) or {}
    meta=r.get('metadata'); meta=json.loads(meta) if isinstance(meta,str) else (meta or {})
    print(f'{a.get(\"name\"):18s} phone={meta.get(\"phone_number\",\"?\")} convo={meta.get(\"conversation_id\",\"?\")[-12:]} tools={m.get(\"tool_calls\",0)} rounds={int(m.get(\"llm_calls\",0))} cost=\${m.get(\"cost_usd\",0):.4f} dur={m.get(\"duration\",0):.1f}s')"
```

Interactive TUI:

```bash
bt view logs --project Ara
```

---

## `/trace convo <chat_id>` — full conversation (every turn)

Each turn of one iMessage thread shares `metadata.conversation_id = <chat_id>`. Two paths:

**A. Tag-based (fast, UI-friendly):**

```bash
bt view logs --project Ara --search "conversation:<chat_id>" --window 24h --limit 50 --json
```

Tags are indexed — `conversation:<chat_id>` lands on every `webhook.inbound` root.

**B. SQL (precise, includes transcript render):**

```bash
PROJ=<project-id>  # grab from bt status --json
bt sql "SELECT created,
               metadata->>'turn_id' AS turn_id,
               metadata->>'phone_number' AS phone,
               input->>'text' AS user_said,
               (output->>'reply')::text AS agent_said,
               (metrics->>'cost_usd')::float AS cost,
               (metrics->>'tool_calls')::int AS tools
        FROM project_logs('\$PROJ')
        WHERE span_attributes->>'name' = 'webhook.inbound'
          AND metadata->>'conversation_id' = '<chat_id>'
        ORDER BY created ASC"
```

That renders the whole conversation as a transcript with cost + tool count per turn.

---

## `/trace turn <turn_id>` — one user turn (all ~16 spans)

Find the root span id for a turn, then fetch the tree:

```bash
PROJ=<project-id>
ROOT=$(bt sql "SELECT span_id FROM project_logs('\$PROJ')
               WHERE metadata->>'turn_id' = '<turn_id>'
                 AND span_attributes->>'name' = 'webhook.inbound'
               LIMIT 1" --json | python3 -c "import sys,json; print(json.load(sys.stdin)['items'][0]['span_id'])")

bt view trace --trace-id "\$ROOT" --project Ara --limit 100 --preview-length 400 --json
```

---

## `/trace user <phone>` — all turns from one phone

```bash
# Tag search (substring match in tags/metadata):
bt view logs --project Ara --search "<phone>" --window 7d --limit 30 --json

# Precise via SQL:
PROJ=<project-id>
bt sql "SELECT created,
               metadata->>'conversation_id' AS chat,
               metadata->>'turn_id' AS turn,
               input->>'text' AS prompt,
               (metrics->>'cost_usd')::float AS cost
        FROM project_logs('\$PROJ')
        WHERE span_attributes->>'name' = 'webhook.inbound'
          AND metadata->>'phone_number' = '<phone>'
        ORDER BY created DESC LIMIT 50"
```

---

## `/trace tool <name>` — every invocation of one tool

Tool-use timeframe across all users. Tools are spans named `tool.<name>` with
metadata `{tool, site_slug, round_index, conversation_id, turn_id, user_id}`
and metrics `{elapsed_ms, ok}`.

```bash
PROJ=<project-id>
bt sql "SELECT created,
               metadata->>'site_slug' AS slug,
               (metadata->>'round_index')::int AS round,
               (metrics->>'elapsed_ms')::int AS elapsed_ms,
               (metrics->>'ok')::int AS ok,
               metadata->>'turn_id' AS turn,
               metadata->>'phone_number' AS phone,
               output
        FROM project_logs('\$PROJ')
        WHERE span_attributes->>'name' = 'tool.<name>'
          AND created > now() - interval '24 hours'
        ORDER BY elapsed_ms DESC
        LIMIT 30"
```

**Tool-latency distribution (p50/p95):**

```bash
bt sql "SELECT span_attributes->>'name' AS tool,
               count(*) AS n,
               percentile_cont(0.5)  WITHIN GROUP (ORDER BY (metrics->>'elapsed_ms')::float) AS p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY (metrics->>'elapsed_ms')::float) AS p95_ms,
               sum(((metrics->>'ok')::int = 0)::int) AS fails
        FROM project_logs('\$PROJ')
        WHERE span_attributes->>'name' LIKE 'tool.%'
          AND created > now() - interval '7 days'
        GROUP BY 1
        ORDER BY n DESC"
```

**Every tool in one turn (timeline):**

```bash
PROJ=<project-id>
bt sql "SELECT span_attributes->>'name' AS step,
               (metrics->>'start')::float AS start_ts,
               (metrics->>'elapsed_ms')::int AS elapsed_ms,
               input,
               output
        FROM project_logs('\$PROJ')
        WHERE metadata->>'turn_id' = '<turn_id>'
          AND span_attributes->>'name' LIKE 'tool.%'
        ORDER BY start_ts ASC"
```

---

## `/trace span <id>` — full payload of one span

```bash
PROJ=<project-id>
bt view span --object-ref project_logs:\$PROJ --id <span-id>
```

---

## `/trace <url>` — open a Braintrust permalink

```bash
bt view trace --url "https://www.braintrust.dev/app/Aradotso/p/Ara/logs?r=<root>&s=<span>" --json
```

Or `open "<url>"` for the browser.

---

## `/trace test` — end-to-end smoke

Re-runs the signed Linq webhook → full span tree verification. Three kinds:

```bash
cd website-agent
# connect flow (CONNECT <token>)
bun scripts/bt_e2e.ts connect

# conversational (no tools, just reply)
bun scripts/bt_e2e.ts build

# tools flow (creates site, writes files, reads dev logs)
bun scripts/bt_e2e.ts tools
```

Script writes a unique `chat_id` + `msg_id`, sends signed HMAC webhook, waits
for the async builder, then `/admin/wipe`s the test user. Prints the `bt view
logs --search "<chat_id>"` command to confirm the trace.

**What a healthy `tools` run looks like in BT:**
- Root `webhook.inbound` tagged `phase:build`, `conversation:bt-e2e-chat-...`, tools used
- 16-ish child spans: 1 `builder.run` → 1 `streamText` → ~5 `doStream` + ~4 `tool.<name>` + ~4 `<name>` (wrapAISDK auto)
- Root metrics: `tool_calls ≥ 3`, `llm_calls ≥ 2`, `cost_usd > 0`, `duration` ~10–20s

---

## `/trace score` — run scorers on recent prod turns

Three trace-scope scorers live in `text.ara.so/backend/evals/scorers/`. Each
takes a `webhook.inbound` root span and returns `{score: 0..1, reason, metadata}`.

| scorer | type | catches |
|---|---|---|
| `tool_budget_ok`     | code         | **speed-first**: end-to-end duration (55%) + minimal tool use (30%) + rounds/LLM/cost tiebreakers (15%). Soft-exponential decay past budget (2× ≈ 0.37). Budgets: 30s duration, 8 tool calls, 5 rounds. |
| `builder_outcome_ok` | code         | hard gates: `outcome==ok`, zero tool errors, non-trivial reply, URL present |
| `preview_content_ok` | LLM judge    | intent mismatch + **hallucinated actions** — agent claimed something tools never did (G-Eval rubric, Cerebras `zai-glm-4.7`, `reasoning_effort: low`) |

**Local run — no upload, fast feedback loop:**

```bash
cd text.ara.so/backend
bun run scripts/score-recent-traces.ts 30                 # 30 most recent turns
LIMIT=50 WINDOW=24h bun run scripts/score-recent-traces.ts
```

Prints per-scorer histogram, mean/p50/std, and pearson correlation + precision/recall
against a ground-truth `hadError` signal (`outcome != "ok" OR tool_errors > 0`).
Then dumps the bottom-3 examples per scorer with the user text, agent reply, and
the scorer's one-line rationale.

**Ship as a Braintrust experiment (online scoring / regression comparison):**

```bash
cd text.ara.so/backend
npx braintrust eval evals/trace-scorers.eval.ts --push
```

**What "valuable" looks like on healthy prod traffic:**
- `builder_outcome_ok`: pearson ≈ 1.00, 100% precision/recall — tight watchdog for real crashes.
- `tool_budget_ok`: pearson ≈ 0.88, ~50% precision — surfaces "slow and/or tool-thrashing" traces the hard-gate scorer misses. A 176s max-rounds run scores ~0.03; a 31s healthy build with 16 tool calls scores ~0.75.
- `preview_content_ok`: low correlation with ground-truth *by design* — it catches silent hallucinations like `"Deploy it" → agent replies "now live! 🚀" with zero tools invoked`. Empty `tools: []` tags on a trace that claimed a deploy is the canonical catch.

**Cost:** ~300 judge tokens per trace at `reasoning_effort: low`. 30 turns ≈ pennies.

**Gotcha:** `zai-glm-4.7` is a reasoning model. Keep judge `maxOutputTokens ≥ 2000` and `providerOptions.cerebras.reasoning_effort: "low"`, or you'll see empty `text` with `finishReason: "length"` and 100% reasoning tokens.

---

## `/trace health` — is instrumentation live?

```bash
curl -sS https://website-agent-production-9ace.up.railway.app/healthz | jq '{bt_enabled, git_sha, db_configured, verify_mode}'

# Synthetic smoke span — fires bt.smoke into BT:
curl -sS -X POST https://website-agent-production-9ace.up.railway.app/admin/bt-test \
  -H "x-admin-token: \$ADMIN_WIPE_TOKEN" -H "x-note: manual-check"

# Then verify:
bt view logs --project Ara --search "manual-check" --window 5m --limit 1 --json
```

If `bt_enabled=false` on `/healthz`, `BRAINTRUST_API_KEY` is missing on Railway.

---

## Workflow: debugging a reported bug

User says "my deploy for fetch-dogs didn't work":

1. **Find their phone's recent turns:**
   ```bash
   bt view logs --project Ara --search "<phone>" --window 24h --limit 10 --json
   ```
2. **Open the most recent `webhook.inbound` with `tool:deploy` tag** — look at root `metrics.tool_calls`, `metrics.tool_fails`, `metadata.last_primary_url`.
3. **Walk to `tool.deploy` span** — its `output` has `{ok, url, vercel_url, exit_code, mode, stage_timings, logs_tail}`.
4. **If `ok=false`** — read `logs_tail` for the Vercel stderr.
5. **If `tool.deploy` doesn't exist** — check for `deploy.force` (safety net); if it's also missing, the model never tried. Look at the final `doStream`'s output to see why.
6. **Cross-reference Supabase** — `deployments` table row for that `site_id`.

---

## Quick reference

| Command | Purpose |
|---------|---------|
| `bt view logs --project Ara` | Interactive log browser |
| `bt view logs --project Ara --search <term>` | Substring / tag search |
| `bt view logs --project Ara --window 24h` | Time window |
| `bt view trace --trace-id <root> --project Ara --json` | Full span tree |
| `bt view span --object-ref project_logs:<pid> --id <sid>` | Full untruncated span |
| `bt sql "<query>"` | Ad-hoc SQL across spans |
| `bt status --json` | Confirm active org/project |
| `bun run scripts/score-recent-traces.ts N` | Run 3 scorers on last N `webhook.inbound` roots |
| `npx braintrust eval evals/trace-scorers.eval.ts --push` | Ship scorers as a BT experiment |

See `/braintrust` for general `bt` CLI reference.
