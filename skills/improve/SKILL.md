---
name: improve
version: 1.0.0
description: |
  Self-improving skill loop. Analyzes the current conversation — what worked, what didn't — and patches ae skills accordingly. Run at the end of a session.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

# /improve — Self-Improving Skill Loop

Analyze the conversation, extract learnings, patch skills. Manually triggered at session end.

## Step 1: Analyze the conversation

Build three lists from everything that happened:

**What worked** — commands/approaches that ran clean, user confirmed without pushback
**What didn't** — failures, corrections ("no not that"), missing context, wrong assumptions
**What was slow** — redundant steps, info that had to be looked up repeatedly

Present these to the user. Get confirmation before making changes.

## Step 2: Map to skills

```bash
ls ~/github/ae/skills/*/SKILL.md | sed 's|.*/skills/||;s|/SKILL.md||' | sort
```

For each learning, identify which skill to patch and what type of fix:

| Fix type | Example |
|----------|---------|
| Missing step | Skill forgot to check X before Y |
| Wrong assumption | Path/config that doesn't exist |
| Better default | Flag should be different |
| New pattern | Workflow that should be codified |
| Dead instruction | References something renamed/removed |
| New skill needed | Repeated workflow with no skill |

## Step 3: Patch skills

For each approved change:

1. Read the current SKILL.md
2. Make the minimal edit — patch surgically, don't rewrite
3. Bump patch version in frontmatter (`1.0.0` → `1.0.1`)
4. For new skills: create `skills/<name>/SKILL.md` following the standard format

**Rules:**
- Minimal diffs — only what the learning requires
- Match existing tone and structure
- Always bump patch version
- No speculative changes — only what was observed
- Explain the why inline when adding new instructions

## Step 4: Commit

```bash
cd ~/github/ae
git add skills/
git commit -m "improve: patch skills from session learnings"
git push origin main
```

## Output

```
/improve complete

Updated:  axiom (v1.0.0 → v1.0.1), ready (v1.0.0 → v1.0.1)
Created:  —
Skipped:  1 learning (no skill match)
```
