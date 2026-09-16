'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const { provisionFromOrder, phoneKey } = require('./provision');
const paymob = require('./paymob');
const promo = require('./promo');

const FN_REGION = 'us-central1';
const publicCall = (handler) => onCall({ region: FN_REGION, invoker: 'public' }, handler);
const publicHttp = (handler) => onRequest({ region: FN_REGION, invoker: 'public' }, handler);

admin.initializeApp();
const db = admin.database();

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpsError('failed-precondition', 'Stripe secret key not configured');
  return new Stripe(key);
}

function siteOrigin() {
  return process.env.APP_ORIGIN || 'https://teleplay.online';
}

function paymobWebhookPublicUrl() {
  const custom = process.env.PAYMOB_WEBHOOK_URL;
  if (custom) return custom;
  const project = process.env.GCLOUD_PROJECT || 'four-fruits-fun';
  return `https://us-central1-${project}.cloudfunctions.net/paymobWebhook`;
}

function stripeMinorUnits(amount, currency) {
  const c = String(currency || 'USD').toUpperCase();
  const zeroDecimal = ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
  const n = Math.max(0, Number(amount) || 0);
  return zeroDecimal.includes(c) ? Math.round(n) : Math.round(n * 100);
}

async function assertOrderOwner(orderId, uid) {
  const snap = await db.ref(`orders/${orderId}`).once('value');
  if (!snap.exists()) {
    throw new HttpsError('not-found', 'Order not found');
  }
  const order = { id: orderId, ...snap.val() };
  if (order.status === 'fulfilled') {
    throw new HttpsError('failed-precondition', 'Order already fulfilled');
  }
  if (order.status === 'cancelled') {
    throw new HttpsError('failed-precondition', 'Order cancelled');
  }
  const pk = order.phoneKey || phoneKey(order.buyerPhone);
  if (!pk) throw new HttpsError('failed-precondition', 'Invalid order phone');

  const idxSnap = await db.ref(`phoneIndex/${pk}/authUid`).once('value');
  if (idxSnap.val() !== uid) {
    throw new HttpsError('permission-denied', 'Order does not belong to this account');
  }
  return order;
}

function shouldProvisionSessionCards(order) {
  const codesCount = Number(order.codesCount) || 1;
  const pkgType = String(order.packageType || '').toLowerCase();
  return codesCount === 1 || pkgType === 'individual' || pkgType === 'session';
}

async function fulfillPaidOrder(orderId, paymentMeta, provider) {
  provider = provider || 'stripe';
  const snap = await db.ref(`orders/${orderId}`).once('value');
  if (!snap.exists()) return { skipped: true, reason: 'not_found' };
  const order = { id: orderId, ...snap.val() };
  if (order.status === 'fulfilled') return { skipped: true, reason: 'already_fulfilled' };

  const now = Date.now();
  let sessionCodes = Array.isArray(order.sessionCodes) ? order.sessionCodes.slice() : [];

  if (shouldProvisionSessionCards(order) && !sessionCodes.length) {
    const prov = await provisionFromOrder(db, order, provider);
    sessionCodes = prov.sessions.map((s) => s.sessionCode);
  }

  const patch = {
    status: 'fulfilled',
    paymentMethod: provider,
    paymentStatus: 'paid',
    paidAt: now,
    fulfilledAt: now,
    fulfilledBy: provider,
    phoneKey: order.phoneKey || phoneKey(order.buyerPhone),
    ...(sessionCodes.length ? {
      sessionCodes,
      codes: sessionCodes,
      code: sessionCodes[0] || '',
    } : {}),
  };

  if (provider === 'stripe') {
    patch.stripeSessionId = paymentMeta.sessionId || order.stripeSessionId || '';
    patch.stripePaymentIntentId = paymentMeta.paymentIntentId || '';
  }
  if (provider === 'paymob') {
    patch.paymobIntentionId = paymentMeta.intentionId || order.paymobIntentionId || '';
    patch.paymobTransactionId = String(paymentMeta.transactionId || '');
    patch.paymobOrderId = String(paymentMeta.paymobOrderId || '');
  }

  await db.ref(`orders/${orderId}`).update(patch);

  // Marketing: record promo usage + accrue affiliate commission (idempotent).
  try {
    await settleAffiliateForOrder(orderId, order, provider, paymentMeta);
  } catch (err) {
    // Do not fail the fulfillment on marketing bookkeeping errors — session
    // cards are already provisioned; we just log for admin review.
    console.error('settleAffiliateForOrder failed', orderId, err && err.message);
  }

  return { fulfilled: true, orderId, sessionCodes };
}

