#!/usr/bin/env bash
# =============================================================================
# End-to-end test of the promo/affiliate system against Firebase emulators.
# Tests the ACTUAL deployed code paths: applyPromoCode callable validation
# matrix + paymobWebhook idempotency (the P0 double-settlement fix).
# =============================================================================
set -u
DB="http://127.0.0.1:9000"
FN="http://127.0.0.1:5001/four-fruits-fun/us-central1"
NS="ns=four-fruits-fun"
AUTH="Authorization: Bearer owner"
PASS=0; FAIL=0

check() { # name, expected_substring, actual
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✅ PASS: $name"
    PASS=$((PASS+1))
  else
    echo "  ❌ FAIL: $name"
    echo "     expected to contain: $expected"
    echo "     actual: $(echo "$actual" | head -c 400)"
    FAIL=$((FAIL+1))
  fi
}

echo "===================================================================="
echo "STEP 1 — Seed emulator database (settings, affiliate, promo codes,"
echo "          pending order, phoneIndex)"
echo "===================================================================="

# Settings
curl -s -X PUT "$DB/settings.json?$NS&access_token=owner" -d '{
  "paymobEnabled": true, "currency": "EGP", "promoEnabled": true
}' > /dev/null

# Affiliate
curl -s -X PUT "$DB/affiliates/ahmed_test.json?$NS&access_token=owner" -d '{
  "name": "Ahmed Test Influencer", "phone": "+201000000001", "active": true,
  "payoutMethod": "instapay", "payoutRef": "01000000001",
  "defaultCommissionType": "percent", "defaultCommissionValue": 15,
  "createdAt": 1789500000000, "totalOrders": 0, "totalRevenue": 0,
  "totalDiscountGiven": 0, "totalCommission": 0, "pendingCommission": 0,
  "paidCommission": 0
}' > /dev/null

# Promo codes: valid / expired / disabled / usage-limit-reached / min-order
NOW_PLUS_YEAR=$(( ($(date +%s) + 31536000) * 1000 ))
NOW_MINUS_DAY=$(( ($(date +%s) - 86400) * 1000 ))

curl -s -X PUT "$DB/promoCodes/TEST10.json?$NS&access_token=owner" -d "{
  \"status\": \"active\", \"discountType\": \"percent\", \"discountValue\": 10,
  \"commissionType\": \"percent\", \"commissionValue\": 15,
  \"affiliateId\": \"ahmed_test\", \"affiliateName\": \"Ahmed Test Influencer\",
  \"usageLimit\": 0, \"usedCount\": 0, \"minOrderAmount\": 0,
  \"expiresAt\": $NOW_PLUS_YEAR, \"createdAt\": 1789500000000
}" > /dev/null

curl -s -X PUT "$DB/promoCodes/EXPIRED1.json?$NS&access_token=owner" -d "{
  \"status\": \"active\", \"discountType\": \"percent\", \"discountValue\": 20,
  \"commissionType\": \"percent\", \"commissionValue\": 10,
  \"affiliateId\": \"ahmed_test\", \"usageLimit\": 0, \"usedCount\": 0,
  \"minOrderAmount\": 0, \"expiresAt\": $NOW_MINUS_DAY, \"createdAt\": 1789500000000
}" > /dev/null

curl -s -X PUT "$DB/promoCodes/DISABLED1.json?$NS&access_token=owner" -d '{
  "status": "disabled", "discountType": "fixed", "discountValue": 50,
  "commissionType": "fixed", "commissionValue": 20,
  "affiliateId": "ahmed_test", "usageLimit": 0, "usedCount": 0,
  "minOrderAmount": 0, "expiresAt": 0, "createdAt": 1789500000000
}' > /dev/null

curl -s -X PUT "$DB/promoCodes/MAXED1.json?$NS&access_token=owner" -d '{
  "status": "active", "discountType": "percent", "discountValue": 10,
  "commissionType": "percent", "commissionValue": 10,
  "affiliateId": "ahmed_test", "usageLimit": 5, "usedCount": 5,
  "minOrderAmount": 0, "expiresAt": 0, "createdAt": 1789500000000
}' > /dev/null

curl -s -X PUT "$DB/promoCodes/BIGONLY.json?$NS&access_token=owner" -d '{
  "status": "active", "discountType": "fixed", "discountValue": 100,
  "commissionType": "fixed", "commissionValue": 50,
  "affiliateId": "ahmed_test", "usageLimit": 0, "usedCount": 0,
  "minOrderAmount": 1000, "expiresAt": 0, "createdAt": 1789500000000
}' > /dev/null

