---
name: linear
version: 1.0.0
description: |
  Linear issue tracking — create issues when features are discussed, assign on start, move through In Progress → Done. Always active during coding sessions.
allowed-tools:
  - Bash
  - Read
  - MCP
---

# /linear — Issue Tracking

Always active. Any work discussed in a session should be tracked.

## Workspace

| Field | Value |
|-------|-------|
| Team | **Ara** (key `ARA`) |
| Project | **Ara launch v1** |
| Me | Adi Singh (`me`) |

## Statuses

| Status | When |
|--------|------|
| Todo | Planned, ready to pick up |
| In Progress | Actively working |
| In Review | PR attached, awaiting review |
| Done | Merged/shipped |

## Rules

### Feature discussed → create issue

1. Search first: `list_issues(query: "...", team: "Ara")`
2. If none: `save_issue(title, description, team: "Ara", project: "Ara launch v1", state: "Todo")`
3. Report the identifier (e.g. `ARA-42`)

### Work starts → assign + In Progress

```
save_issue(id: "ARA-42", assignee: "me", state: "In Progress")
```

### PR opened → In Review

```
save_issue(id: "ARA-42", state: "In Review", links: [{url: "<pr_url>", title: "PR #N"}])
```

### Done → mark Done

```
save_issue(id: "ARA-42", state: "Done")
```

## MCP tools

| Action | Tool | Key params |
|--------|------|------------|
| Search | `list_issues` | `query`, `team: "Ara"` |
| Create / update | `save_issue` | `title`, `team`, `state`, `assignee`, `links` |
| List statuses | `list_issue_statuses` | `team: "Ara"` |
| My profile | `get_user` | `query: "me"` |
