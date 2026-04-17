// ae context — write CLAUDE.md into a worktree so Claude knows its full session
// context on startup: agent identity, ports, ngrok URLs, cmux surfaces, skills.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type WorktreeContext = {
  name: string;
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
};

export function writeWorktreeContext(ctx: WorktreeContext): void {
  writeFileSync(
    resolve(ctx.wt, "CLAUDE.md"),
    `# Worktree — agent-${ctx.n}

You are an AI agent running inside worktree \`${ctx.wt}\` on branch \`wt/${ctx.name}\`.

## Identity
- Agent: ${ctx.n} · ${ctx.devEmail} / ${ctx.devPassword}

## Services running beside you (right pane, bottom tabs)
| Tab | Service   | Local port  | Public URL                      | Surface    |
|-----|-----------|-------------|----------------------------------|------------|
| 1   | App       | ${ctx.app}  | https://${ctx.appDomain}         | ${ctx.s1}  |
| 2   | Marketing | ${ctx.mkt}  | https://${ctx.mktDomain}         | ${ctx.s2}  |
| 3   | API       | ${ctx.api}  | https://${ctx.apiDomain}         | ${ctx.s3}  |
| 4   | Ngrok     | 4040        | —                                | ${ctx.s4}  |

## Cmux layout
- Workspace: \`${ctx.ws}\`
- Browser: \`${ctx.browser}\` (app frontend)
- Your shell: left pane of \`${ctx.ws}\`

## Talking to cmux
\`\`\`bash
cmux send --workspace ${ctx.ws} --surface ${ctx.s1} "some command\\n"
cmux capture-pane --workspace ${ctx.ws} --surface ${ctx.s3} --scrollback
cmux navigate --workspace ${ctx.ws} --surface ${ctx.browser} --url https://${ctx.appDomain}
cmux notify --title "Done" --body "your message"
\`\`\`

## Skills
Run \`ae list\` to see all available skills, or invoke with \`/skillname\`.
Key ones: \`/feat\`, \`/pr\`, \`/push\`, \`/review\`, \`/ready\`, \`/axiom\`, \`/posthog\`.
`,
  );
}
