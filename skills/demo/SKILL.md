---
name: demo
version: 1.0.0
description: |
  Record and post an animated demo of a UI feature built in an ae worktree. Full pipeline:
  preview (screenshots) → confirm state → record once (Playwright v1.59 page.screencast with
  chapter overlays) → convert webm→mp4→gif → upload to Cloudflare R2 → post inline to GitHub PR.
  Use after building any UI change to produce visual proof on the PR.
triggers:
  - "demo"
  - "record a demo"
  - "demo the feature"
  - "show proof on pr"
  - "record and post"
  - "visual proof"
  - "screencast the feature"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# /ae-demo — Record & Post UI Feature Demo

Record a demo of the current feature, upload to R2, and post the animated GIF inline to the PR.
One command, 18–25 seconds end-to-end.

## Prerequisites

These are pre-installed in every ae worktree:
- **playwright** — `bun x playwright` (v1.59+, uses `page.screencast` API)
- **ffmpeg-static** — `~/.bun/install/global/node_modules/ffmpeg-static/ffmpeg`
- **R2 credentials** — in Railway `ara-api` service as `R2_*` env vars

Check:
```bash
bun x playwright --version   # must be 1.59+
ls ~/.bun/install/global/node_modules/ffmpeg-static/ffmpeg
```

## The workflow

### Step 1 — Write the demo script

Create `demo.mjs` in the current worktree. The script must:
1. **PREVIEW PHASE**: Navigate, take 3 screenshots (`verify-1-initial.png`, `verify-2-feature.png`, `verify-3-zoomed.png`), read them to confirm correct state
2. **RECORD PHASE**: Same browser session (no re-navigate), `page.screencast.start()` → overlays → zoom → click/interact → `page.screencast.stop()`
3. **CONVERT PHASE**: webm→mp4→gif via ffmpeg-static, adaptive compression until <1MB
4. **UPLOAD PHASE**: R2 upload, fallback to img402.dev free tier if R2 unavailable

Use `page.screencast.showOverlay(html)` (NOT `showChapter`) for custom-styled bottom pill overlays:

```javascript
function overlay(title, sub = '') {
  return `<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  .c{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    background:rgba(10,10,10,0.75);backdrop-filter:blur(12px);
    border:1px solid rgba(255,255,255,0.10);border-radius:10px;
    padding:9px 18px;display:inline-flex;flex-direction:column;align-items:center;gap:2px;
    white-space:nowrap;font-family:'Inter',-apple-system,sans-serif;}
  .t{font-size:13px;font-weight:400;color:rgba(255,255,255,0.92);letter-spacing:.01em}
  .s{font-size:11px;font-weight:300;color:rgba(255,255,255,0.48);letter-spacing:.01em}
  </style>
  <div class="c"><span class="t">${title}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
}
```

### Step 2 — Zoom into the feature

Use CSS zoom + scroll to zoom into the element being demoed:

```javascript
// Get element's bounding box, then zoom in on it
const box = await page.locator('[data-feature]').boundingBox();
await page.evaluate((b) => {
  document.documentElement.style.zoom = '3';
  window.scrollTo(
    Math.max(0, (b.x + b.width) * 3 - window.innerWidth + 60),
    Math.max(0, b.y * 3 - 60)
  );
}, box);
await page.screencast.showOverlay(overlay('Feature name', 'subtitle'), { duration: 2000 });
await page.waitForTimeout(2200);

// Reset zoom before clicking (avoids fixed-element interception)
await page.evaluate(() => { document.documentElement.style.zoom = ''; window.scrollTo(0, 0); });
await page.waitForTimeout(300);
// Click via JS to bypass any fixed overlays
await page.evaluate(() => document.querySelector('[data-feature]')?.click());
```

### Step 3 — Upload to R2

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, statSync } from 'fs';

const R2_ACCOUNT_ID  = '097e7d8020626b38c195652db5a3e4e0';
const R2_ACCESS_KEY  = '82ab40c13f3a1b6276d6d76e2591fa0a';
const R2_SECRET_KEY  = '14a287e521f74707f46f827ca0cf1b93265d8be9192fa14b3b48e97a73569163';
const R2_PUBLIC_BASE = 'https://pub-a5b9a6b31015449abea14bc3d863e55c.r2.dev';
const R2_BUCKET      = 'ara-proofshot';

async function uploadToR2(gifPath) {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  });
  const key = `proofshot/${Date.now()}-demo.gif`;
  const body = readFileSync(gifPath);
  const resp = await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: body, ContentType: 'image/gif',
  }));
  if (resp.$metadata.httpStatusCode !== 200) throw new Error('R2 upload failed');
  return `${R2_PUBLIC_BASE}/${key}`;
}
```

### Step 4 — Convert webm → gif (adaptive)

