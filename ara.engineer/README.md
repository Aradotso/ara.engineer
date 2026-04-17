# ara.engineer

Static landing page for the `ae` CLI. Deployed to Vercel at https://ara.engineer.
Sibling of `../cli/` in this repo.

## Files

- `public/index.html` — minimal landing page with install one-liner
- `public/install.sh` — installer served as `curl | sh` target
- `vercel.json` — rewrites `/install` → `/install.sh`, sets caching + security headers

## Dev

```bash
bun run dev           # serves ./public on http://localhost:3210
```

Or just open `public/index.html` in a browser.

## Deploy

First time (from this directory):

```bash
vercel link           # link to the `araso` team project
vercel deploy --prod  # ship it
```

Then set the production domain to `ara.engineer` in the Vercel dashboard
(team: `araso`). DNS for `ara.engineer` should point its A/CNAME at Vercel
per the standard Vercel domain instructions.

## Installer sanity-check

```bash
curl -fsSL http://localhost:3210/install.sh | sh
# or, after deploy:
curl -fsSL https://ara.engineer/install | sh
```

The installer expects the ae source to be clonable from
`github.com/Aradotso/ara.engineer`. Override with `AE_REPO_URL` env var.