/**
 * Idempotently record a promo use + credit the affiliate's pending commission.
 * Guarded by `orderPromoIndex/{orderId}` — safe to re-invoke from retries.
 */
async function settleAffiliateForOrder(orderId, order, provider, paymentMeta) {
  const code = String(order.promoCode || '').trim();
  const affiliateId = String(order.affiliateId || '').trim();
  if (!code || !affiliateId) return { skipped: 'no_promo' };

  const indexRef = db.ref(`orderPromoIndex/${orderId}`);
  const tx = await indexRef.transaction((cur) => (cur ? cur : code));
  if (!tx.committed) return { skipped: 'index_conflict' };
  if (tx.snapshot.val() !== code) return { skipped: 'already_settled' };

  const originalPrice = Math.max(0, Number(order.originalPrice) || Number(order.price) || 0);
  const discountAmount = Math.max(0, Number(order.discountAmount) || 0);
  const finalPrice = Math.max(0, Number(order.price) || (originalPrice - discountAmount));
  const commission = Math.max(0, Number(order.affiliateCommission) || 0);

  // Increment aggregates on the affiliate record — best-effort transaction.
  await db.ref(`affiliates/${affiliateId}`).transaction((cur) => {
    if (!cur) return cur; // affiliate might have been deleted; skip silently
    cur.totalOrders = Number(cur.totalOrders || 0) + 1;
    cur.totalRevenue = Math.round((Number(cur.totalRevenue || 0) + originalPrice) * 100) / 100;
    cur.totalDiscountGiven = Math.round((Number(cur.totalDiscountGiven || 0) + discountAmount) * 100) / 100;
    cur.totalCommission = Math.round((Number(cur.totalCommission || 0) + commission) * 100) / 100;
    cur.pendingCommission = Math.round((Number(cur.pendingCommission || 0) + commission) * 100) / 100;
    return cur;
  });

  // Increment usedCount on the promo code.
  await db.ref(`promoCodes/${code}/usedCount`).transaction((v) => (Number(v) || 0) + 1);

  // Audit log entry.
  const opId = randomOpId('USE');
  await db.ref(`promoUses/${opId}`).set({
    code,
    affiliateId,
    orderId,
    buyerPhoneKey: String(order.phoneKey || phoneKey(order.buyerPhone) || ''),
    originalPrice,
    discountAmount,
    finalPrice,
    commissionEarned: commission,
    at: Date.now(),
    status: 'confirmed',
    provider,
    paymobTxnId: String((paymentMeta && paymentMeta.transactionId) || ''),
  });

  return { ok: true, opId, commission };
}

function randomOpId(prefix) {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i += 1) s += alpha[Math.floor(Math.random() * alpha.length)];
  return `${prefix}-${s}`;
}

/** Callable: after payment redirect — ensure session cards exist in /my (webhook backup). */
exports.claimOrderFulfillment = publicCall(async (request) => {
  const data = request.data || {};
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }
  const orderId = String(data.orderId || '').trim();
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required');

  const order = await assertOrderOwner(orderId, auth.uid);
  const hasCards = Array.isArray(order.sessionCodes) && order.sessionCodes.length > 0;

  if (order.status === 'fulfilled') {
    if (hasCards || !shouldProvisionSessionCards(order)) {
      return { ok: true, status: 'fulfilled', sessionCodes: order.sessionCodes || [] };
    }
    const prov = await provisionFromOrder(db, order, order.paymentMethod || 'paymob');
    const sessionCodes = prov.sessions.map((s) => s.sessionCode);
    await db.ref(`orders/${orderId}`).update({
      sessionCodes,
      codes: sessionCodes,
      code: sessionCodes[0] || '',
      phoneKey: order.phoneKey || phoneKey(order.buyerPhone),
    });
    return { ok: true, status: 'fulfilled', sessionCodes, repaired: true };
  }

  if (order.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Order cannot be fulfilled');
  }

  const paid = order.paymentStatus === 'paid' || !!order.paymobTransactionId;
  if (!paid) {
    return { ok: false, status: 'pending', waiting: true };
  }

  const result = await fulfillPaidOrder(orderId, {
    transactionId: order.paymobTransactionId || '',
    sessionId: order.stripeSessionId || '',
  }, order.paymentMethod || 'paymob');

  const fresh = await db.ref(`orders/${orderId}`).once('value');
  const val = fresh.val() || {};
  return {
    ok: true,
    status: val.status || 'fulfilled',
    sessionCodes: val.sessionCodes || [],
    result,
  };
});

