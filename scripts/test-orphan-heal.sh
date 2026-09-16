#!/usr/bin/env bash
# Reproduces the orphaned-room scenario against the RTDB emulator and verifies
# that resolveSessionRoomCode's predicate (isResumableRoom) rejects it, so the
# owner self-heals into a fresh room instead of hitting a stale/"expired" room.
set -u
DB="http://127.0.0.1:9000"
NS="ns=four-fruits-fun"
PASS=0; FAIL=0
chk(){ if [ "$2" = "$3" ]; then echo "  ✅ $1"; PASS=$((PASS+1)); else echo "  ❌ $1 (expected $2 got $3)"; FAIL=$((FAIL+1)); fi; }

CODE="JS-HEAL01"

echo "=== Seed: active JS access code + sessionIndex + orphaned room ==="
curl -s -X PUT "$DB/accessCodes/$CODE.json?$NS&access_token=owner" -d '{
  "type":"session","status":"active","maxSessions":1,"usedSessions":0,
  "createdAt":1789500000000,"expiresAt":4102444800000,"ownerId":"201234567890"
}' >/dev/null
# Orphaned room: host (player1) gone, only player2 remains — the exact bug state.
curl -s -X PUT "$DB/rooms/ORPHAN.json?$NS&access_token=owner" -d '{
  "code":"ORPHAN","status":"waiting","expired":false,"accessCode":"JS-HEAL01",
  "maxUses":1,"totalUses":0,
  "players":{"player2":{"name":"Friend","id":"p_x"}}
}' >/dev/null
curl -s -X PUT "$DB/sessionIndex/$CODE.json?$NS&access_token=owner" -d '{
  "phoneKey":"201234567890","sessionId":"s1","status":"active","roomId":"ORPHAN"
}' >/dev/null
curl -s -X PUT "$DB/accessRooms/$CODE.json?$NS&access_token=owner" -d '{"roomId":"ORPHAN","at":1789500000000}' >/dev/null
echo "  seeded active code + orphaned room ORPHAN (player1 missing)"

echo ""
echo "=== Run resolveSessionRoomCode logic (via isResumableRoom) against seeded data ==="
node -e '
const fs=require("fs"),vm=require("vm");
const src=fs.readFileSync("/workspace/public/js/session-entry.js","utf8");
const sb={window:{},document:{addEventListener(){},getElementById(){return null}},localStorage:{getItem(){return null},setItem(){},removeItem(){}},location:{search:""},setTimeout};
sb.global=sb.window; vm.createContext(sb); vm.runInContext(src,sb);
const TP=sb.window.TPSession;
(async()=>{
  const https=require("http");
  const get=(p)=>new Promise((res)=>{https.get("http://127.0.0.1:9000/"+p+"?ns=four-fruits-fun&access_token=owner",(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d||"null")))})});
  const room=await get("rooms/ORPHAN.json");
  const resumable=TP.isResumableRoom(room,"JS-HEAL01");
  console.log("  orphaned room resumable? "+resumable+"  (expected false)");
  process.exit(resumable===false?0:1);
})();
'
chk "orphaned room rejected by predicate" "0" "$?"

echo ""
echo "=== Compare: a HEALTHY room (host present) must be accepted ==="
curl -s -X PUT "$DB/rooms/HEALTHY.json?$NS&access_token=owner" -d '{
  "code":"HEALTHY","status":"waiting","expired":false,"accessCode":"JS-HEAL01",
  "maxUses":1,"totalUses":0,
  "players":{"player1":{"name":"Host","id":"p_h"}}
}' >/dev/null
node -e '
const fs=require("fs"),vm=require("vm");
const src=fs.readFileSync("/workspace/public/js/session-entry.js","utf8");
const sb={window:{},document:{addEventListener(){},getElementById(){return null}},localStorage:{getItem(){return null},setItem(){},removeItem(){}},location:{search:""},setTimeout};
sb.global=sb.window; vm.createContext(sb); vm.runInContext(src,sb);
const TP=sb.window.TPSession;
(async()=>{
  const https=require("http");
  const get=(p)=>new Promise((res)=>{https.get("http://127.0.0.1:9000/"+p+"?ns=four-fruits-fun&access_token=owner",(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d||"null")))})});
  const room=await get("rooms/HEALTHY.json");
  const resumable=TP.isResumableRoom(room,"JS-HEAL01");
  console.log("  healthy room resumable? "+resumable+"  (expected true)");
  process.exit(resumable===true?0:1);
})();
'
chk "healthy room accepted by predicate" "0" "$?"

echo ""
echo "RESULT: $PASS passed · $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "🎉 ORPHAN SELF-HEAL VERIFIED" || echo "⚠️ FAILED"
