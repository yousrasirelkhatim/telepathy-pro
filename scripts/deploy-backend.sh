#!/usr/bin/env bash
# Deploy Realtime Database rules + Cloud Functions to four-fruits-fun.
# Run from anywhere; resolves the repo from this script's location.
#
# Usage:
#   bash scripts/deploy-backend.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ID="four-fruits-fun"
cd "$REPO_ROOT"

find_firebase() {
  if [[ -x "$HOME/tools/firebase/node_modules/.bin/firebase" ]]; then
    echo "$HOME/tools/firebase/node_modules/.bin/firebase"
    return
  fi
  if command -v firebase >/dev/null 2>&1; then
    command -v firebase
    return
  fi
  if [[ -x "$REPO_ROOT/node_modules/.bin/firebase" ]]; then
    echo "$REPO_ROOT/node_modules/.bin/firebase"
    return
  fi
  echo ""
}

FIREBASE_BIN="$(find_firebase)"
if [[ -z "$FIREBASE_BIN" ]]; then
  echo "firebase CLI not found — installing locally under $HOME/tools/firebase"
  mkdir -p "$HOME/tools/firebase"
  npm install --prefix "$HOME/tools/firebase" firebase-tools@13
  FIREBASE_BIN="$HOME/tools/firebase/node_modules/.bin/firebase"
fi

echo "Using: $FIREBASE_BIN ($("$FIREBASE_BIN" --version))"
echo "Repo:  $REPO_ROOT"
echo "Project: $PROJECT_ID"

if ! "$FIREBASE_BIN" projects:list --non-interactive >/dev/null 2>&1; then
  echo ""
  echo "Not logged in to Firebase."
  echo "This environment cannot complete a Google login in a browser."
  echo "On a machine where you can sign in as a Firebase admin, run:"
  echo ""
  echo "  firebase login"
  echo "  bash $REPO_ROOT/scripts/deploy-backend.sh"
  echo ""
  exit 2
fi

if [[ ! -d "$REPO_ROOT/functions/node_modules" ]]; then
  echo "Installing functions dependencies..."
  npm ci --prefix "$REPO_ROOT/functions"
fi

"$FIREBASE_BIN" deploy --only database,functions --project "$PROJECT_ID" --non-interactive --force
echo "Backend deploy complete."
