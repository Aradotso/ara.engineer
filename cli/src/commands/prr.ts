// aracli prr — PR Review: read review comments on the current PR, fix them with Claude.
//
// Usage:
//   aracli prr              read comments on current branch's PR, auto-fix with claude
//   aracli prr --dry-run    print the fix prompt without running claude
//   aracli prr <number>     target a specific PR number

import { $ } from "bun";
$.throws(false);
import { getReviewComments, getReviews } from "./pr.ts";

async function gh(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out: out.trim() };
}

async function currentPrNumber(): Promise<number | null> {
  const r = await gh("pr", "view", "--json", "number", "-q", ".number");
  if (r.code !== 0) return null;
  const n = parseInt(r.out, 10);
  return isNaN(n) ? null : n;
}

async function getRepoNwo(): Promise<string> {
  const r = await gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
  return r.out || "";
}

function buildFixPrompt(
  prTitle: string,
  prUrl: string,
  comments: Awaited<ReturnType<typeof getReviewComments>>,
  reviews: Awaited<ReturnType<typeof getReviews>>,
): string {
  const lines: string[] = [];
  lines.push(`Fix the following review comments on PR: ${prTitle}`);
  lines.push(`URL: ${prUrl}`);
  lines.push("");

  const actionableReviews = reviews.filter(
    (r) => (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") && r.body.trim(),
  );
  if (actionableReviews.length > 0) {
    lines.push("## Review summaries");
    lines.push("");
    for (const r of actionableReviews) {
      lines.push(`### @${r.user.login} (${r.state})`);
      lines.push(r.body.trim());
      lines.push("");
    }
  }

  if (comments.length > 0) {
    lines.push("## Inline comments to fix");
    lines.push("");
    // Group by file
    const byFile = new Map<string, typeof comments>();
    for (const c of comments) {
      const arr = byFile.get(c.path) ?? [];
      arr.push(c);
      byFile.set(c.path, arr);
    }
    for (const [file, fileComments] of byFile) {
      lines.push(`### ${file}`);
      lines.push("");
      for (const c of fileComments) {
        if (c.line) lines.push(`Line ${c.line}:`);
        lines.push("```diff");
        lines.push(c.diff_hunk.trim());
        lines.push("```");
        lines.push(`> @${c.user.login}: ${c.body.trim()}`);
        lines.push("");
      }
    }
  }

  lines.push("---");
  lines.push("Address every comment above. Make the minimal changes needed. Do not add unrequested features.");
  lines.push("After fixing, commit with: `git commit -m 'fix: address PR review comments'`");

  return lines.join("\n");
}

export async function prrCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`aracli prr — fix review comments on the current PR using Claude

Usage:
  aracli prr              fetch comments on current branch's PR, auto-fix
  aracli prr <number>     target a specific PR number
  aracli prr --dry-run    print the fix prompt without running claude
  aracli prr --print      same as --dry-run
`);
    return 0;
  }

  const dryRun = argv.includes("--dry-run") || argv.includes("--print");
  const maybeNum = argv.find((a) => /^\d+$/.test(a));
  let prNumber = maybeNum ? parseInt(maybeNum, 10) : null;

  if (!prNumber) {
    prNumber = await currentPrNumber();
    if (!prNumber) {
      console.error("aracli prr: not on a PR branch. Create one with `aracli pr` or pass a PR number.");
      return 1;
    }
  }

  const nwo = await getRepoNwo();
  const prInfo = await gh("pr", "view", String(prNumber), "--json", "title,url");
  let prTitle = `PR #${prNumber}`;
  let prUrl = "";
  try {
    const d = JSON.parse(prInfo.out);
    prTitle = d.title || prTitle;
    prUrl = d.url || "";
  } catch {}

  console.log(`Fetching review comments for PR #${prNumber}: ${prTitle}`);

  const [comments, reviews] = await Promise.all([
    getReviewComments(prNumber, nwo),
    getReviews(prNumber, nwo),
  ]);

  const actionableReviews = reviews.filter(
    (r) => r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED",
  );

  if (comments.length === 0 && actionableReviews.length === 0) {
    console.log("No review comments found on this PR yet.");
    return 0;
  }

  console.log(`Found ${comments.length} inline comment(s) and ${actionableReviews.length} review(s).`);

  const prompt = buildFixPrompt(prTitle, prUrl, comments, actionableReviews);

  if (dryRun) {
    console.log("\n--- Fix prompt ---\n");
    console.log(prompt);
    return 0;
  }

  // Pipe the prompt to claude as a task
  console.log("\nHanding off to Claude Code to fix…\n");
  const proc = Bun.spawn(
    ["claude", "--dangerously-skip-permissions", "--print", prompt],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  const code = await proc.exited;
  return code ?? 0;
}