```javascript
import { execFileSync } from 'child_process';
import { statSync } from 'fs';

const FFMPEG = `${process.env.HOME}/.bun/install/global/node_modules/ffmpeg-static/ffmpeg`;

function makeGif(mp4Path, gifPath) {
  const configs = [
    'fps=5,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer',
    'fps=4,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=48[p];[s1][p]paletteuse=dither=bayer',
    'fps=4,scale=560:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=32[p];[s1][p]paletteuse=dither=bayer',
    'fps=3,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=24[p];[s1][p]paletteuse=dither=bayer',
  ];
  for (const vf of configs) {
    execFileSync(FFMPEG, ['-y', '-i', mp4Path, '-vf', vf, '-loop', '0', gifPath], { stdio: 'pipe' });
    const size = statSync(gifPath).size;
    const px = vf.match(/scale=(\d+)/)?.[1];
    console.log(`  [gif] ${Math.round(size/1024)}KB @ ${px}px`);
    if (size < 1024 * 1024) return size; // under 1MB — good for R2 + img402 free
  }
  return statSync(gifPath).size;
}
```

### Step 5 — Post to PR

```bash
# Write body to file (avoids shell escaping issues)
cat > /tmp/pr-demo-body.md << 'BODY'
## 🎬 Feature name — demo

Description of what changed.

![demo](GIF_URL_HERE)
BODY

gh pr comment PR_NUMBER --body-file /tmp/pr-demo-body.md
```

Or auto-detect the PR number:
```bash
PR=$(gh pr view --json number -q '.number' 2>/dev/null)
gh pr comment "$PR" --body-file /tmp/pr-demo-body.md
```

## Full template: demo.mjs

```javascript
import { chromium } from 'playwright';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { execFileSync, execSync } from 'child_process';
import { statSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = `${process.env.HOME}/.bun/install/global/node_modules/ffmpeg-static/ffmpeg`;

// R2 config
const R2_ACCOUNT_ID  = '097e7d8020626b38c195652db5a3e4e0';
const R2_ACCESS_KEY  = '82ab40c13f3a1b6276d6d76e2591fa0a';
const R2_SECRET_KEY  = '14a287e521f74707f46f827ca0cf1b93265d8be9192fa14b3b48e97a73569163';
const R2_PUBLIC_BASE = 'https://pub-a5b9a6b31015449abea14bc3d863e55c.r2.dev';
const R2_BUCKET      = 'ara-proofshot';

function overlay(title, sub = '') {
  return `<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  .c{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    background:rgba(10,10,10,0.75);backdrop-filter:blur(12px);
    border:1px solid rgba(255,255,255,0.10);border-radius:10px;
    padding:9px 18px;display:inline-flex;flex-direction:column;align-items:center;gap:2px;
    white-space:nowrap;font-family:'Inter',-apple-system,sans-serif;}
  .t{font-size:13px;font-weight:400;color:rgba(255,255,255,0.92);letter-spacing:.01em}
  .s{font-size:11px;font-weight:300;color:rgba(255,255,255,0.48);letter-spacing:.01em}
  </style>
  <div class="c"><span class="t">${title}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
}

const T = { start: performance.now() };
const lap = (k) => { T[k] = performance.now(); console.log(`  [${k}] +${(T[k]-T.start).toFixed(0)}ms`); };

const webm = path.join(__dirname, 'demo.webm');
const mp4  = path.join(__dirname, 'demo.mp4');
const gif  = path.join(__dirname, 'demo.gif');

// ── PHASE 1: PREVIEW ────────────────────────────────────────────────────────
console.log('\n━━━ PHASE 1: PREVIEW ━━━');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
lap('navigate');

// SCREENSHOT 1: initial state
await page.screenshot({ path: path.join(__dirname, 'verify-1-initial.png') });

// Wait for the feature to be in the right state
// TODO: replace with your selector
await page.waitForSelector('YOUR_SELECTOR_HERE', { timeout: 10000 }).catch(() => {});
lap('wait-for-state');

// SCREENSHOT 2: feature visible
await page.screenshot({ path: path.join(__dirname, 'verify-2-feature.png') });

// SCREENSHOT 3: zoom into key element
const el = await page.$('YOUR_SELECTOR_HERE');
if (el) {
  const box = await el.boundingBox();
  await page.evaluate((b) => {
    document.documentElement.style.zoom = '3';
    window.scrollTo(Math.max(0, (b.x + b.width/2) * 3 - window.innerWidth/2), Math.max(0, b.y * 3 - 80));
  }, box);
  await page.screenshot({ path: path.join(__dirname, 'verify-3-zoomed.png') });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; window.scrollTo(0, 0); });
}
lap('preview');

// ── AGENT READS SCREENSHOTS HERE ────────────────────────────────────────────
// Read verify-1, verify-2, verify-3 → confirm feature is visible → proceed

// ── PHASE 2: RECORD (same session) ──────────────────────────────────────────
console.log('\n━━━ PHASE 2: RECORD ━━━');
await page.screencast.start({ path: webm });

// Wide shot with overlay
await page.screencast.showOverlay(overlay('FEATURE NAME', 'brief description'), { duration: 2000 });
await page.waitForTimeout(2200);
lap('wide-shot');

