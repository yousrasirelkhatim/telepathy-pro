#!/usr/bin/env node
/**
 * Unit test for TPSession.isResumableRoom — the predicate that decides whether a
 * buyer's saved room is healthy enough to resume, or whether the system should
 * self-heal by creating a fresh room. Loads the real session-entry.js in a
 * minimal shim (no Firebase / DOM needed for this pure function).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../public/js/session-entry.js'), 'utf8');

// Minimal window/document/localStorage shim so the IIFE can register TPSession.
const sandbox = {
  window: {},
  document: { addEventListener() {}, getElementById() { return null; } },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  location: { search: '', origin: 'https://teleplay.online' },
  firebase: undefined,
  setTimeout,
};
sandbox.global = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const TP = sandbox.window.TPSession;
if (!TP || typeof TP.isResumableRoom !== 'function') {
  console.error('FAIL: TPSession.isResumableRoom not exported');
  process.exit(1);
}

let pass = 0, fail = 0;
function t(name, expected, actual) {
  if (expected === actual) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} — expected ${expected}, got ${actual}`); fail++; }
}

const CODE = 'JS-ABC123';
const healthy = {
  accessCode: CODE, expired: false, maxUses: 1, totalUses: 0,
  players: { player1: { name: 'Host' } },
};

console.log('isResumableRoom predicate:');
t('healthy waiting room (host present) → resumable', true, TP.isResumableRoom(healthy, CODE));
t('healthy room + friend present → resumable', true,
  TP.isResumableRoom({ ...healthy, players: { player1: {}, player2: {} } }, CODE));

t('orphaned room (no player1) → NOT resumable', false,
  TP.isResumableRoom({ ...healthy, players: { player2: { name: 'Friend' } } }, CODE));
t('empty players → NOT resumable', false,
  TP.isResumableRoom({ ...healthy, players: {} }, CODE));
t('no players node → NOT resumable', false,
  TP.isResumableRoom({ accessCode: CODE, expired: false, maxUses: 1, totalUses: 0 }, CODE));

t('expired room → NOT resumable', false,
  TP.isResumableRoom({ ...healthy, expired: true }, CODE));
t('used-up room (totalUses>=maxUses) → NOT resumable', false,
  TP.isResumableRoom({ ...healthy, totalUses: 1, maxUses: 1 }, CODE));

t('accessCode mismatch → NOT resumable', false,
  TP.isResumableRoom({ ...healthy, accessCode: 'JS-OTHER99' }, CODE));
t('accessCode case-insensitive match → resumable', true,
  TP.isResumableRoom({ ...healthy, accessCode: 'js-abc123' }, CODE));

t('null room → NOT resumable', false, TP.isResumableRoom(null, CODE));
t('undefined room → NOT resumable', false, TP.isResumableRoom(undefined, CODE));

// Legacy multi-use TP code room with remaining uses stays resumable.
t('multi-use room with remaining uses → resumable', true,
  TP.isResumableRoom({ accessCode: CODE, expired: false, maxUses: 5, totalUses: 2, players: { player1: {} } }, CODE));

console.log(`\nRESULT: ${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
