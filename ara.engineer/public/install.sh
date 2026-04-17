#!/usr/bin/env bash
# ae installer — curl -fsSL https://ara.engineer/install | sh
#
# Clones ara.engineer, installs bun deps, symlinks `ae` into a PATH dir.
# Idempotent: re-running updates the checkout and refreshes the symlink.

set -euo pipefail

REPO_URL="${AE_REPO_URL:-https://github.com/Aradotso/ara.engineer.git}"
INSTALL_DIR="${AE_INSTALL_DIR:-$HOME/.ae}"
BIN_DIR="${AE_BIN_DIR:-$HOME/.bun/bin}"

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── prerequisites ───────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git is required — install it first"
if ! command -v bun >/dev/null 2>&1; then
  die "bun is required — install with:  curl -fsSL https://bun.sh/install | bash"
fi

# ── clone or update ─────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only --quiet
else
  say "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth=1 --quiet "$REPO_URL" "$INSTALL_DIR"
fi

# ── install deps ────────────────────────────────────────────────────────────
say "Installing dependencies"
(cd "$INSTALL_DIR/cli" && bun install --silent)

# ── link binary ─────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
ln -snf "$INSTALL_DIR/cli/bin/ae" "$BIN_DIR/ae"
say "Linked $BIN_DIR/ae"

# ── warn if not on PATH ─────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*)
    ;;
  *)
    warn "$BIN_DIR is not on your PATH yet."
    warn "Add this to your shell profile:"
    warn "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# ── verify ──────────────────────────────────────────────────────────────────
if "$BIN_DIR/ae" --version >/dev/null 2>&1; then
  printf '\n\033[1;32m✓\033[0m  ae installed: %s\n\n' "$("$BIN_DIR/ae" --version)"
  printf '   Try it:  \033[1mae\033[0m        # help + skill list\n'
  printf '            \033[1mae list\033[0m   # all skills\n\n'
else
  die "install finished but \`ae --version\` didn't work — check $BIN_DIR/ae"
fi
