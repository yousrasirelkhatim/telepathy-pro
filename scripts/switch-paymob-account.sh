#!/usr/bin/env bash
# =============================================================================
# switch-paymob-account.sh
# -----------------------------------------------------------------------------
# Safely switch the Paymob account used by Telepathy Challenge without exposing
# any secret in shell history, chat transcripts, or process listings.
#
# Reads new credentials from a local .env.paymob.new file (never committed),
# updates Firebase Functions Secret Manager, updates RTDB settings/, redeploys
# functions, then wipes the .env.paymob.new file.
#
# Usage:
#   1) Copy scripts/.env.paymob.example  →  scripts/.env.paymob.new
#   2) Fill the 4 values from the new Paymob account.
#   3) Run:  bash scripts/switch-paymob-account.sh
#
# Requirements on your local machine:
#   - firebase CLI logged in (firebase login)
#   - Node.js (used by firebase CLI)
#   - Admin access to the four-fruits-fun Firebase project
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.paymob.new"
PROJECT_ID="four-fruits-fun"
DATABASE_URL="https://four-fruits-fun-default-rtdb.firebaseio.com"

# ---- Colors (only if TTY) --------------------------------------------------
if [[ -t 1 ]]; then
  C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YLW='\033[1;33m'; C_BLU='\033[0;34m'; C_DIM='\033[2m'; C_RST='\033[0m'
else
  C_RED=; C_GRN=; C_YLW=; C_BLU=; C_DIM=; C_RST=
fi

log()  { printf "${C_BLU}[switch-paymob]${C_RST} %s\n" "$*"; }
ok()   { printf "${C_GRN}[  OK  ]${C_RST} %s\n" "$*"; }
warn() { printf "${C_YLW}[ WARN ]${C_RST} %s\n" "$*"; }
err()  { printf "${C_RED}[ FAIL ]${C_RST} %s\n" "$*" 1>&2; }

# ---- 0) Pre-flight checks --------------------------------------------------
log "Pre-flight checks…"

if ! command -v firebase >/dev/null 2>&1; then
  err "firebase CLI not found. Install with:  npm i -g firebase-tools"
  exit 1
fi

if ! firebase projects:list 2>/dev/null | grep -q "$PROJECT_ID"; then
  err "You are not logged in to Firebase, or you don't have access to $PROJECT_ID."
  err "Run:  firebase login   (and make sure the account has admin on this project)"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  err "Missing $ENV_FILE"
  err "Copy the template first:"
  err "    cp scripts/.env.paymob.example scripts/.env.paymob.new"
  err "Then fill the 4 values from the NEW Paymob account and re-run this script."
  exit 1
fi

# Ensure .env.paymob.new is NOT tracked by git
if git -C "$REPO_ROOT" ls-files --error-unmatch "scripts/.env.paymob.new" >/dev/null 2>&1; then
  err "SECURITY: scripts/.env.paymob.new is tracked by git. Remove it before proceeding:"
  err "    git rm --cached scripts/.env.paymob.new"
  exit 1
fi

ok "firebase CLI ready and project $PROJECT_ID reachable."

# ---- 1) Load .env.paymob.new (in this shell only) --------------------------
log "Loading new credentials from $ENV_FILE…"
# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${PAYMOB_SECRET_KEY:?PAYMOB_SECRET_KEY is empty in $ENV_FILE}"
: "${PAYMOB_HMAC_SECRET:?PAYMOB_HMAC_SECRET is empty in $ENV_FILE}"
: "${PAYMOB_PUBLIC_KEY:?PAYMOB_PUBLIC_KEY is empty in $ENV_FILE}"
: "${PAYMOB_INTEGRATION_IDS:?PAYMOB_INTEGRATION_IDS is empty in $ENV_FILE}"

# Sanity: integration IDs must be digits separated by commas / spaces / pipes
if ! printf '%s' "$PAYMOB_INTEGRATION_IDS" | grep -Eq '^[0-9]+([,|[:space:]][0-9]+)*$'; then
  err "PAYMOB_INTEGRATION_IDS looks malformed: '$PAYMOB_INTEGRATION_IDS'"
  err "Expected digits separated by commas, e.g. 12345,67890"
  exit 1
fi

ok "All 4 credentials present and syntactically valid."

