// ae context — write CLAUDE.md into a worktree so Claude knows its full session
// context on startup: agent identity, ports, ngrok URLs, cmux surfaces, axiom queries.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type WorktreeContext = {
  name: string;
  task: string;
  wt: string;
  n: number;
  devEmail: string;
  devPassword: string;
  app: number;
  mkt: number;
  api: number;
  appDomain: string;
  mktDomain: string;
  apiDomain: string;
  ws: string;
  browser: string;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
  s5: string; // reserved
};

export function writeWorktreeContext(ctx: WorktreeContext): void {
  writeFileSync(
    resolve(ctx.wt, "CLAUDE.md"),
    `# Worktree — agent-${ctx.n}

You are an AI agent running inside worktree \`${ctx.wt}\` on branch \`wt/${ctx.name}\`.
This file is your source of truth for the environment around you.
${ctx.task ? `\n## Task\n\n${ctx.task}\n` : ""}
## Getting started

1. You are already in the correct directory — this worktree is your workspace
2. Run \`/ready\` to verify all CLIs and MCPs are connected
3. Check \`git log origin/main..HEAD\` to see what's on this branch
4. ${ctx.task ? `Implement the task above` : "Ask the user what to build"}

## Identity

- Agent: **${ctx.n}**
- Dev email: \`${ctx.devEmail}\`
- Dev password: \`${ctx.devPassword}\`
- Branch: \`wt/${ctx.name}\`

## Services (right pane, bottom tabs)

| Tab | Service        | Local                       | Public (ngrok)                  | Cmux surface |
|-----|----------------|-----------------------------|---------------------------------|--------------|
| 1   | App            | http://localhost:${ctx.app} | https://${ctx.appDomain}        | \`${ctx.s1}\` |
| 2   | Marketing      | http://localhost:${ctx.mkt} | https://${ctx.mktDomain}        | \`${ctx.s2}\` |
| 3   | API            | http://localhost:${ctx.api} | https://${ctx.apiDomain}        | \`${ctx.s3}\` |
| 4   | Ngrok          | http://127.0.0.1:4040       | —                               | \`${ctx.s4}\` |

**Always use ngrok URLs** when testing webhooks, OAuth redirects, or anything that needs a public URL.
**Always use localhost** for direct API calls from this machine.

## Browser

- Surface: \`${ctx.browser}\` pointing at https://${ctx.appDomain}
- Auth: inject JWT via localStorage — dev credentials above work with the DEV Supabase project
- Navigate: \`cmux navigate --workspace ${ctx.ws} --surface ${ctx.browser} --url <url>\`
- Screenshot: \`cmux browser ${ctx.browser} screenshot\`
- Snapshot: \`cmux browser ${ctx.browser} snapshot --compact\`

## Cmux

- Workspace: \`${ctx.ws}\`

\`\`\`bash
# Read service logs
cmux capture-pane --workspace ${ctx.ws} --surface ${ctx.s1} --scrollback   # app
cmux capture-pane --workspace ${ctx.ws} --surface ${ctx.s3} --scrollback   # api

# Send a command to a service tab
cmux send --workspace ${ctx.ws} --surface ${ctx.s3} "some command\\n"

# Notify when done
cmux notify --title "Done" --body "PR is ready for review"
\`\`\`

## Axiom — logs scoped to your agent

\`\`\`bash
# All logs for your test user
axiom query "['logs'] | where user_email == '${ctx.devEmail}' | sort by _time desc | limit 50"

# API errors from your test user
axiom query "['logs'] | where user_email == '${ctx.devEmail}' and level == 'error' | sort by _time desc | limit 20"

# Live tail — your activity in the last 2 minutes
axiom query "['logs'] | where user_email == '${ctx.devEmail}'" --start-time -2m --format table

# Full session trace (replace sess-xxx with actual session ID from logs)
axiom query "['logs'] | where runtime_session_id == 'sess-xxx' | sort by _time asc"
\`\`\`

## Skills

\`ae list\` — all available skills.
Key ones: \`/ready\`, \`/pr\`, \`/push\`, \`/review\`, \`/test\`, \`/axiom\`, \`/health\`, \`/linear\`.
`,
  );
}
