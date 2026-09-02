#!/bin/sh
# refresh-index.sh — rebuild an index and ship it to the server that serves it.
#
# Meant to be run unattended (launchd, cron, systemd timer). It is deliberately
# lazy: it bails out early rather than doing expensive or pointless work.
#
#   on battery        skip (embedding is CPU-heavy)
#   server unreachable skip (laptop is away from the network)
#   index unchanged   skip the upload (it is tens of MB)
#
# The upload is atomic: copy to .tmp, then `mv` on the far side. Writing over
# the file the server is reading can otherwise hand a query half a JSON.
#
# Config via environment, all optional:
#   RAG_SOURCE       vault | karakeep        (default: karakeep)
#   RAG_INDEX_FILE   local index path        (default: .index/<source>.json)
#   RAG_REMOTE_HOST  ssh host or alias       (default: none, upload skipped)
#   RAG_REMOTE_DIR   dir on the remote       (default: /opt/personal-rag/indexes)

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

SOURCE=${RAG_SOURCE:-karakeep}
INDEX_FILE=${RAG_INDEX_FILE:-.index/$SOURCE.json}
REMOTE_HOST=${RAG_REMOTE_HOST:-}
REMOTE_DIR=${RAG_REMOTE_DIR:-/opt/personal-rag/indexes}
REMOTE_NAME=$(basename "$INDEX_FILE")

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Node is not on launchd's PATH; find it the way the shell would.
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

# --- guards ------------------------------------------------------------------

# macOS only; on other platforms pmset is absent and we just carry on.
# RAG_FORCE=1 runs anyway — for a manual refresh when you actually want one.
if [ "${RAG_FORCE:-0}" != "1" ] && command -v pmset >/dev/null 2>&1; then
  if ! pmset -g batt | grep -q "AC Power"; then
    log "on battery, skipping"
    exit 0
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  log "node not found on PATH ($PATH)"
  exit 1
fi

if [ -n "$REMOTE_HOST" ]; then
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" true 2>/dev/null; then
    log "$REMOTE_HOST unreachable, skipping"
    exit 0
  fi
fi

# --- reindex -----------------------------------------------------------------

before=""
[ -f "$INDEX_FILE" ] && before=$(shasum -a 256 "$INDEX_FILE" | cut -d' ' -f1)

log "reindexing $SOURCE"
env_flag=""
[ -f .env ] && env_flag="--env-file=.env"
# Capture rather than pipe: `node … | tail` reports tail's exit status, so a
# failed reindex (Ollama down, for one) would sail past `set -e` and the script
# would go on to report success having done nothing.
# shellcheck disable=SC2086
if ! out=$(node $env_flag index.mjs --source "$SOURCE" --index "$INDEX_FILE" 2>&1); then
  log "reindex FAILED:"
  printf '%s\n' "$out" | tail -5 | sed 's/^/    /'
  exit 1
fi
printf '%s\n' "$out" | tail -1 | sed 's/^/    /'

after=$(shasum -a 256 "$INDEX_FILE" | cut -d' ' -f1)

if [ -z "$REMOTE_HOST" ]; then
  log "no RAG_REMOTE_HOST set, built locally only"
  exit 0
fi

if [ "$before" = "$after" ]; then
  # Still confirm the far side matches: a previous upload may have failed.
  remote=$(ssh "$REMOTE_HOST" "sha256sum '$REMOTE_DIR/$REMOTE_NAME' 2>/dev/null | cut -d' ' -f1" || true)
  if [ "$remote" = "$after" ]; then
    log "unchanged and already in sync, nothing to upload"
    exit 0
  fi
  log "unchanged locally but the remote differs, uploading"
fi

# --- upload, atomically ------------------------------------------------------

size=$(du -h "$INDEX_FILE" | cut -f1)
log "uploading $size to $REMOTE_HOST:$REMOTE_DIR/$REMOTE_NAME"
scp -q "$INDEX_FILE" "$REMOTE_HOST:$REMOTE_DIR/$REMOTE_NAME.tmp"
ssh "$REMOTE_HOST" "mv '$REMOTE_DIR/$REMOTE_NAME.tmp' '$REMOTE_DIR/$REMOTE_NAME'"

remote=$(ssh "$REMOTE_HOST" "sha256sum '$REMOTE_DIR/$REMOTE_NAME' | cut -d' ' -f1")
if [ "$remote" != "$after" ]; then
  log "CHECKSUM MISMATCH: local $after remote $remote"
  exit 1
fi

# The server invalidates its cache on mtime+size, so it picks this up on the
# next question. No restart needed.
log "done, checksums match"