# Pending order (buyer phoneKey 201234567890) with promo already stamped
curl -s -X PUT "$DB/orders/ORD-E2ETEST1.json?$NS&access_token=owner" -d '{
  "packageId": "individual", "packageName": "فردي", "packageType": "individual",
  "status": "pending", "codesCount": 1, "sessionsPerCode": 5,
  "price": 449.1, "originalPrice": 499, "discountAmount": 49.9,
  "promoCode": "TEST10", "affiliateId": "ahmed_test", "affiliateCommission": 67.37,
  "currency": "EGP", "buyerName": "Test Buyer", "buyerPhone": "+201234567890",
  "phoneKey": "201234567890", "createdAt": 1789500000000,
  "paymentMethod": "paymob", "paymentStatus": "pending"
}' > /dev/null

curl -s -X PUT "$DB/phoneIndex/201234567890.json?$NS&access_token=owner" -d '{
  "authUid": "test-uid-buyer", "phone": "+201234567890",
  "authMethod": "phone", "role": "customer",
  "registeredAt": 1789500000000, "updatedAt": 1789500000000
}' > /dev/null

echo "  Seeded: settings, 1 affiliate, 5 promo codes, 1 pending order"

echo ""
echo "===================================================================="
echo "STEP 2 — applyPromoCode validation matrix (callable, us-central1)"
echo "===================================================================="

# NOTE: callables in the emulator accept 'Authorization: Bearer owner' as admin auth.
R=$(curl -s -X POST "$FN/applyPromoCode" -H "Content-Type: application/json" -H "$AUTH" -d '{"data":{"code":"TEST10","price":499}}')
check "valid code TEST10 → ok:true"           '"ok":true'            "$R"
check "valid code → discount 49.9"            '"discountAmount":49.9' "$R"
check "valid code → final 449.1"              '"finalPrice":449.1'    "$R"
check "valid code → affiliate name returned"  'Ahmed Test Influencer' "$R"
# The response must never contain the commission field (server-only data)
if echo "$R" | grep -q 'commission'; then
  echo "  ❌ FAIL: commission leaked to client: $R"; FAIL=$((FAIL+1))
else
  echo "  ✅ PASS: commission not leaked to client"; PASS=$((PASS+1))
fi

R=$(curl -s -X POST "$FN/applyPromoCode" -H "Content-Type: application/json" -H "$AUTH" -d '{"data":{"code":"EXPIRED1","price":499}}')
check "expired code → reason expired"         '"reason":"expired"'   "$R"

R=$(curl -s -X POST "$FN/applyPromoCode" -H "Content-Type: application/json" -H "$AUTH" -d '{"data":{"code":"DISABLED1","price":499}}')
check "disabled code → reason disabled"       '"reason":"disabled"'  "$R"

R=$(curl -s -X POST "$FN/applyPromoCode" -H "Content-Type: application/json" -H "$AUTH" -d '{"data":{"code":"MAXED1","price":499}}')
check "maxed code → reason used_up"           '"reason":"used_up"'   "$R"

R=$(curl -s -X POST "$FN/applyPromoCode" -H "Content-Type: application/json" -H "$AUTH" -d '{"data":{"code":"BIGONLY","price":499}}')
check "below min order → reason below_min"    '"reason":"below_min"' "$R"
check "below min → minOrderAmount 1000"       '"minOrderAmount":1000' "$R"

R=$(curl -s -X POST "$FN/applyPromoCode" -H "Content-Type: application/json" -H "$AUTH" -d '{"data":{"code":"NOSUCHCODE","price":499}}')
check "unknown code → reason not_found"       '"reason":"not_found"' "$R"

R=$(curl -s -X POST "$FN/applyPromoCode" -H "Content-Type: application/json" -H "$AUTH" -d '{"data":{"code":"BIGONLY","price":1500}}')
check "min-order satisfied at 1500 → ok"      '"ok":true'            "$R"
check "fixed discount 100 applied"            '"discountAmount":100' "$R"

echo ""
echo "===================================================================="
echo "STEP 3 — Paymob webhook idempotency (THE P0 double-settlement fix)"
echo "===================================================================="

# Build a Paymob txn payload and compute valid HMAC with the test secret.
python3 << 'PYEOF' > /tmp/webhook-payload.json
import json, hmac, hashlib