/**
 * Callable: Client-side promo code preview.
 * Given a code + package/order price, returns the discounted amount and (public)
 * affiliate name. Does not touch RTDB — pure read + compute.
 */
exports.applyPromoCode = publicCall(async (request) => {
  const data = request.data || {};
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }
  const code = promo.normalizeCode(data.code || '');
  const price = Math.max(0, Number(data.price) || 0);
  if (!code) throw new HttpsError('invalid-argument', 'code required');
  if (!price) throw new HttpsError('invalid-argument', 'price required');

  // buyerPhoneKey — try to derive from auth token phone (best-effort);
  // real anti-self-referral is enforced again at checkout.
  const rawPhone = (request.auth.token && request.auth.token.phone_number) || '';
  const pk = rawPhone ? phoneKey(rawPhone) : '';

  const result = await promo.evaluateFromDb(db, code, { price, buyerPhoneKey: pk });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      minOrderAmount: result.minOrderAmount || 0,
    };
  }
  return {
    ok: true,
    code,
    discountAmount: result.discountAmount,
    finalPrice: result.finalPrice,
    affiliateName: result.affiliateName || '',
    // commission NOT returned to client — server-only.
  };
});

/**
 * Apply promo code server-side to an order (before hitting payment gateway).
 * Mutates the in-memory order object with promoCode / originalPrice / discountAmount /
 * affiliateId / affiliateCommission and returns the discounted price to charge.
 * Idempotent by design — safe to call multiple times per order attempt.
 */
async function applyPromoToOrder(order, rawCode) {
  const originalPrice = Math.max(0, Number(order.price) || 0);
  if (!rawCode) return { chargePrice: originalPrice, appliedPromo: null };

  const code = promo.normalizeCode(rawCode);
  if (!code) return { chargePrice: originalPrice, appliedPromo: null };

  const evalResult = await promo.evaluateFromDb(db, code, {
    price: originalPrice,
    buyerPhoneKey: order.phoneKey || '',
  });

  if (!evalResult.ok) {
    // Invalid promo at checkout — reject with a clear error so the client
    // clears the field and retries. Never silently drop; user paid attention.
    const map = {
      not_found: 'كود الخصم غير موجود',
      disabled:  'كود الخصم موقوف',
      expired:   'كود الخصم منتهي الصلاحية',
      used_up:   'تم استهلاك عدد استخدامات الكود',
      below_min: 'قيمة الطلب أقل من الحد الأدنى المطلوب لهذا الكود',
      self_use:  'لا يمكنك استخدام كودك الخاص',
    };
    const msg = map[evalResult.reason] || 'كود الخصم غير صالح';
    throw new HttpsError('failed-precondition', msg);
  }

  order.promoCode = code;
  order.originalPrice = originalPrice;
  order.discountAmount = evalResult.discountAmount;
  order.affiliateId = evalResult.affiliateId;
  order.affiliateCommission = evalResult.commission;
  order.price = evalResult.finalPrice;
  return { chargePrice: evalResult.finalPrice, appliedPromo: evalResult };
}

