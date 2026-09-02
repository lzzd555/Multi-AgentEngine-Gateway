#!/bin/bash
# Resolve node/npm through nvm for shells that skip ~/.zshrc (non-interactive zsh, cron, CI).
# Usage: scripts/with-node.sh <command> [args...]   e.g. scripts/with-node.sh npm --prefix bridge test
set -e
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at $NVM_DIR (set NVM_DIR or install nvm)" >&2
  exit 1
fi
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
# Prefer the version pinned by this repo's .nvmrc; fall back to nvm's default alias.
nvm use --silent 2>/dev/null || nvm use --silent default
exec "$@"