secret = "test_hmac_secret_local"
obj = {
    "id": 777001,
    "amount_cents": 44910,
    "created_at": "2026-09-16T11:00:00",
    "currency": "EGP",
    "error_occured": False,
    "has_parent_transaction": False,
    "integration_id": 11111,
    "is_3d_secure": True,
    "is_auth": False,
    "is_capture": False,
    "is_refunded": False,
    "is_standalone_payment": True,
    "is_voided": False,
    "order": {"id": 555001, "merchant_order_id": "ORD-E2ETEST1"},
    "owner": 42,
    "pending": False,
    "source_data": {"pan": "1234", "sub_type": "MasterCard", "type": "card"},
    "success": True,
}
# HMAC concat order must match functions/paymob.js verifyTransactionHmac (isPost=true)
sd = obj["source_data"]
parts = [
    obj["amount_cents"], obj["created_at"], obj["currency"], obj["error_occured"],
    obj["has_parent_transaction"], obj["id"], obj["integration_id"],
    obj["is_3d_secure"], obj["is_auth"], obj["is_capture"], obj["is_refunded"],
    obj["is_standalone_payment"], obj["is_voided"], obj["order"]["id"],
    obj["owner"], obj["pending"], sd["pan"], sd["sub_type"], sd["type"], obj["success"],
]
def s(v):
    if v is False: return "false"
    if v is True: return "true"
    if v is None: return ""
    return str(v)
concat = "".join(s(v) for v in parts)
sig = hmac.new(secret.encode(), concat.encode(), hashlib.sha512).hexdigest()
print(json.dumps({"payload": {"obj": obj}, "hmac": sig}))
PYEOF

HMAC_SIG=$(python3 -c "import json;d=json.load(open('/tmp/webhook-payload.json'));print(d['hmac'])")
python3 -c "import json;d=json.load(open('/tmp/webhook-payload.json'));print(json.dumps(d['payload']))" > /tmp/webhook-body.json

echo "  --- Webhook delivery #1 (should fulfill + settle commission) ---"
R1=$(curl -s -X POST "$FN/paymobWebhook?hmac=$HMAC_SIG" -H "Content-Type: application/json" -d @/tmp/webhook-body.json)
check "webhook #1 accepted"                    '"received":true'       "$R1"

sleep 2

ORDER=$(curl -s "$DB/orders/ORD-E2ETEST1.json?$NS&access_token=owner")
check "order fulfilled after webhook #1"       '"status":"fulfilled"'  "$ORDER"
check "session codes provisioned"              '"sessionCodes"'        "$ORDER"

AFF=$(curl -s "$DB/affiliates/ahmed_test.json?$NS&access_token=owner")
check "affiliate credited once (orders=1)"     '"totalOrders":1'       "$AFF"
PENDING1=$(echo "$AFF" | python3 -c "import json,sys;print(json.load(sys.stdin).get('pendingCommission'))")
echo "     pendingCommission after #1: $PENDING1"

USED=$(curl -s "$DB/promoCodes/TEST10/usedCount.json?$NS&access_token=owner")
check "promo usedCount incremented to 1"       '^1$'                   "$USED"

echo "  --- Webhook delivery #2 (identical retry — MUST be deduped) ---"
R2=$(curl -s -X POST "$FN/paymobWebhook?hmac=$HMAC_SIG" -H "Content-Type: application/json" -d @/tmp/webhook-body.json)
check "webhook #2 flagged duplicate"           'duplicate'             "$R2"

sleep 1

AFF2=$(curl -s "$DB/affiliates/ahmed_test.json?$NS&access_token=owner")
PENDING2=$(echo "$AFF2" | python3 -c "import json,sys;print(json.load(sys.stdin).get('pendingCommission'))")
check "affiliate still totalOrders=1 (NOT 2)"  '"totalOrders":1'       "$AFF2"
if [ "$PENDING1" = "$PENDING2" ]; then
  echo "  ✅ PASS: pendingCommission unchanged after retry ($PENDING2)"
  PASS=$((PASS+1))
else
  echo "  ❌ FAIL: commission DOUBLE-CREDITED! before=$PENDING1 after=$PENDING2"
  FAIL=$((FAIL+1))
fi

USED2=$(curl -s "$DB/promoCodes/TEST10/usedCount.json?$NS&access_token=owner")
check "usedCount still 1 (NOT 2)"              '^1$'                   "$USED2"

echo "  --- Webhook with WRONG HMAC (must be rejected) ---"
R3=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$FN/paymobWebhook?hmac=deadbeef" -H "Content-Type: application/json" -d @/tmp/webhook-body.json)
check "invalid HMAC → 401"                     '401'                   "$R3"

echo ""
echo "===================================================================="
echo "RESULTS:  $PASS passed · $FAIL failed"
echo "===================================================================="
[ "$FAIL" -eq 0 ] && echo "🎉 ALL TESTS PASSED" || echo "⚠️ SOME TESTS FAILED"
