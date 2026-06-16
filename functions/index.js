'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const { provisionFromOrder, phoneKey } = require('./provision');
const paymob = require('./paymob');

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
  return { fulfilled: true, orderId, sessionCodes };
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

    const result = await paymob.createIntention({
      order,
      orderId,
      origin,
      settings,
      notificationUrl: paymobWebhookPublicUrl(),
    });

    try {
      await db.ref(`orders/${orderId}`).update({
        paymentMethod: 'paymob',
        paymentStatus: 'pending',
        paymobIntentionId: result.intentionId || '',
        paymobOrderId: String(result.intentionOrderId || ''),
        updatedAt: Date.now(),
      });
    } catch (dbErr) {
      console.error('createPaymobCheckout order update failed', orderId, dbErr.message);
    }

    return {
      url: result.checkoutUrl,
      intentionId: result.intentionId,
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
          description: `Order ${orderId}`,
        },
      },
    }],
    client_reference_id: orderId,
    metadata: {
      orderId,
      phoneKey: order.phoneKey || phoneKey(order.buyerPhone),
      project: 'four-fruits-fun',
    },
    success_url: `${origin}/payment-success?order=${encodeURIComponent(orderId)}&provider=stripe&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/payment-cancel?order=${encodeURIComponent(orderId)}`,
    customer_email: order.buyerEmail || undefined,
  });

  await db.ref(`orders/${orderId}`).update({
    paymentMethod: 'stripe',
    paymentStatus: 'pending',
    stripeSessionId: session.id,
    updatedAt: Date.now(),
  });

  return { url: session.url, sessionId: session.id };
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
