#!/usr/bin/env bash
# aracli installer — curl -fsSL https://ara.engineer/install | sh
#
# Clones ara.engineer, installs bun deps, symlinks `aracli` into a PATH dir
# (and `ae` alongside it as a legacy alias during the renaming window).
# Idempotent: re-running updates the checkout and refreshes the symlinks.

set -euo pipefail

REPO_URL="${ARACLI_REPO_URL:-${AE_REPO_URL:-https://github.com/Aradotso/ara.engineer.git}}"
INSTALL_DIR="${ARACLI_INSTALL_DIR:-${AE_INSTALL_DIR:-$HOME/.aracli}}"
BIN_DIR="${ARACLI_BIN_DIR:-${AE_BIN_DIR:-$HOME/.bun/bin}}"

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── prerequisites ───────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git is required — install it first"
if ! command -v bun >/dev/null 2>&1; then
  die "bun is required — install with:  curl -fsSL https://bun.sh/install | bash"
fi

# ── migrate legacy ~/.ae → ~/.aracli (back-compat) ──────────────────────────
# Earlier installs clone'd to ~/.ae. If that exists and the new path doesn't,
# move it rather than re-clone — preserves any local state.
LEGACY_DIR="$HOME/.ae"
if [ -d "$LEGACY_DIR/.git" ] && [ ! -d "$INSTALL_DIR/.git" ] && [ "$LEGACY_DIR" != "$INSTALL_DIR" ]; then
  say "Migrating $LEGACY_DIR → $INSTALL_DIR"
  mv "$LEGACY_DIR" "$INSTALL_DIR"
fi

# ── clone or update ─────────────────────────────────────────────────────────
# Full clone (no --depth) so `aracli update` can count commits behind origin/main.
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating $INSTALL_DIR"
  if [ -f "$INSTALL_DIR/.git/shallow" ]; then
    git -C "$INSTALL_DIR" fetch --unshallow --quiet origin main || true
  fi
  # Repository was renamed ae → ara.engineer on GitHub; fix old remotes.
  current_remote=$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)
  case "$current_remote" in
    *Aradotso/ae*)
      git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
      ;;
  esac
  git -C "$INSTALL_DIR" pull --ff-only --quiet
else
  say "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

# ── install deps ────────────────────────────────────────────────────────────
say "Installing dependencies"
(cd "$INSTALL_DIR/cli" && bun install --silent)

# ── link binary + shortcut shims ────────────────────────────────────────────
# `aracli` is the primary name; `ae` stays as a legacy alias pointing at the
# same binary. Shortcuts cc/cct/cs/cx/ccbg are unchanged.
mkdir -p "$BIN_DIR"
BIN_TARGET="$INSTALL_DIR/cli/bin/aracli"
# Pre-rename fallback — if someone runs this against a pre-rename checkout
# (unlikely after auto-pull above, but defensive).
[ -f "$BIN_TARGET" ] || BIN_TARGET="$INSTALL_DIR/cli/bin/ae"
ln -snf "$BIN_TARGET" "$BIN_DIR/aracli"
ln -snf "$BIN_TARGET" "$BIN_DIR/ae"
linked="aracli, ae (alias)"
if [ -d "$INSTALL_DIR/cli/shims" ]; then
  for shim in "$INSTALL_DIR/cli/shims"/*; do
    [ -f "$shim" ] || continue
    name=$(basename "$shim")
    chmod +x "$shim" 2>/dev/null || true
    ln -snf "$shim" "$BIN_DIR/$name"
    linked="$linked, $name"
  done
fi
say "Linked into $BIN_DIR: $linked"

# ── symlink bundled skills into ~/.claude/skills/ ───────────────────────────
# Every skill under <repo>/skills becomes available as a /skillname slash
# command in Claude Code.
SKILLS_SRC="$INSTALL_DIR/skills"

# Pre-unify installs had cli/skills/ which `git pull` doesn't remove (contents
# become untracked once the directory is renamed in the repo). Wipe it so old
# installs don't hold a ghost copy next to the canonical <repo>/skills.
if [ -d "$SKILLS_SRC" ] && [ -d "$INSTALL_DIR/cli/skills" ]; then
  rm -rf "$INSTALL_DIR/cli/skills"
fi
CLAUDE_SKILLS="$HOME/.claude/skills"
if [ -d "$SKILLS_SRC" ]; then
  mkdir -p "$CLAUDE_SKILLS"
  for skill_dir in "$SKILLS_SRC"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    ln -snf "$skill_dir" "$CLAUDE_SKILLS/$skill_name"
  done
  say "Skills linked into $CLAUDE_SKILLS"
fi

# ── warn if not on PATH ─────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on your PATH yet."
    warn "Add this to your shell profile:"
    warn "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# ── verify ──────────────────────────────────────────────────────────────────
if "$BIN_DIR/aracli" --version >/dev/null 2>&1; then
  printf '\n\033[1;32m✓\033[0m  aracli installed: %s\n\n' "$("$BIN_DIR/aracli" --version)"
  printf '   Try it:  \033[1maracli\033[0m         # help + skill list  (or \033[1mae\033[0m — legacy alias)\n'
  printf '            \033[1maracli list\033[0m    # all skills\n'
  printf '            \033[1maracli update\033[0m  # pull latest and relink\n'
  printf '            \033[1mcc\033[0m, \033[1mcct\033[0m, \033[1mcs\033[0m, \033[1mcx\033[0m, \033[1mccbg\033[0m  # shortcuts (also on PATH)\n\n'
else
  die "install finished but \`aracli --version\` didn't work — check $BIN_DIR/aracli"
fi
