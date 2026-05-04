/* =========================================================================
   Telepathy – Access Codes shared module
   Used by: home.html, index.html (game), admin.html
   No business logic of the game is touched.
   ========================================================================= */
(function (global) {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBiUzbNZw1FnlWL3JhFRb-aqXJc4aMHkHo",
    authDomain: "four-fruits-fun.firebaseapp.com",
    databaseURL: "https://four-fruits-fun-default-rtdb.firebaseio.com",
    projectId: "four-fruits-fun",
    storageBucket: "four-fruits-fun.firebasestorage.app",
    messagingSenderId: "859050281067",
    appId: "1:859050281067:web:2c04c8ed688c705907092e"
  };

  function ensureFirebase() {
    if (typeof firebase === 'undefined') {
      console.warn('[codes] firebase SDK not loaded yet');
      return null;
    }
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    return firebase;
  }

  // 6-12 char human-friendly code (no ambiguous chars)
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function randomCode(prefix, len = 8) {
    let s = '';
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) s += ALPHA[arr[i] % ALPHA.length];
    return prefix ? `${prefix}-${s}` : s;
  }

  function normalizeCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').trim();
  }

  function fmtDate(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ============== Public API ==============

  /** Validate access code — read-only */
  async function validate(code) {
    const fb = ensureFirebase(); if (!fb) return { ok: false, reason: 'init' };
    code = normalizeCode(code);
    if (!code) return { ok: false, reason: 'empty', message: 'أدخل الكود' };

    const snap = await fb.database().ref('accessCodes/' + code).once('value');
    const c = snap.val();
    if (!c) return { ok: false, reason: 'not_found', message: 'الكود غير موجود' };
    if (c.status === 'disabled') return { ok: false, reason: 'disabled', message: 'تم إيقاف هذا الكود' };
    if (c.status === 'expired')  return { ok: false, reason: 'expired',  message: 'انتهت صلاحية الكود' };
    if (c.expiresAt && Date.now() > c.expiresAt) return { ok: false, reason: 'expired', message: 'انتهت صلاحية الكود' };
    if (c.usedSessions >= c.maxSessions) return { ok: false, reason: 'used_up', message: 'تم استهلاك جميع جلسات هذا الكود' };

    return {
      ok: true,
      code,
      type: c.type,
      label: c.label || '',
      remaining: c.maxSessions - c.usedSessions,
      maxSessions: c.maxSessions,
      usedSessions: c.usedSessions,
      expiresAt: c.expiresAt || 0,
      ownerId: c.ownerId || null,
    };
  }

  /** Consume one session of an access code (transactional) */
  async function consume(code) {
    const fb = ensureFirebase(); if (!fb) return { ok: false, reason: 'init' };
    code = normalizeCode(code);
    const ref = fb.database().ref('accessCodes/' + code);

    const result = await ref.transaction((c) => {
      if (!c) return; // abort
      if (c.status !== 'active') return;
      if (c.expiresAt && Date.now() > c.expiresAt) {
        c.status = 'expired';
        return c;
      }
      if (c.usedSessions >= c.maxSessions) {
        c.status = 'used';
        return c;
      }
      c.usedSessions = (c.usedSessions || 0) + 1;
      c.lastUsedAt = Date.now();
      if (c.usedSessions >= c.maxSessions) c.status = 'used';
      return c;
    });

    if (!result.committed || !result.snapshot.exists()) {
      return { ok: false, reason: 'not_found', message: 'الكود غير صالح' };
    }
    const c = result.snapshot.val();
    if (c.status === 'expired') return { ok: false, reason: 'expired', message: 'انتهت صلاحية الكود' };
    if (c.status === 'used' && c.usedSessions > c.maxSessions) {
      return { ok: false, reason: 'used_up', message: 'تم استهلاك جميع الجلسات' };
    }
    return {
      ok: true,
      code,
      remaining: c.maxSessions - c.usedSessions,
      type: c.type,
      label: c.label || '',
    };
  }

  /** Bump global session counter (best-effort) */
  function bumpSessions() {
    const fb = ensureFirebase(); if (!fb) return;
    fb.database().ref('stats/totals/sessionsPlayed').transaction((v) => (v || 0) + 1);
  }
  function bumpShares() {
    const fb = ensureFirebase(); if (!fb) return;
    fb.database().ref('stats/totals/cardsShared').transaction((v) => (v || 0) + 1);
  }

  // ============ Admin-only API ============

  /** Create one access code (admin) */
  async function createOne(opts) {
    const fb = ensureFirebase(); if (!fb) return null;
    const code = opts.code || randomCode(opts.prefix || (opts.type === 'business' ? 'BIZ' : 'TP'), 8);
    const payload = {
      type: opts.type || 'individual',
      status: 'active',
      maxSessions: Number(opts.maxSessions) || 5,
      usedSessions: 0,
      createdAt: Date.now(),
      expiresAt: opts.expiresAt || (Date.now() + 1000 * 60 * 60 * 24 * (opts.daysValid || 365)),
      label: opts.label || '',
      ownerId: opts.ownerId || '',
      batchId: opts.batchId || '',
    };
    await fb.database().ref('accessCodes/' + code).set(payload);
    return { code, ...payload };
  }

  /** Create a batch (admin) */
  async function createBatch(opts) {
    const fb = ensureFirebase(); if (!fb) return [];
    const count = Math.min(Math.max(Number(opts.count) || 1, 1), 1000);
    const batchId = randomCode('B', 6);
    await fb.database().ref('batches/' + batchId).set({
      createdAt: Date.now(),
      count,
      ownerId: opts.ownerId || '',
      label: opts.label || '',
      maxSessions: Number(opts.maxSessions) || 5,
      type: opts.type || 'business',
    });

    const created = [];
    const updates = {};
    for (let i = 0; i < count; i++) {
      const code = randomCode(opts.prefix || 'BIZ', 8);
      const item = {
        type: opts.type || 'business',
        status: 'active',
        maxSessions: Number(opts.maxSessions) || 5,
        usedSessions: 0,
        createdAt: Date.now(),
        expiresAt: opts.expiresAt || (Date.now() + 1000 * 60 * 60 * 24 * (opts.daysValid || 365)),
        label: opts.label || '',
        ownerId: opts.ownerId || '',
        batchId,
      };
      updates['accessCodes/' + code] = item;
      created.push({ code, ...item });
    }
    await fb.database().ref().update(updates);
    return { batchId, codes: created };
  }

  async function setStatus(code, status) {
    const fb = ensureFirebase(); if (!fb) return;
    code = normalizeCode(code);
    await fb.database().ref('accessCodes/' + code + '/status').set(status);
  }

  async function listCodes(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('accessCodes').orderByChild('createdAt').limitToLast(500).once('value');
    const out = [];
    snap.forEach((s) => out.push({ code: s.key, ...s.val() }));
    out.reverse();
    if (filter && filter.status) return out.filter((x) => x.status === filter.status);
    if (filter && filter.batchId) return out.filter((x) => x.batchId === filter.batchId);
    return out;
  }

  global.TPCodes = {
    config: FIREBASE_CONFIG,
    init: ensureFirebase,
    randomCode,
    normalize: normalizeCode,
    fmtDate,
    validate,
    consume,
    bumpSessions,
    bumpShares,
    createOne,
    createBatch,
    setStatus,
    listCodes,
  };
})(window);
