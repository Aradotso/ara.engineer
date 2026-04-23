// aracli pr — create a PR then wait for review bot comments and auto-fix.
//
// Usage:
//   aracli pr [gh pr create flags...]   create PR + watch for bot reviews
//   aracli pr --watch <number>          watch an existing PR for reviews
//
// Once review comments arrive, prints them and spawns `aracli prr` to auto-fix.

import { $ } from "bun";
$.throws(false);

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

type ReviewComment = {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string };
  diff_hunk: string;
};

type PullReview = {
  id: number;
  state: string;
  body: string;
  user: { login: string };
};

async function gh(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
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

export async function getReviewComments(prNumber: number, nwo: string): Promise<ReviewComment[]> {
  const r = await gh("api", `repos/${nwo}/pulls/${prNumber}/comments`, "--paginate");
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.out) as ReviewComment[];
  } catch {
    return [];
  }
}

export async function getReviews(prNumber: number, nwo: string): Promise<PullReview[]> {
  const r = await gh("api", `repos/${nwo}/pulls/${prNumber}/reviews`);
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.out) as PullReview[];
  } catch {
    return [];
  }
}

function isBotOrReviewer(login: string): boolean {
  return (
    login.endsWith("[bot]") ||
    login.endsWith("-bot") ||
    login.includes("claude") ||
    login.includes("copilot") ||
    login.includes("review")
  );
}

function hasActionableComments(comments: ReviewComment[], reviews: PullReview[]): boolean {
  if (comments.some((c) => c.body.trim().length > 0)) return true;
  if (reviews.some((r) => r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED")) return true;
  return false;
}

async function watchForReviews(prNumber: number, nwo: string): Promise<void> {
  console.log(`\nWatching PR #${prNumber} for review comments (polling every ${POLL_INTERVAL_MS / 1000}s)…`);
  console.log("Press Ctrl-C to stop.\n");

  const seenCommentIds = new Set<number>();
  const seenReviewIds = new Set<number>();
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const [comments, reviews] = await Promise.all([
      getReviewComments(prNumber, nwo),
      getReviews(prNumber, nwo),
    ]);

    const newComments = comments.filter((c) => !seenCommentIds.has(c.id));
    const newReviews = reviews.filter((r) => !seenReviewIds.has(r.id) && (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED"));

    newComments.forEach((c) => seenCommentIds.add(c.id));
    newReviews.forEach((r) => seenReviewIds.add(r.id));

    if (newComments.length > 0 || newReviews.length > 0) {
      console.log(`\n✓ Got ${newComments.length} inline comment(s) and ${newReviews.length} review(s) on PR #${prNumber}.`);

      if (newReviews.length > 0) {
        for (const rev of newReviews) {
          if (rev.body.trim()) {
            console.log(`\n[Review by @${rev.user.login}] ${rev.state}`);
            console.log(rev.body);
          }
        }
      }

      if (hasActionableComments(newComments, newReviews)) {
        console.log("\nRunning aracli prr to auto-fix review comments…\n");
        const proc = Bun.spawn(["ae", "prr"], { stdio: ["inherit", "inherit", "inherit"] });
        await proc.exited;
        return;
      }
    }

    process.stdout.write(".");
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  console.log("\nTimed out waiting for reviews. Run `aracli prr` manually when ready.");
}

export async function prCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`aracli pr — create a GitHub PR and auto-fix bot/agent review comments

Usage:
  aracli pr [gh pr create flags...]   create PR then watch for reviews
  aracli pr --watch [<number>]        watch existing PR (no creation)

After a PR is created (or found), polls for review comments every 15s.
When comments arrive, automatically runs \`aracli prr\` to fix them.
`);
    return 0;
  }

  const watchOnly = argv.includes("--watch");
  const watchIdx = argv.indexOf("--watch");
  let prNumber: number | null = null;

  if (watchOnly) {
    const maybeNum = argv[watchIdx + 1];
    if (maybeNum && /^\d+$/.test(maybeNum)) {
      prNumber = parseInt(maybeNum, 10);
    } else {
      prNumber = await currentPrNumber();
    }
    if (!prNumber) {
      console.error("aracli pr --watch: could not determine PR number. Pass it explicitly: aracli pr --watch <number>");
      return 1;
    }
  } else {
    // Create the PR
    const createArgs = argv.filter((a) => a !== "--watch");
    console.log("Creating PR…\n");
    const proc = Bun.spawn(["gh", "pr", "create", ...createArgs], { stdio: ["inherit", "inherit", "inherit"] });
    const code = await proc.exited;
    if (code !== 0) return code ?? 1;

    prNumber = await currentPrNumber();
    if (!prNumber) {
      console.error("aracli pr: could not determine PR number after creation.");
      return 1;
    }
    console.log(`\nPR #${prNumber} created.`);

    // Open the PR in the browser surface
    const prUrl = await gh("pr", "view", "--json", "url", "-q", ".url");
    if (prUrl.code === 0 && prUrl.out) {
      const browserSurface = process.env.CMUX_BROWSER_SURFACE || "surface:134";
      const nav = Bun.spawn(["cmux", "browser", browserSurface, "tab", "new", prUrl.out], { stdout: "pipe", stderr: "pipe" });
      await nav.exited;
      console.log(`Opened ${prUrl.out} in browser`);
    }
  }

  const nwo = await getRepoNwo();
  await watchForReviews(prNumber, nwo);
  return 0;
}
