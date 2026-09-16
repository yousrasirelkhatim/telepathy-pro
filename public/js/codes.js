/* =========================================================================
   Telepathy – Access Codes shared module (TPCodes)
   Used by: index.html, play.html, my.html, admin.html, card.html,
            payment-success.html
   Scope: access codes, orders, packages, pricing, settings, FAQ,
          promo codes & affiliates. No game logic here.
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

  function phoneRateKey(phone) {
    const digits = String(phone || '').replace(/\D/g, '').slice(-15);
    return digits || 'unknown';
  }

  const ORDER_COOLDOWN_MS = 60000;

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
    const used = Number(c.usedSessions || 0);
    const max = Number(c.maxSessions || 0);
    if (used >= max && max > 0) return { ok: false, reason: 'used_up', message: 'تم استهلاك جميع جلسات هذا الكود' };

    return {
      ok: true,
      code,
      type: c.type,
      label: c.label || '',
      remaining: max - used,
      maxSessions: max,
      usedSessions: used,
      expiresAt: c.expiresAt || 0,
      ownerId: c.ownerId || null,
      sessionId: c.sessionId || null,
    };
  }

  /** Consume one session of an access code (transactional). opts.sessionMeta for JS cards at game end. */
  async function consume(code, opts) {
    opts = opts || {};
    const fb = ensureFirebase(); if (!fb) return { ok: false, reason: 'init' };
    code = normalizeCode(code);
    const ref = fb.database().ref('accessCodes/' + code);

    const first = await ref.once('value');
    const c = first.val();
    if (!c) return { ok: false, reason: 'not_found', message: 'الكود غير صالح' };
    if (c.status === 'disabled') return { ok: false, reason: 'disabled', message: 'تم إيقاف هذا الكود' };
    if (c.status === 'expired') return { ok: false, reason: 'expired', message: 'انتهت صلاحية الكود' };
    if (c.expiresAt && Date.now() > c.expiresAt) {
      ref.child('status').set('expired').catch(() => {});
      return { ok: false, reason: 'expired', message: 'انتهت صلاحية الكود' };
    }
    if (c.usedSessions >= c.maxSessions) {
      ref.child('status').set('used').catch(() => {});
      return { ok: false, reason: 'used_up', message: 'تم استهلاك جميع الجلسات' };
    }

    const usage = await ref.child('usedSessions').transaction((v) => {
      const current = Number(v || 0);
      return current >= c.maxSessions ? undefined : current + 1;
    });

    if (!usage.committed) return { ok: false, reason: 'used_up', message: 'تم استهلاك جميع الجلسات' };
    const usedSessions = usage.snapshot.val();
    const status = usedSessions >= c.maxSessions ? 'used' : 'active';
    await ref.update({ lastUsedAt: Date.now(), status }).catch(() => {});

    if (c.type === 'session' && global.TPAccount && global.TPAccount.markSessionUsed && opts.sessionMeta) {
      global.TPAccount.markSessionUsed(code, opts.sessionMeta).catch(() => {});
    }

    return {
      ok: true,
      code,
      remaining: c.maxSessions - usedSessions,
      maxSessions: c.maxSessions,
      usedSessions,
      type: c.type,
      label: c.label || '',
    };
  }

  /** Bump global session counter (best-effort) */
  function bumpSessions() {
    const fb = ensureFirebase(); if (!fb) return;
    fb.database().ref('stats/totals/sessionsPlayed').transaction((v) => {
      const n = Number(v || 0);
      return n + 1;
    }).catch(() => {});
  }
  function bumpShares() {
    const fb = ensureFirebase(); if (!fb) return;
    fb.database().ref('stats/totals/cardsShared').transaction((v) => {
      const n = Number(v || 0);
      return n + 1;
    }).catch(() => {});
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
    if (opts.resellerId) payload.resellerId = opts.resellerId;
    if (typeof opts.soldPrice === 'number') payload.soldPrice = opts.soldPrice;
    await fb.database().ref('accessCodes/' + code).set(payload);
    return { code, ...payload };
  }

  /** Create a batch (admin or reseller) */
  async function createBatch(opts) {
    const fb = ensureFirebase(); if (!fb) return [];
    const count = Math.min(Math.max(Number(opts.count) || 1, 1), 1000);
    const batchId = randomCode('B', 6);
    const batchMeta = {
      createdAt: Date.now(),
      count,
      ownerId: opts.ownerId || '',
      label: opts.label || '',
      maxSessions: Number(opts.maxSessions) || 5,
      type: opts.type || 'business',
    };
    if (opts.resellerId) batchMeta.resellerId = opts.resellerId;
    await fb.database().ref('batches/' + batchId).set(batchMeta);

    const created = [];
    const updates = {};
    const seen = new Set();
    const baseNow = Date.now();
    let i = 0;
    while (created.length < count) {
      const code = randomCode(opts.prefix || 'BIZ', 8);
      if (seen.has(code)) continue;
      seen.add(code);
      const item = {
        type: opts.type || 'business',
        status: 'active',
        maxSessions: Number(opts.maxSessions) || 5,
        usedSessions: 0,
        createdAt: baseNow + i,
        expiresAt: opts.expiresAt || (baseNow + 1000 * 60 * 60 * 24 * (opts.daysValid || 365)),
        label: opts.label || '',
        ownerId: opts.ownerId || '',
        batchId,
      };
      if (opts.resellerId) item.resellerId = opts.resellerId;
      if (typeof opts.soldPrice === 'number') item.soldPrice = opts.soldPrice;
      updates['accessCodes/' + code] = item;
      created.push({ code, ...item });
      i++;
    }
    await fb.database().ref().update(updates);
    return { batchId, codes: created };
  }

  async function setStatus(code, status) {
    const fb = ensureFirebase(); if (!fb) return;
    code = normalizeCode(code);
    await fb.database().ref('accessCodes/' + code + '/status').set(status);
  }

  async function removeCode(code) {
    const fb = ensureFirebase(); if (!fb) return;
    code = normalizeCode(code);
    await fb.database().ref('accessCodes/' + code).remove();
  }

  async function listCodes(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('accessCodes').once('value');
    const out = [];
    // ملاحظة مهمة: RTDB forEach يوقف التكرار لو الـcallback رجّع truthy.
    // Array.push يرجع الطول (رقم truthy) — لذلك نلفّ الجسم بأقواس.
    snap.forEach((s) => { out.push({ code: s.key, ...s.val() }); });
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let arr = out;
    if (filter && filter.status) arr = arr.filter((x) => x.status === filter.status);
    if (filter && filter.batchId) arr = arr.filter((x) => x.batchId === filter.batchId);
    if (filter && filter.resellerId) arr = arr.filter((x) => x.resellerId === filter.resellerId);
    if (filter && filter.limit) arr = arr.slice(0, filter.limit);
    return arr;
  }

  /** Reseller-scoped listing using indexed query so RTDB rules allow it */
  async function listMyCodes(resellerId) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('accessCodes')
      .orderByChild('resellerId').equalTo(resellerId).once('value');
    const out = [];
    snap.forEach((s) => { out.push({ code: s.key, ...s.val() }); });
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  // ============== Pricing ==============
  const DEFAULT_PRICING = {
    basePerCode: 100,
    currency: 'EGP',
    tiers: [
      { min: 1,   max: 9,    discountPct: 0  },
      { min: 10,  max: 49,   discountPct: 10 },
      { min: 50,  max: 99,   discountPct: 20 },
      { min: 100, max: 9999, discountPct: 30 }
    ]
  };

  async function getPricing() {
    const fb = ensureFirebase(); if (!fb) return DEFAULT_PRICING;
    const snap = await fb.database().ref('pricing').once('value');
    const v = snap.val();
    if (!v || !v.tiers || !v.tiers.length) return DEFAULT_PRICING;
    return v;
  }
  async function setPricing(p) {
    const fb = ensureFirebase(); if (!fb) return;
    await fb.database().ref('pricing').set(p);
  }

  // ============== Packages (Landing page) ==============
  const DEFAULT_PACKAGES = [
    {
      id: 'individual',
      name: 'فردي', icon: '💝',
      desc: 'مثالي لأمسية ممتعة مع الشريك أو صديق',
      price: 499, currency: 'EGP',
      codesCount: 1, sessionsPerCode: 5,
      unitNote: 'دفعة واحدة',
      features: '5 جلسات تحدي كاملة\nبطاقة نتيجة قابلة للتنزيل\nقوالب تصميم متعددة\nصلاحية الكود سنة كاملة',
      badge: '', featured: false,
      buttonText: 'اشترِ الآن', order: 1, visible: true,
      whatsappMsg: 'أرغب بشراء كود فردي (5 جلسات - 499 ج.م)'
    },
    {
      id: 'business-50',
      name: 'باقة شركات صغيرة', icon: '🏪',
      desc: 'لمطاعم، كافيهات، ومتاجر صغيرة',
      price: 9999, currency: 'EGP',
      codesCount: 50, sessionsPerCode: 5,
      unitNote: '50 كود — توفير 60%',
      features: '50 كود، كل كود = 5 جلسات\nإجمالي 250 جلسة لعميلكم\nلوحة إدارة الأكواد\nإمكانية تخصيص اسم البزنس على البطاقة\nدعم فني مباشر',
      badge: '⭐ الأكثر طلباً', featured: true,
      buttonText: 'طلب الباقة', order: 2, visible: true,
      whatsappMsg: 'أرغب بطلب باقة شركات (50 كود - 9999 ج.م)'
    },
    {
      id: 'business-100',
      name: 'باقة شركات كبرى', icon: '🏬',
      desc: 'للمولات، الفنادق، وسلاسل المطاعم',
      price: 17499, currency: 'EGP',
      codesCount: 100, sessionsPerCode: 5,
      unitNote: '100 كود — توفير 65%',
      features: '100 كود، إجمالي 500 جلسة\nلوحة إدارة وتقارير شاملة\nاسم وشعار البزنس على البطاقة\nQR لكل كود لطباعته\nأولوية في الدعم',
      badge: '', featured: false,
      buttonText: 'طلب الباقة', order: 3, visible: true,
      whatsappMsg: 'أرغب بطلب باقة شركات كبرى (100 كود - 17499 ج.م)'
    }
  ];

  async function listPackages(opts) {
    const fb = ensureFirebase();
    if (!fb) return [];
    const snap = await fb.database().ref('packages').once('value');
    const v = snap.val();
    let out = [];
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(k => out.push({ id: k, ...v[k] }));
    }
    if (opts && opts.visibleOnly) out = out.filter(p => p.visible !== false);
    out.sort((a,b) => (Number(a.order)||0) - (Number(b.order)||0));
    return out;
  }
  async function savePackage(id, data) {
    const fb = ensureFirebase(); if (!fb) return;
    if (!id) throw new Error('package id required');
    // sanitize
    const clean = {};
    ['name','desc','icon','currency','features','badge','buttonText','whatsappMsg','unitNote'].forEach(k => {
      if (data[k] !== undefined) clean[k] = String(data[k]);
    });
    ['price','codesCount','sessionsPerCode','order'].forEach(k => {
      if (data[k] !== undefined) clean[k] = Number(data[k]) || 0;
    });
    ['featured','visible'].forEach(k => {
      if (data[k] !== undefined) clean[k] = !!data[k];
    });
    await fb.database().ref('packages/' + id).update(clean);
  }
  async function deletePackage(id) {
    const fb = ensureFirebase(); if (!fb) return;
    await fb.database().ref('packages/' + id).remove();
  }
  async function seedPackagesIfEmpty() {
    const fb = ensureFirebase(); if (!fb) return;
    const snap = await fb.database().ref('packages').once('value');
    if (snap.val()) return false;
    const updates = {};
    DEFAULT_PACKAGES.forEach(p => { updates[p.id] = { ...p }; delete updates[p.id].id; });
    await fb.database().ref('packages').set(updates);
    return true;
  }

  // ============== Settings (brand, whatsapp, currency, hero copy, contact) ==============
  const DEFAULT_SETTINGS = {
    whatsappNumber: '',
    currency: 'EGP',
    brandName: 'Teleplay',
    tagline: 'تحدي التخاطر — لعبة ذكية للأزواج والأصدقاء',
    heroTitle: 'هل تفكران بنفس الطريقة؟',
    heroBadge: '✨ الإصدار الجديد 2026',
    heroStats: '⚡ يبدأ فوري | 📱 يعمل على الجوال | 🎁 5 تحديات لكل كود',
    bizMessage: 'أرغب بمعرفة المزيد عن باقات الأعمال',
    stripeEnabled: false,
    stripePublishableKey: '',
    paymobEnabled: false,
    paymobPublicKey: '',
    paymobIntegrationIds: '',
    paymobCurrency: 'EGP',
    paymobEgpRate: '50',
    paymentsNote: '',
    // Contact + company attribution (shown in landing footer)
    contactPhone: '+20 127 536 7743',
    contactEmail: 'ineed.ad2020@gmail.com',
    contactAddress: '315 شارع جمال عبد الناصر — العصافرة بحري — الدور الثاني علوي — الإسكندرية، مصر',
    companyName: 'ineed4ecommerce',
    companyUrl: 'https://ineed4ecommerce.online/',
    copyrightYear: '2026',
    // Marketing / single-package toggles (v1)
    singlePackageMode: false,
    promoEnabled: true,
    featuredPackageId: '',
  };
  async function getSettings() {
    const fb = ensureFirebase(); if (!fb) return { ...DEFAULT_SETTINGS };
    const snap = await fb.database().ref('settings').once('value');
    const raw = snap.val() || {};
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      stripeEnabled: raw.stripeEnabled === true || raw.stripeEnabled === 'true',
      paymobEnabled: raw.paymobEnabled === true || raw.paymobEnabled === 'true',
      singlePackageMode: raw.singlePackageMode === true || raw.singlePackageMode === 'true',
      promoEnabled: raw.promoEnabled !== false && raw.promoEnabled !== 'false',
    };
  }
  async function setSettings(s) {
    const fb = ensureFirebase(); if (!fb) return;
    const BOOL_KEYS = new Set(['stripeEnabled', 'paymobEnabled', 'singlePackageMode', 'promoEnabled']);
    const clean = {};
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (s[k] === undefined) return;
      if (BOOL_KEYS.has(k)) clean[k] = !!s[k];
      else clean[k] = String(s[k]);
    });
    await fb.database().ref('settings').update(clean);
  }

  // ============== Promo Codes & Affiliates (marketing) ==============

  function normalizePromoCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24).trim();
  }

  // NOTE: discount math intentionally has NO client-side implementation.
  // The single authoritative implementation is functions/promo.js
  // (evaluatePromo), reached via the applyPromoCode callable — the client
  // can never compute (or tamper with) a price.

  async function getPromoCode(code) {
    const fb = ensureFirebase(); if (!fb) return null;
    const norm = normalizePromoCode(code);
    if (!norm) return null;
    const snap = await fb.database().ref('promoCodes/' + norm).once('value');
    const v = snap.val();
    if (!v) return null;
    return { code: norm, ...v };
  }

  async function listPromoCodes(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('promoCodes').once('value');
    const out = [];
    snap.forEach(s => { out.push({ code: s.key, ...s.val() }); });
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let arr = out;
    if (filter && filter.status) arr = arr.filter(x => x.status === filter.status);
    if (filter && filter.affiliateId) arr = arr.filter(x => x.affiliateId === filter.affiliateId);
    if (filter && filter.limit) arr = arr.slice(0, filter.limit);
    return arr;
  }

  async function savePromoCode(code, data) {
    const fb = ensureFirebase(); if (!fb) return;
    const norm = normalizePromoCode(code);
    if (!norm) throw new Error('promo_code_invalid');
    const clean = {
      status: (data.status === 'disabled' || data.status === 'expired') ? data.status : 'active',
      discountType: (data.discountType === 'fixed') ? 'fixed' : 'percent',
      discountValue: Math.max(0, Number(data.discountValue) || 0),
      commissionType: (data.commissionType === 'fixed') ? 'fixed' : 'percent',
      commissionValue: Math.max(0, Number(data.commissionValue) || 0),
      affiliateId: String(data.affiliateId || '').slice(0, 64),
      affiliateName: String(data.affiliateName || '').slice(0, 80),
      usageLimit: Math.max(0, Math.min(1000000, Number(data.usageLimit) || 0)),
      minOrderAmount: Math.max(0, Number(data.minOrderAmount) || 0),
      expiresAt: Number(data.expiresAt) || 0,
      notes: String(data.notes || '').slice(0, 200),
    };
    const existing = await getPromoCode(norm);
    if (!existing) {
      clean.createdAt = Date.now();
      clean.usedCount = 0;
    }
    await fb.database().ref('promoCodes/' + norm).update(clean);
    return { code: norm, ...clean };
  }

  async function deletePromoCode(code) {
    const fb = ensureFirebase(); if (!fb) return;
    const norm = normalizePromoCode(code);
    await fb.database().ref('promoCodes/' + norm).remove();
  }

  async function setPromoCodeStatus(code, status) {
    const fb = ensureFirebase(); if (!fb) return;
    const norm = normalizePromoCode(code);
    if (!['active', 'disabled', 'expired'].includes(status)) throw new Error('bad_status');
    await fb.database().ref('promoCodes/' + norm + '/status').set(status);
  }

  // ---- Affiliates ----

  function normalizeAffiliateId(raw) {
    return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  }

  async function listAffiliates(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('affiliates').once('value');
    const out = [];
    snap.forEach(s => { out.push({ id: s.key, ...s.val() }); });
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let arr = out;
    if (filter && filter.active !== undefined) arr = arr.filter(x => !!x.active === !!filter.active);
    if (filter && filter.limit) arr = arr.slice(0, filter.limit);
    return arr;
  }

  async function getAffiliate(id) {
    const fb = ensureFirebase(); if (!fb) return null;
    const norm = normalizeAffiliateId(id);
    if (!norm) return null;
    const snap = await fb.database().ref('affiliates/' + norm).once('value');
    const v = snap.val();
    if (!v) return null;
    return { id: norm, ...v };
  }

  async function saveAffiliate(id, data) {
    const fb = ensureFirebase(); if (!fb) return;
    const norm = normalizeAffiliateId(id);
    if (!norm) throw new Error('affiliate_id_invalid');
    const clean = {
      name: String(data.name || '').slice(0, 80),
      phone: String(data.phone || '').slice(0, 30),
      email: String(data.email || '').slice(0, 80),
      active: data.active !== false,
      payoutMethod: (['instapay', 'bank', 'wallet', 'cash'].includes(data.payoutMethod)) ? data.payoutMethod : 'instapay',
      payoutRef: String(data.payoutRef || '').slice(0, 120),
      defaultCommissionType: (data.defaultCommissionType === 'fixed') ? 'fixed' : 'percent',
      defaultCommissionValue: Math.max(0, Number(data.defaultCommissionValue) || 0),
      notes: String(data.notes || '').slice(0, 200),
    };
    const existing = await getAffiliate(norm);
    if (!existing) {
      clean.createdAt = Date.now();
      clean.totalOrders = 0;
      clean.totalRevenue = 0;
      clean.totalDiscountGiven = 0;
      clean.totalCommission = 0;
      clean.pendingCommission = 0;
      clean.paidCommission = 0;
    }
    await fb.database().ref('affiliates/' + norm).update(clean);
    return { id: norm, ...clean };
  }

  async function deleteAffiliate(id) {
    const fb = ensureFirebase(); if (!fb) return;
    const norm = normalizeAffiliateId(id);
    await fb.database().ref('affiliates/' + norm).remove();
  }

  async function markCommissionPaid(affiliateId, amount, note) {
    const fb = ensureFirebase(); if (!fb) throw new Error('init');
    const norm = normalizeAffiliateId(affiliateId);
    if (!norm) throw new Error('affiliate_id_invalid');
    const amt = Math.max(0, Number(amount) || 0);
    if (!amt) throw new Error('amount_required');

    const ref = fb.database().ref('affiliates/' + norm);
    const now = Date.now();
    const tx = await ref.transaction(cur => {
      if (!cur) return cur;
      const pending = Math.max(0, Number(cur.pendingCommission || 0));
      if (amt > pending + 0.01) return cur; // abort — insufficient pending
      cur.pendingCommission = Math.round((pending - amt) * 100) / 100;
      cur.paidCommission = Math.round((Number(cur.paidCommission || 0) + amt) * 100) / 100;
      cur.lastPayoutAt = now;
      return cur;
    });
    if (!tx.committed) throw new Error('payout_conflict');

    const opId = randomCode('PAY', 8);
    await fb.database().ref('affiliatePayouts/' + opId).set({
      affiliateId: norm,
      amount: amt,
      at: now,
      note: String(note || '').slice(0, 200),
    });
    return { affiliateId: norm, amount: amt, opId };
  }

  async function listPromoUses(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('promoUses').once('value');
    const out = [];
    snap.forEach(s => { out.push({ id: s.key, ...s.val() }); });
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    let arr = out;
    if (filter && filter.affiliateId) arr = arr.filter(x => x.affiliateId === filter.affiliateId);
    if (filter && filter.code) arr = arr.filter(x => x.code === filter.code);
    if (filter && filter.status) arr = arr.filter(x => x.status === filter.status);
    if (filter && filter.limit) arr = arr.slice(0, filter.limit);
    return arr;
  }

  async function listAffiliatePayouts(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('affiliatePayouts').once('value');
    const out = [];
    snap.forEach(s => { out.push({ id: s.key, ...s.val() }); });
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    let arr = out;
    if (filter && filter.affiliateId) arr = arr.filter(x => x.affiliateId === filter.affiliateId);
    if (filter && filter.limit) arr = arr.slice(0, filter.limit);
    return arr;
  }

  // ============== FAQ (Landing — admin-editable) ==============
  const DEFAULT_FAQ = [
    {
      id: 'q1-app',
      order: 10, visible: true,
      questionAr: 'هل يلزم تنزيل تطبيق؟',
      answerAr:  'لا. Teleplay تعمل من المتصفح مباشرة على الجوال والكمبيوتر، ويمكن تثبيتها كتطبيق ويب (PWA) من قائمة المتصفح.',
      questionEn: 'Do I need to install an app?',
      answerEn:  'No. Teleplay runs directly in your browser on mobile and desktop, and can be installed as a Progressive Web App (PWA) from your browser menu.',
    },
    {
      id: 'q2-duration',
      order: 20, visible: true,
      questionAr: 'كم مدة كل جلسة؟',
      answerAr:  'الجلسة الواحدة تستغرق حوالي 10–15 دقيقة، مقسمة إلى 4 مراحل × 5 جولات.',
      questionEn: 'How long is a session?',
      answerEn:  'Each session takes roughly 10–15 minutes — 4 phases with 5 rounds each.',
    },
    {
      id: 'q3-players',
      order: 30, visible: true,
      questionAr: 'كم شخصاً يلعب في الغرفة الواحدة؟',
      answerAr:  'لاعبان اثنان فقط في كل غرفة — تجربة عميقة وشخصية للتوافق العقلي.',
      questionEn: 'How many players per room?',
      answerEn:  'Two players per room only — a deep and personal mind-sync experience.',
    },
    {
      id: 'q4-reuse',
      order: 40, visible: true,
      questionAr: 'هل يعمل الكود أكثر من مرة؟',
      answerAr:  'نعم — كل كود فردي يمنحك 5 جلسات مستقلة. اضغط «تحدي جديد» في نهاية كل جولة للانتقال للتالية.',
      questionEn: 'Can I reuse a code more than once?',
      answerEn:  'Yes — each individual code includes 5 separate sessions. Tap "New Challenge" at the end of each round to move to the next.',
    },
    {
      id: 'q5-business',
      order: 50, visible: true,
      questionAr: 'هل توجد باقات مخصصة للشركات؟',
      answerAr:  'نعم. تواصل عبر واتساب أو البريد الإلكتروني لاستلام أكواد بالجملة مع لوحة إدارة خاصة وتخصيص اسم الشركة على بطاقة النتيجة.',
      questionEn: 'Do you offer business packages?',
      answerEn:  'Yes. Contact us via WhatsApp or email to receive bulk codes with a dedicated admin panel and custom business branding on result cards.',
    },
    {
      id: 'q6-about',
      order: 60, visible: true,
      questionAr: 'ما هي منصة Teleplay؟',
      answerAr:  'Teleplay (teleplay.online) منصة رقمية تقدم خدمات اشتراك في محتوى ترفيهي وتفاعلي رقمي (Digital Interactive Entertainment & Media Services). بعد إتمام الدفع، يحصل المستخدم مباشرة على وصول رقمي (Digital Access) للخدمات المطلوبة عبر حسابه داخل المنصة، دون الحاجة إلى شحن أو تسليم فيزيائي.',
      questionEn: 'What is Teleplay?',
      answerEn:  'Teleplay (teleplay.online) is a digital platform providing subscription-based interactive entertainment and media services. After payment, users receive immediate digital access to the requested services via their in-platform account — no physical shipping or delivery required.',
    },
    {
      id: 'q7-privacy',
      order: 70, visible: true,
      questionAr: 'سياسة الخصوصية',
      answerAr:
        'منصة Teleplay تحرص على حماية خصوصية مستخدميها.\n\n' +
        '• البيانات التي نجمعها: رقم الهاتف (لتسجيل الدخول عبر SMS)، الاسم (يظهر لشريكك أثناء اللعب فقط)، الصورة الشخصية الاختيارية (تظهر لشريكك أثناء الجلسة فقط)، وبيانات الطلب.\n\n' +
        '• بيانات الدفع: تُعالج بالكامل عبر بوابة Paymob المرخّصة — نحن لا نُخزّن أرقام بطاقاتك.\n\n' +
        '• أطراف ثالثة: نستخدم Firebase (Google Cloud) لاستضافة قاعدة البيانات وتسجيل الدخول، و Paymob لمعالجة المدفوعات.\n\n' +
        '• استخدام البيانات: يقتصر على تفعيل الجلسات الرقمية، تسليم البطاقات، والتواصل بخصوص طلبك.\n\n' +
        '• حقوقك: يمكنك مراجعة بياناتك في صفحة /my، وطلب حذف حسابك بالكامل عبر التواصل معنا.\n\n' +
        '• للاستفسار: ineed.ad2020@gmail.com  |  +20 127 536 7743',
      questionEn: 'Privacy Policy',
      answerEn:
        'Teleplay is committed to protecting user privacy.\n\n' +
        '• Data we collect: phone number (for SMS sign-in), display name (shown only to your play partner), optional profile photo (shown only during the session), and order data.\n\n' +
        '• Payment data: fully processed through the licensed Paymob gateway — we never store your card numbers.\n\n' +
        '• Third parties: Firebase (Google Cloud) for database and auth, Paymob for payment processing.\n\n' +
        '• Data usage: limited to activating digital sessions, delivering cards, and communicating about your order.\n\n' +
        '• Your rights: review your data at /my, or contact us to request full account deletion.\n\n' +
        '• Contact: ineed.ad2020@gmail.com  |  +20 127 536 7743',
    },
    {
      id: 'q8-refund',
      order: 80, visible: true,
      questionAr: 'سياسة الاسترجاع',
      answerAr:
        'منتجاتنا رقمية — يحصل العميل على الوصول فوراً بعد إتمام الدفع.\n\n' +
        '• جلسات لم يتم استخدامها: يحق للعميل طلب استرداد كامل خلال ٧ أيام من تاريخ الشراء.\n\n' +
        '• جلسات تم بدؤها: غير قابلة للاسترداد بعد بدء التحدي (تم تسليم المنتج الرقمي).\n\n' +
        '• باقات الشركات: يمكن استرداد قيمة الأكواد غير المفعّلة خلال ١٤ يوماً من تاريخ الشراء.\n\n' +
        '• كيفية طلب الاسترداد: تواصل معنا عبر واتساب (+20 127 536 7743) أو البريد الإلكتروني (ineed.ad2020@gmail.com)، مع ذكر رقم الطلب.\n\n' +
        '• مدة المعالجة: ٧-١٤ يوم عمل من تاريخ الموافقة على الطلب. تُرد الأموال بنفس وسيلة الدفع المستخدمة.',
      questionEn: 'Refund Policy',
      answerEn:
        'Our products are digital — customers receive immediate access after payment.\n\n' +
        '• Unused sessions: full refund available within 7 days of purchase.\n\n' +
        '• Started sessions: non-refundable once the challenge has begun (digital product delivered).\n\n' +
        '• Business packages: unactivated codes are refundable within 14 days of purchase.\n\n' +
        '• How to request: contact us via WhatsApp (+20 127 536 7743) or email (ineed.ad2020@gmail.com), mentioning your order number.\n\n' +
        '• Processing time: 7-14 business days from approval. Refunds are issued to the original payment method.',
    },
    {
      id: 'q9-contact',
      order: 90, visible: true,
      questionAr: 'كيف أتواصل معكم؟',
      answerAr:
        '📞 هاتف / واتساب: +20 127 536 7743\n' +
        '📧 بريد إلكتروني: ineed.ad2020@gmail.com\n' +
        '📍 العنوان: 315 شارع جمال عبد الناصر — العصافرة بحري — الدور الثاني علوي — الإسكندرية، مصر\n\n' +
        'التحدي تابع لشركة ineed4ecommerce.online — جميع الحقوق محفوظة.',
      questionEn: 'How can I contact you?',
      answerEn:
        '📞 Phone / WhatsApp: +20 127 536 7743\n' +
        '📧 Email: ineed.ad2020@gmail.com\n' +
        '📍 Address: 315 Gamal Abdel Nasser St. — El Asafra Bahri — 2nd Floor — Alexandria, Egypt\n\n' +
        'This challenge is operated by ineed4ecommerce.online — All rights reserved.',
    },
  ];

  async function listFaq(opts) {
    const fb = ensureFirebase();
    if (!fb) return [];
    const snap = await fb.database().ref('faq').once('value');
    const v = snap.val();
    let out = [];
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(k => out.push({ id: k, ...v[k] }));
    }
    if (opts && opts.visibleOnly) out = out.filter(f => f.visible !== false);
    out.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    return out;
  }

  async function saveFaq(id, data) {
    const fb = ensureFirebase(); if (!fb) return;
    if (!id) throw new Error('faq id required');
    const clean = {};
    ['questionAr', 'answerAr', 'questionEn', 'answerEn'].forEach(k => {
      if (data[k] !== undefined) clean[k] = String(data[k]);
    });
    if (data.order !== undefined) clean.order = Number(data.order) || 0;
    if (data.visible !== undefined) clean.visible = !!data.visible;
    await fb.database().ref('faq/' + id).update(clean);
  }

  async function deleteFaq(id) {
    const fb = ensureFirebase(); if (!fb) return;
    await fb.database().ref('faq/' + id).remove();
  }

  async function seedFaqIfEmpty() {
    const fb = ensureFirebase(); if (!fb) return false;
    const snap = await fb.database().ref('faq').once('value');
    if (snap.val()) return false;
    const updates = {};
    DEFAULT_FAQ.forEach(f => { updates[f.id] = { ...f }; delete updates[f.id].id; });
    await fb.database().ref('faq').set(updates);
    return true;
  }
  function whatsappLink(number, message) {
    const num = String(number || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
    const msg = encodeURIComponent(String(message || ''));
    return num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`;
  }

  // ============== Purchase Orders ==============
  function cleanOrderInput(data) {
    data = data || {};
    return {
      packageId: String(data.packageId || '').slice(0, 64),
      packageName: String(data.packageName || '').slice(0, 80),
      packageType: String(data.packageType || 'individual').slice(0, 20),
      codesCount: Math.max(1, Math.min(10000, Number(data.codesCount) || 1)),
      sessionsPerCode: Math.max(1, Math.min(100, Number(data.sessionsPerCode) || 5)),
      price: Math.max(0, Number(data.price) || 0),
      currency: String(data.currency || 'EGP').slice(0, 8),
      buyerName: String(data.buyerName || '').trim().slice(0, 80),
      buyerPhone: String(data.buyerPhone || '').replace(/[^\d+]/g, '').slice(0, 30),
      buyerEmail: String(data.buyerEmail || '').trim().slice(0, 80),
      notes: String(data.notes || '').trim().slice(0, 300),
    };
  }
  async function createOrder(data) {
    const fb = ensureFirebase(); if (!fb) throw new Error('init');
    const clean = cleanOrderInput(data);
    if (!clean.packageId || !clean.packageName) throw new Error('package_required');
    if (!clean.buyerName || !clean.buyerPhone) throw new Error('buyer_required');

    const phoneKey = phoneRateKey(clean.buyerPhone);
    const now = Date.now();
    try {
      const rateRef = fb.database().ref('orderRateLimit/' + phoneKey);
      const rateSnap = await rateRef.once('value');
      const last = Number(rateSnap.val() || 0);
      if (last && now - last < ORDER_COOLDOWN_MS) {
        const err = new Error('rate_limited');
        err.waitSec = Math.ceil((ORDER_COOLDOWN_MS - (now - last)) / 1000);
        throw err;
      }
      await rateRef.set(now);
    } catch (e) {
      if (e && e.message === 'rate_limited') throw e;
    }

    const id = randomCode('ORD', 8);
    const pk = phoneRateKey(clean.buyerPhone);
    const payload = {
      ...clean,
      phoneKey: pk,
      status: 'pending',
      createdAt: Date.now(),
      source: data && data.source ? String(data.source).slice(0, 30) : 'landing',
      paymentMethod: data && data.paymentMethod ? String(data.paymentMethod).slice(0, 20) : 'whatsapp',
      paymentStatus: 'pending',
    };
    await fb.database().ref('orders/' + id).set(payload);
    if (pk && global.TPAccount && global.TPAccount.linkOrderToCustomer) {
      await global.TPAccount.linkOrderToCustomer(pk, id, {
        packageId: clean.packageId,
        packageName: clean.packageName,
        price: clean.price,
        currency: clean.currency,
        sessionsCount: (Number(clean.codesCount) || 1) * (Number(clean.sessionsPerCode) || 5),
        createdAt: payload.createdAt,
      }).catch(() => {});
    }
    return { id, ...payload };
  }

  function buildOrderWhatsAppMessage(order, lang) {
    const o = order || {};
    const isEn = lang === 'en';
    return (isEn ? 'New Telepathy order\nOrder: ' : 'طلب شراء جديد في Telepathy\nرقم الطلب: ') + (o.id || '')
      + (isEn ? '\nPackage: ' : '\nالباقة: ') + (o.packageName || '')
      + (isEn ? '\nName: ' : '\nالاسم: ') + (o.buyerName || '')
      + (isEn ? '\nWhatsApp: ' : '\nواتساب: ') + (o.buyerPhone || '')
      + (isEn ? '\nPrice: ' : '\nالسعر: ') + (Number(o.price) || 0) + ' ' + (o.currency || 'EGP')
      + (isEn ? '\n\nFollow from /my after payment confirmation.' : '\n\nبعد تأكيد الدفع — بطاقاتك في /my');
  }

  async function listOrders(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('orders').once('value');
    const out = [];
    snap.forEach(s => {
      const val = s.val() || {};
      if (val.codes && !Array.isArray(val.codes)) val.codes = Object.values(val.codes);
      out.push({ id: s.key, ...val });
    });
    out.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
    let arr = out;
    if (filter && filter.status) arr = arr.filter(o => o.status === filter.status);
    if (filter && filter.limit) arr = arr.slice(0, filter.limit);
    return arr;
  }
  async function saveOrder(id, data) {
    const fb = ensureFirebase(); if (!fb) return;
    await fb.database().ref('orders/' + id).update(data || {});
  }
  async function markCodeSold(code, order, by) {
    const fb = ensureFirebase(); if (!fb) return;
    code = normalizeCode(code);
    const cleanOrder = order || {};
    await fb.database().ref('accessCodes/' + code).update({
      sold: true,
      soldAt: Date.now(),
      soldBy: by || '',
      soldToName: String(cleanOrder.buyerName || '').slice(0, 80),
      soldToPhone: String(cleanOrder.buyerPhone || '').slice(0, 30),
      soldOrderId: cleanOrder.id || '',
      soldPackageId: cleanOrder.packageId || '',
    });
  }

  /** Calculate cost for `count` codes with optional reseller discount */
  function priceFor(count, pricing, resellerDiscountPct) {
    pricing = pricing || DEFAULT_PRICING;
    const tier = (pricing.tiers || []).find(t => count >= t.min && count <= t.max) || { discountPct: 0 };
    const baseDiscount = Number(tier.discountPct) || 0;
    const personalDiscount = Number(resellerDiscountPct) || 0;
    // ندمج الخصمين بصيغة تراكمية (ليس جمعًا مباشراً)
    const totalDiscount = 1 - (1 - baseDiscount/100) * (1 - personalDiscount/100);
    const unit = pricing.basePerCode * (1 - totalDiscount);
    const total = unit * count;
    return {
      unit: Math.round(unit * 100) / 100,
      total: Math.round(total * 100) / 100,
      basePerCode: pricing.basePerCode,
      currency: pricing.currency || 'EGP',
      tierDiscountPct: baseDiscount,
      personalDiscountPct: personalDiscount,
      totalDiscountPct: Math.round(totalDiscount * 1000) / 10
    };
  }

  // ============== Resellers (admin) ==============
  async function listResellers() {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('resellers').once('value');
    const out = [];
    snap.forEach(s => { out.push({ uid: s.key, ...s.val() }); });
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }
  async function getReseller(uid) {
    const fb = ensureFirebase(); if (!fb) return null;
    const snap = await fb.database().ref('resellers/' + uid).once('value');
    return snap.val();
  }
  async function saveReseller(uid, data) {
    const fb = ensureFirebase(); if (!fb) return;
    await fb.database().ref('resellers/' + uid).update(data);
  }
  async function topUpReseller(uid, addBalance, by) {
    const fb = ensureFirebase(); if (!fb) return;
    const ref = fb.database().ref('resellers/' + uid + '/balance');
    await ref.transaction(v => (Number(v) || 0) + Number(addBalance));
    const opId = randomCode('OP', 8);
    await fb.database().ref('resellerOps/' + opId).set({
      resellerId: uid, type: 'topup', count: Number(addBalance),
      at: Date.now(), by: by || 'admin'
    });
  }

  /** Reseller generates: deduct balance, then mint codes */
  async function resellerCreateBatch(opts) {
    const fb = ensureFirebase(); if (!fb) throw new Error('init');
    const uid = opts.resellerId;
    if (!uid) throw new Error('no_reseller');
    const count = Math.min(Math.max(Number(opts.count) || 1, 1), 500);

    // خصم الرصيد بمعاملة واحدة أولاً
    const balRef = fb.database().ref('resellers/' + uid + '/balance');
    const tx = await balRef.transaction(v => {
      const cur = Number(v) || 0;
      if (cur < count) return; // abort
      return cur - count;
    });
    if (!tx.committed) throw new Error('insufficient_balance');

    try {
      const res = await createBatch({ ...opts, resellerId: uid });
      // سجلّ العملية وحدّث totals
      const opId = randomCode('OP', 8);
      const updates = {};
      updates['resellerOps/' + opId] = {
        resellerId: uid, type: 'generate', count, at: Date.now(),
        batchId: res.batchId, prefix: opts.prefix || '', label: opts.label || ''
      };
      await fb.database().ref().update(updates);
      // حدّث إجمالي الأكواد التي ولّدها الوكيل
      await fb.database().ref('resellers/' + uid + '/totalGenerated').transaction(v => (Number(v)||0) + count);
      return res;
    } catch (err) {
      // rollback balance on failure
      await balRef.transaction(v => (Number(v)||0) + count);
      throw err;
    }
  }

  /** List reseller operations log (admin only). Optional filters: { resellerId, limit } */
  async function listResellerOps(filter) {
    const fb = ensureFirebase(); if (!fb) return [];
    const snap = await fb.database().ref('resellerOps').once('value');
    const out = [];
    snap.forEach(s => { out.push({ id: s.key, ...s.val() }); });
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    let arr = out;
    if (filter && filter.resellerId) arr = arr.filter(o => o.resellerId === filter.resellerId);
    if (filter && filter.type) arr = arr.filter(o => o.type === filter.type);
    if (filter && filter.limit) arr = arr.slice(0, filter.limit);
    return arr;
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
    removeCode,
    listCodes,
    listMyCodes,
    // pricing
    DEFAULT_PRICING,
    getPricing,
    setPricing,
    priceFor,
    // resellers
    listResellers,
    getReseller,
    saveReseller,
    topUpReseller,
    resellerCreateBatch,
    listResellerOps,
    // packages & settings
    DEFAULT_PACKAGES,
    listPackages,
    savePackage,
    deletePackage,
    seedPackagesIfEmpty,
    // faq
    DEFAULT_FAQ,
    listFaq,
    saveFaq,
    deleteFaq,
    seedFaqIfEmpty,
    // marketing — promo codes & affiliates
    normalizePromoCode,
    getPromoCode,
    listPromoCodes,
    savePromoCode,
    deletePromoCode,
    setPromoCodeStatus,
    normalizeAffiliateId,
    listAffiliates,
    getAffiliate,
    saveAffiliate,
    deleteAffiliate,
    markCommissionPaid,
    listPromoUses,
    listAffiliatePayouts,
    DEFAULT_SETTINGS,
    getSettings,
    setSettings,
    whatsappLink,
    // orders
    createOrder,
    buildOrderWhatsAppMessage,
    listOrders,
    saveOrder,
    markCodeSold,
  };
})(window);
