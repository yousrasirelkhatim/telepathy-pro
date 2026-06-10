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
    fb.database().ref('stats/totals/sessionsPlayed').transaction((v) => (v || 0) + 1).catch(() => {});
  }
  function bumpShares() {
    const fb = ensureFirebase(); if (!fb) return;
    fb.database().ref('stats/totals/cardsShared').transaction((v) => (v || 0) + 1).catch(() => {});
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
    basePerCode: 2,
    currency: 'USD',
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
      price: 10, currency: 'USD',
      codesCount: 1, sessionsPerCode: 5,
      unitNote: 'دفعة واحدة',
      features: '5 جلسات تحدي كاملة\nبطاقة نتيجة قابلة للتنزيل\nقوالب تصميم متعددة\nصلاحية الكود سنة كاملة',
      badge: '', featured: false,
      buttonText: 'اشترِ الآن', order: 1, visible: true,
      whatsappMsg: 'أرغب بشراء كود فردي (5 جلسات - 10$)'
    },
    {
      id: 'business-50',
      name: 'باقة شركات صغيرة', icon: '🏪',
      desc: 'لمطاعم، كافيهات، ومتاجر صغيرة',
      price: 200, currency: 'USD',
      codesCount: 50, sessionsPerCode: 5,
      unitNote: '50 كود — توفير 60%',
      features: '50 كود، كل كود = 5 جلسات\nإجمالي 250 جلسة لعميلكم\nلوحة إدارة الأكواد\nإمكانية تخصيص اسم البزنس على البطاقة\nدعم فني مباشر',
      badge: '⭐ الأكثر طلباً', featured: true,
      buttonText: 'طلب الباقة', order: 2, visible: true,
      whatsappMsg: 'أرغب بطلب باقة شركات (50 كود - 200$)'
    },
    {
      id: 'business-100',
      name: 'باقة شركات كبرى', icon: '🏬',
      desc: 'للمولات، الفنادق، وسلاسل المطاعم',
      price: 350, currency: 'USD',
      codesCount: 100, sessionsPerCode: 5,
      unitNote: '100 كود — توفير 65%',
      features: '100 كود، إجمالي 500 جلسة\nلوحة إدارة وتقارير شاملة\nاسم وشعار البزنس على البطاقة\nQR لكل كود لطباعته\nأولوية في الدعم',
      badge: '', featured: false,
      buttonText: 'طلب الباقة', order: 3, visible: true,
      whatsappMsg: 'أرغب بطلب باقة شركات كبرى (100 كود - 350$)'
    }
  ];

  async function listPackages(opts) {
    const fb = ensureFirebase(); if (!fb) return DEFAULT_PACKAGES.slice();
    const snap = await fb.database().ref('packages').once('value');
    const v = snap.val();
    let out = [];
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(k => out.push({ id: k, ...v[k] }));
    }
    if (!out.length) out = DEFAULT_PACKAGES.slice();
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

  // ============== Settings (brand, whatsapp, currency, hero copy) ==============
  const DEFAULT_SETTINGS = {
    whatsappNumber: '',
    currency: 'USD',
    brandName: 'Telepathy Challenge',
    tagline: 'تحدي التخاطر — لعبة ذكية للأزواج والأصدقاء',
    heroTitle: 'هل تفكران بنفس الطريقة؟',
    heroBadge: '✨ الإصدار الجديد 2026',
    heroStats: '⚡ يبدأ فوري | 📱 يعمل على الجوال | 🎁 5 تحديات لكل كود',
    bizMessage: 'أرغب بمعرفة المزيد عن باقات الأعمال'
  };
  async function getSettings() {
    const fb = ensureFirebase(); if (!fb) return { ...DEFAULT_SETTINGS };
    const snap = await fb.database().ref('settings').once('value');
    return { ...DEFAULT_SETTINGS, ...(snap.val() || {}) };
  }
  async function setSettings(s) {
    const fb = ensureFirebase(); if (!fb) return;
    const clean = {};
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (s[k] !== undefined) clean[k] = String(s[k]);
    });
    await fb.database().ref('settings').update(clean);
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
      currency: String(data.currency || 'USD').slice(0, 8),
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
    const id = randomCode('ORD', 8);
    const payload = {
      ...clean,
      status: 'pending',
      createdAt: Date.now(),
      source: 'landing',
    };
    await fb.database().ref('orders/' + id).set(payload);
    return { id, ...payload };
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
      currency: pricing.currency || 'USD',
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
    DEFAULT_SETTINGS,
    getSettings,
    setSettings,
    whatsappLink,
    // orders
    createOrder,
    listOrders,
    saveOrder,
    markCodeSold,
  };
})(window);