/** Callable: Paymob Unified Checkout — create intention + redirect URL. */
exports.createPaymobCheckout = publicCall(async (request) => {
  const data = request.data || {};
  try {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required');
    }

    const orderId = String(data.orderId || '').trim();
    if (!orderId) throw new HttpsError('invalid-argument', 'orderId required');

    const settingsSnap = await db.ref('settings').once('value');
    const settings = settingsSnap.val() || {};
    if (settings.paymobEnabled !== true && settings.paymobEnabled !== 'true') {
      throw new HttpsError('failed-precondition', 'Paymob payments are disabled');
    }

    const cfg = paymob.paymobConfig(settings);
    if (!paymob.isConfigured(cfg)) {
      throw new HttpsError('failed-precondition', 'Paymob keys not configured on server');
    }

    const order = await assertOrderOwner(orderId, request.auth.uid);
    const origin = siteOrigin();

    // Apply promo code (optional). May throw HttpsError with human-readable message.
    const rawPromoCode = String(data.promoCode || order.promoCode || '').trim();
    const { appliedPromo } = await applyPromoToOrder(order, rawPromoCode);

    const result = await paymob.createIntention({
      order,
      orderId,
      origin,
      settings,
      notificationUrl: paymobWebhookPublicUrl(),
    });

    try {
      const orderPatch = {
        paymentMethod: 'paymob',
        paymentStatus: 'pending',
        paymobIntentionId: result.intentionId || '',
        paymobOrderId: String(result.intentionOrderId || ''),
        updatedAt: Date.now(),
      };
      if (appliedPromo) {
        orderPatch.promoCode = order.promoCode;
        orderPatch.originalPrice = order.originalPrice;
        orderPatch.discountAmount = order.discountAmount;
        orderPatch.affiliateId = order.affiliateId;
        orderPatch.affiliateCommission = order.affiliateCommission;
        orderPatch.price = order.price;
      }
      await db.ref(`orders/${orderId}`).update(orderPatch);
    } catch (dbErr) {
      console.error('createPaymobCheckout order update failed', orderId, dbErr.message);
    }

    return {
      url: result.checkoutUrl,
      intentionId: result.intentionId,
      finalPrice: order.price,
      discountApplied: appliedPromo ? (appliedPromo.discountAmount || 0) : 0,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('createPaymobCheckout', data.orderId, err.message, err.details || err.stack || '');
    const mapped = paymob.paymobHttpsError(err);
    throw new HttpsError(mapped.code, mapped.message);
  }
});

/**
 * Paymob Transaction Processed webhook (authoritative).
 * Docs: https://developers.paymob.com/paymob-docs/developers/webhooks/hmac-transaction-callback
 */
exports.paymobWebhook = publicHttp(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const cfg = paymob.paymobConfig();
  if (!cfg.hmacSecret) {
    res.status(500).send('HMAC secret not configured');
    return;
  }

  const receivedHmac = req.query.hmac || req.query.HMAC || '';
  const body = req.body || {};
  const obj = body.obj || body;

  if (!paymob.verifyTransactionHmac(obj, receivedHmac, cfg.hmacSecret, true)) {
    console.error('Paymob HMAC verification failed');
    res.status(401).send('Invalid HMAC');
    return;
  }

  try {
    const txnId = String(obj.id || '');
    const orderId = paymob.orderIdFromTransaction(obj) ||
      (obj.order && obj.order.merchant_order_id && String(obj.order.merchant_order_id)) ||
      String(obj.special_reference || '');

    if (!orderId) {
      console.warn('Paymob webhook: no orderId', txnId);
      res.json({ received: true, skipped: 'no_order' });
      return;
    }

    if (paymob.isTxnSuccess(obj)) {
      const dedupeRef = db.ref(`paymobProcessed/${txnId}`);
      const existing = txnId ? await dedupeRef.once('value') : null;
      if (existing && existing.exists()) {
        res.json({ received: true, duplicate: true });
        return;
      }

      const result = await fulfillPaidOrder(orderId, {
        transactionId: txnId,
        intentionId: obj.payment_key_claims?.next_payment_intention || '',
        paymobOrderId: obj.order?.id || '',
      }, 'paymob');

      if (txnId) {
        await dedupeRef.set({ orderId, at: Date.now() });
      }
    } else {
      await db.ref(`orders/${orderId}`).update({
        paymentStatus: 'failed',
        updatedAt: Date.now(),
      }).catch(() => {});
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Paymob webhook handler error', err);
    res.status(500).send('Handler error');
  }
});

/** After phone OTP — grant admin if phone is in functions config admin.phones */
exports.ensureAdminAccess = publicCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }
  const phone = request.auth.token.phone_number;
  if (!phone) {
    throw new HttpsError('failed-precondition', 'Phone sign-in required');
  }
  const pk = phoneKey(phone);
  const raw = process.env.ADMIN_PHONES || '';
  const allowed = String(raw).split(/[,;\s]+/).map((p) => phoneKey(p)).filter(Boolean);
  if (!allowed.length || !allowed.includes(pk)) {
    throw new HttpsError('permission-denied', 'Not an admin phone');
  }
  await db.ref(`admins/${request.auth.uid}`).set(true);
  return { ok: true, uid: request.auth.uid, phoneKey: pk };
});