// Zoom in on key element
if (el) {
  const box = await (await page.$('YOUR_SELECTOR_HERE'))?.boundingBox();
  if (box) {
    await page.evaluate((b) => {
      document.documentElement.style.zoom = '3';
      window.scrollTo(Math.max(0, (b.x + b.width) * 3 - window.innerWidth + 60), Math.max(0, b.y * 3 - 60));
    }, box);
    await page.screencast.showOverlay(overlay('key element', 'what it does'), { duration: 2000 });
    await page.waitForTimeout(2200);
    lap('zoom-in');

    // Reset + interact
    await page.evaluate(() => { document.documentElement.style.zoom = ''; window.scrollTo(0, 0); });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('YOUR_SELECTOR_HERE')?.click());
    await page.waitForTimeout(800);
    lap('interact');
  }
}

await page.screencast.showOverlay(overlay('Done', 'feature verified'), { duration: 1400 });
await page.waitForTimeout(1200);
await page.screencast.stop();
await browser.close();
lap('record-done');

// ── PHASE 3: CONVERT ─────────────────────────────────────────────────────────
console.log('\n━━━ PHASE 3: CONVERT ━━━');
execFileSync(FFMPEG, ['-y','-i',webm,'-c:v','libx264','-preset','fast','-crf','22',
  '-movflags','+faststart','-pix_fmt','yuv420p',mp4], { stdio:'pipe' });
lap('mp4');

const configs = [
  'fps=5,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer',
  'fps=4,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=48[p];[s1][p]paletteuse=dither=bayer',
  'fps=4,scale=560:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=32[p];[s1][p]paletteuse=dither=bayer',
  'fps=3,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=24[p];[s1][p]paletteuse=dither=bayer',
];
for (const vf of configs) {
  execFileSync(FFMPEG, ['-y','-i',mp4,'-vf',vf,'-loop','0',gif], { stdio:'pipe' });
  const size = statSync(gif).size;
  if (size < 1024*1024) break;
}
lap('gif');

// ── PHASE 4: UPLOAD ──────────────────────────────────────────────────────────
console.log('\n━━━ PHASE 4: UPLOAD ━━━');
let gifUrl = '';
try {
  const s3 = new S3Client({ region:'auto',
    endpoint:`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials:{ accessKeyId:R2_ACCESS_KEY, secretAccessKey:R2_SECRET_KEY }});
  const key = `proofshot/${Date.now()}-demo.gif`;
  await s3.send(new PutObjectCommand({ Bucket:R2_BUCKET, Key:key, Body:readFileSync(gif), ContentType:'image/gif' }));
  gifUrl = `${R2_PUBLIC_BASE}/${key}`;
  lap('r2-upload');
} catch {
  // Fallback: img402 free tier (<1MB)
  const res = JSON.parse(execSync(`curl -sf -F "image=@${gif}" https://img402.dev/api/free`).toString());
  gifUrl = res.url;
  lap('img402-upload');
}
console.log(`  [url] ${gifUrl}`);

// ── PHASE 5: POST TO PR ───────────────────────────────────────────────────────
console.log('\n━━━ PHASE 5: PR COMMENT ━━━');
const PR = execSync('gh pr view --json number -q .number 2>/dev/null').toString().trim();
const body = `## 🎬 FEATURE NAME — demo\n\nBrief description of what changed.\n\n![demo](${gifUrl})`;
writeFileSync('/tmp/ae-demo-body.md', body);
execSync(`gh pr comment ${PR} --body-file /tmp/ae-demo-body.md`, { stdio:'inherit' });
lap('pr-comment');

console.log(`\n✅ TOTAL: ${((performance.now()-T.start)/1000).toFixed(1)}s`);
```

## Run it

```bash
export NODE_PATH=~/.bun/install/global/node_modules
bun demo.mjs
```

## Key rules

- **Always preview first** — read all 3 verify screenshots before recording. Never record blind.
- **Same browser session** — don't close and re-open. The state from preview carries into recording.
- **JS click to interact** — use `page.evaluate(() => el.click())` not `page.click()` after CSS zoom to avoid fixed-element interception.
- **img402 fallback** — if R2 fails, img402.dev free tier works (under 1MB). Both use Cloudflare CDN and pass GitHub camo for private repos.
- **DO NOT** use `showChapter()` for styling — use `showOverlay(html)` with custom Inter CSS for the Ara bottom pill style.
- **Body file** — always write PR comment body to a file and use `--body-file`. Avoids shell escaping issues with backticks and special chars.

## Timing reference (ae wt on M-series Mac)

| Step | Time |
|------|------|
| Navigate + preview | ~3s |
| Wait for feature state | 0–5s |
| Wide shot + overlays | ~4s |
| Zoom + interact | ~4s |
| webm→mp4 | ~200ms |
| mp4→gif (adaptive) | ~500ms |
| R2 upload | ~300ms |
| gh pr comment | ~1s |
| **Total** | **~18–25s** |