# ---- 2) Confirm before applying --------------------------------------------
echo
warn "You are about to REPLACE the Paymob account on project '$PROJECT_ID'."
warn "The 4 secrets will be rotated in Firebase Functions Secret Manager."
warn "RTDB settings/paymobPublicKey and settings/paymobIntegrationIds will be updated."
warn "Cloud Functions will be redeployed after the secrets are set."
echo
read -r -p "Type YES to proceed: " CONFIRM
if [[ "$CONFIRM" != "YES" ]]; then
  err "Aborted."
  exit 1
fi

# ---- 3) Push secrets to Firebase Secret Manager ----------------------------
push_secret() {
  local name="$1" value="$2"
  log "Setting secret: $name"
  # firebase functions:secrets:set reads from stdin when we pipe.
  printf '%s' "$value" | firebase --project "$PROJECT_ID" functions:secrets:set "$name" --data-file=- >/dev/null
  ok "Secret $name updated."
}

push_secret "PAYMOB_SECRET_KEY"      "$PAYMOB_SECRET_KEY"
push_secret "PAYMOB_HMAC_SECRET"     "$PAYMOB_HMAC_SECRET"
push_secret "PAYMOB_PUBLIC_KEY"      "$PAYMOB_PUBLIC_KEY"
push_secret "PAYMOB_INTEGRATION_IDS" "$PAYMOB_INTEGRATION_IDS"

# ---- 4) Update RTDB settings (public key + integration IDs) ----------------
# Only the non-secret values are stored in RTDB (for the client fallback).
log "Updating RTDB settings/paymobPublicKey and settings/paymobIntegrationIds…"

TMP_PATCH="$(mktemp)"
trap 'rm -f "$TMP_PATCH"' EXIT

# Normalize integration IDs: comma-separated only (schema is length <= 80)
NORMALIZED_INTEG="$(printf '%s' "$PAYMOB_INTEGRATION_IDS" | tr '|[:space:]' ',,' | sed -E 's/,+/,/g; s/^,//; s/,$//')"

cat > "$TMP_PATCH" <<JSON
{
  "paymobPublicKey": "$PAYMOB_PUBLIC_KEY",
  "paymobIntegrationIds": "$NORMALIZED_INTEG",
  "paymobEnabled": true
}
JSON

firebase --project "$PROJECT_ID" database:update /settings "$TMP_PATCH" \
  --instance "${PROJECT_ID}-default-rtdb" \
  --confirm >/dev/null
ok "RTDB /settings updated (paymobPublicKey, paymobIntegrationIds, paymobEnabled=true)."

# ---- 5) Redeploy functions -------------------------------------------------
log "Redeploying Cloud Functions so the new secrets take effect…"
firebase --project "$PROJECT_ID" deploy --only functions --non-interactive
ok "Functions redeployed."

# ---- 6) Post-deploy sanity check -------------------------------------------
log "Post-deploy sanity check (webhook URL, setup status):"
WEBHOOK_URL="https://us-central1-${PROJECT_ID}.cloudfunctions.net/paymobWebhook"
echo
printf "  Webhook URL to register in the NEW Paymob dashboard:\n"
printf "    ${C_GRN}%s${C_RST}\n" "$WEBHOOK_URL"
echo
warn "MANUAL STEP: log in to eg.dashboard.paymob.com with the NEW account and register the URL above as:"
warn "    - Transaction Response Callback (POST)"
warn "    - Transaction Processed Callback (POST)"
echo

# ---- 7) Wipe the local .env.paymob.new -------------------------------------
log "Shredding local $ENV_FILE (so keys don't linger on disk)…"
if command -v shred >/dev/null 2>&1; then
  shred -u "$ENV_FILE" 2>/dev/null || rm -f "$ENV_FILE"
else
  # macOS fallback: overwrite then remove
  # shellcheck disable=SC2094
  { dd if=/dev/urandom of="$ENV_FILE" bs=1k count=4 conv=notrunc 2>/dev/null || true; } && rm -f "$ENV_FILE"
fi
if [[ -f "$ENV_FILE" ]]; then
  warn "Could not shred $ENV_FILE — delete it manually."
else
  ok "Local credentials file wiped."
fi

echo
ok "Done. The next transaction will be processed by the new Paymob account."
ok "Verify from /admin  →  Paymob checklist should be all green (ready:true)."