/** Admin: Paymob setup checklist (no secrets exposed). */
exports.getPaymobSetupStatus = publicCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }
  const adminSnap = await db.ref(`admins/${request.auth.uid}`).once('value');
  if (!adminSnap.val()) {
    throw new HttpsError('permission-denied', 'Admin only');
  }
  const settings = (await db.ref('settings').once('value')).val() || {};
  const status = paymob.setupStatus(settings);
  return {
    ...status,
    enabled: settings.paymobEnabled === true || settings.paymobEnabled === 'true',
    webhookUrl: paymobWebhookPublicUrl(),
    origin: siteOrigin(),
    integrationIds: paymob.paymobConfig(settings).integrationIds,
  };
});

/** Callable: create Stripe Checkout Session for pending order. */
exports.createStripeCheckout = publicCall(async (request) => {
  const data = request.data || {};
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }

  const orderId = String(data.orderId || '').trim();
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required');

  const settingsSnap = await db.ref('settings').once('value');
  const settings = settingsSnap.val() || {};
  if (settings.stripeEnabled !== true && settings.stripeEnabled !== 'true') {
    throw new HttpsError('failed-precondition', 'Card payments are disabled');
  }

  const order = await assertOrderOwner(orderId, request.auth.uid);
  const stripe = stripeClient();
  const origin = siteOrigin();

  // Apply promo code (optional) — mutates `order.price` if valid.
  const rawPromoCode = String(data.promoCode || order.promoCode || '').trim();
  const { appliedPromo } = await applyPromoToOrder(order, rawPromoCode);

  const currency = String(order.currency || settings.currency || 'USD').toLowerCase();
  const amount = stripeMinorUnits(order.price, currency);

  if (amount < 50 && currency === 'usd') {
    throw new HttpsError('failed-precondition', 'Amount too small for card payment');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: amount,
        product_data: {
          name: order.packageName || 'Telepathy Challenge',
          description: `Order ${orderId}${appliedPromo ? ` (promo ${appliedPromo.promo && appliedPromo.promo.code || order.promoCode})` : ''}`,
        },
      },
    }],
    client_reference_id: orderId,
    metadata: {
      orderId,
      phoneKey: order.phoneKey || phoneKey(order.buyerPhone),
      project: 'four-fruits-fun',
      ...(order.promoCode ? { promoCode: order.promoCode, affiliateId: order.affiliateId || '' } : {}),
    },
    success_url: `${origin}/payment-success?order=${encodeURIComponent(orderId)}&provider=stripe&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/payment-cancel?order=${encodeURIComponent(orderId)}`,
    customer_email: order.buyerEmail || undefined,
  });

  const orderPatch = {
    paymentMethod: 'stripe',
    paymentStatus: 'pending',
    stripeSessionId: session.id,
    updatedAt: Date.now(),
  };
  if (appliedPromo) {
    orderPatch.promoCode = order.promoCode;
    orderPatch.originalPrice = order.originalPrice;
    orderPatch.discountAmount = order.discountAmount;
    orderPatch.affiliateId = order.affiliateId;
    orderPatch.affiliateCommission = order.affiliateCommission;
    orderPatch.price = order.price;
  }
  await db.ref(`orders/${orderId}`).update(orderPatch);

  return {
    url: session.url,
    sessionId: session.id,
    finalPrice: order.price,
    discountApplied: appliedPromo ? (appliedPromo.discountAmount || 0) : 0,
  };
});

/** Stripe webhook — auto-fulfill on successful payment. */
exports.stripeWebhook = publicHttp(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    res.status(500).send('Webhook secret not configured');
    return;
  }

  let event;
  try {
    const stripe = stripeClient();
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId || session.client_reference_id;
      if (orderId) {
        await fulfillPaidOrder(orderId, {
          sessionId: session.id,
          paymentIntentId: session.payment_intent,
        }, 'stripe');
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error', err);
    res.status(500).send('Handler error');
  }
});
