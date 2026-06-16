'use strict';

const crypto = require('crypto');

/** Egypt default — test/live same base URL; mode from keys. */
const DEFAULT_API_BASE = 'https://accept.paymob.com';

function paymobConfig(settings) {
  settings = settings || {};
  const fromAdmin = parseIntegrationIds(settings.paymobIntegrationIds || '');
  const fromEnv = parseIntegrationIds(process.env.PAYMOB_INTEGRATION_IDS || '');
  const integrationIds = fromAdmin.length ? fromAdmin : fromEnv;
  return {
    secretKey: process.env.PAYMOB_SECRET_KEY || '',
    publicKey: process.env.PAYMOB_PUBLIC_KEY || settings.paymobPublicKey || '',
    hmacSecret: process.env.PAYMOB_HMAC_SECRET || '',
    integrationIds,
    apiBase: (process.env.PAYMOB_API_BASE || DEFAULT_API_BASE).replace(/\/$/, ''),
  };
}

function setupStatus(settings) {
  const cfg = paymobConfig(settings);
  return {
    ready: isConfigured(cfg),
    secretKey: !!cfg.secretKey,
    hmacSecret: !!cfg.hmacSecret,
    publicKey: !!cfg.publicKey,
    integrationIds: cfg.integrationIds.length > 0,
  };
}

function parseIntegrationIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(Number).filter(Boolean);
  return String(raw).split(/[,|\s]+/).map((x) => Number(x.trim())).filter(Boolean);
}

function isConfigured(cfg) {
  return !!(cfg.secretKey && cfg.publicKey && cfg.hmacSecret && cfg.integrationIds.length);
}

/** Flatten Paymob JSON errors into a readable string for the client. */
function formatApiError(data, status) {
  if (!data || typeof data !== 'object') {
    return status ? `Paymob HTTP ${status}` : 'Paymob API error';
  }
  if (typeof data.detail === 'string' && data.detail.trim()) return data.detail.trim();
  if (Array.isArray(data.detail)) {
    return data.detail.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('; ');
  }
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  const parts = [];
  Object.keys(data).forEach((key) => {
    const val = data[key];
    if (typeof val === 'string') parts.push(`${key}: ${val}`);
    else if (Array.isArray(val)) parts.push(`${key}: ${val.join(', ')}`);
    else if (val && typeof val === 'object') {
      Object.keys(val).forEach((sub) => {
        const sv = val[sub];
        if (Array.isArray(sv)) parts.push(`${key}.${sub}: ${sv.join(', ')}`);
        else if (typeof sv === 'string') parts.push(`${key}.${sub}: ${sv}`);
      });
    }
  });
  return parts.join(' · ') || (status ? `Paymob HTTP ${status}` : 'Paymob API error');
}

function paymobHttpsError(err) {
  const code = err && err.code;
  if (code === 'paymob_not_configured') {
    return { code: 'failed-precondition', message: 'Paymob keys not configured on server' };
  }
  if (code === 'amount_too_small') {
    return { code: 'failed-precondition', message: 'Order amount too small for Paymob' };
  }
  const msg = (err && err.message) || 'Paymob checkout failed';
  return { code: 'failed-precondition', message: msg };
}

/** Amount in piasters (EGP cents). */
function toPiasters(amount, currency) {
  const n = Math.max(0, Number(amount) || 0);
  const c = String(currency || 'EGP').toUpperCase();
  if (c === 'EGP') return Math.round(n * 100);
  return Math.round(n * 100);
}

function splitName(fullName) {
  const parts = String(fullName || 'Customer').trim().split(/\s+/);
  return {
    first_name: parts[0] || 'Customer',
    last_name: parts.slice(1).join(' ') || 'User',
  };
}

function normalizePhone(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (!p.startsWith('+')) {
    if (p.startsWith('0')) p = '+20' + p.slice(1);
    else if (p.startsWith('20')) p = '+' + p;
    else p = '+20' + p;
  }
  return p.slice(0, 20);
}

/**
 * Create Paymob payment intention (Unified Checkout).
 * Docs: https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention
 */
function normalizeOrderForPaymob(order, settings) {
  settings = settings || {};
  const o = { ...order };
  const src = String(o.currency || settings.currency || 'USD').toUpperCase();
  const target = String(settings.paymobCurrency || 'EGP').toUpperCase();
  if (src === target) return o;
  const rate = Math.max(1, Number(settings.paymobEgpRate || settings.usdToEgp) || 50);
  o.price = Math.max(1, Math.round((Number(o.price) || 0) * rate));
  o.currency = target;
  return o;
}

async function createIntention(opts) {
  const cfg = paymobConfig(opts.settings || opts.paymobSettings || null);
  if (!isConfigured(cfg)) {
    const err = new Error('Paymob keys not configured');
    err.code = 'paymob_not_configured';
    throw err;
  }

  const order = normalizeOrderForPaymob(opts.order || {}, opts.settings || opts.paymobSettings || null);
  const orderId = String(order.id || opts.orderId || '').trim();
  const amountPiasters = toPiasters(order.price, order.currency || 'EGP');
  if (amountPiasters < 100) {
    const err = new Error('Amount too small');
    err.code = 'amount_too_small';
    throw err;
  }

  const names = splitName(order.buyerName);
  const phone = normalizePhone(order.buyerPhone);
  const origin = opts.origin || 'https://four-fruits-fun.web.app';
  const webhookUrl = opts.notificationUrl || `${origin.replace(/\/$/, '')}/api/paymobWebhook`;

  const body = {
    amount: amountPiasters,
    currency: String(order.currency || 'EGP').toUpperCase(),
    payment_methods: cfg.integrationIds,
    items: [{
      name: String(order.packageName || 'Telepathy Challenge').slice(0, 80),
      amount: amountPiasters,
      description: `Order ${orderId}`,
      quantity: 1,
    }],
    billing_data: {
      apartment: 'NA',
      email: String(order.buyerEmail || 'customer@teleplay.online').slice(0, 80),
      floor: 'NA',
      first_name: names.first_name,
      last_name: names.last_name,
      street: 'NA',
      building: 'NA',
      phone_number: phone,
      city: 'Cairo',
      country: 'EG',
      state: 'NA',
    },
    extras: {
      orderId,
      phoneKey: order.phoneKey || '',
      project: 'four-fruits-fun',
    },
    special_reference: orderId,
    expiration: 3600,
    notification_url: webhookUrl,
    redirection_url: `${origin}/payment-success?order=${encodeURIComponent(orderId)}&provider=paymob`,
  };

  const res = await fetch(`${cfg.apiBase}/v1/intention/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${cfg.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text().catch(() => '');
  let data = {};
  try { data = rawText ? JSON.parse(rawText) : {}; } catch (_) { data = { detail: rawText.slice(0, 240) }; }
  if (!res.ok) {
    const msg = formatApiError(data, res.status);
    console.error('Paymob createIntention failed', res.status, msg, rawText.slice(0, 500));
    const err = new Error(msg);
    err.code = 'paymob_api_error';
    err.details = data;
    err.httpStatus = res.status;
    throw err;
  }

  const clientSecret = data.client_secret;
  if (!clientSecret) {
    const err = new Error('Paymob response missing client_secret');
    err.code = 'paymob_api_error';
    throw err;
  }

  const checkoutUrl = `${cfg.apiBase}/unifiedcheckout/?publicKey=${encodeURIComponent(cfg.publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`;

  return {
    checkoutUrl,
    intentionId: data.id || '',
    intentionOrderId: data.intention_order_id || data.payment_keys?.[0]?.order_id || null,
  };
}

/**
 * HMAC SHA-512 for Transaction Processed POST callback.
 * Docs: https://developers.paymob.com/paymob-docs/developers/webhooks/hmac-transaction-callback
 */
function verifyTransactionHmac(obj, receivedHmac, hmacSecret, isPost) {
  if (!obj || !receivedHmac || !hmacSecret) return false;
  const o = obj;
  const sd = o.source_data || {};
  const parts = [
    o.amount_cents,
    o.created_at,
    o.currency,
    o.error_occured,
    o.has_parent_transaction,
    isPost ? o.id : o.id,
    o.integration_id,
    o.is_3d_secure,
    o.is_auth,
    o.is_capture,
    o.is_refunded,
    o.is_standalone_payment,
    o.is_voided,
    isPost ? (o.order && o.order.id) : o.order_id,
    o.owner,
    o.pending,
    sd.pan,
    sd.sub_type,
    sd.type,
    o.success,
  ];
  const concat = parts.map((v) => {
    if (v === false) return 'false';
    if (v === true) return 'true';
    if (v == null) return '';
    return String(v);
  }).join('');

  const calculated = crypto.createHmac('sha512', hmacSecret).update(concat).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(String(receivedHmac), 'hex'));
  } catch (_) {
    return calculated === String(receivedHmac);
  }
}

function orderIdFromTransaction(obj) {
  if (!obj) return '';
  if (obj.order && obj.order.merchant_order_id) {
    return String(obj.order.merchant_order_id);
  }
  const claims = obj.payment_key_claims || {};
  const extras = claims.extra || claims.extras || obj.extras || obj.extra || {};
  if (extras.orderId) return String(extras.orderId);
  if (obj.special_reference) return String(obj.special_reference);
  if (claims.special_reference) return String(claims.special_reference);
  if (obj.merchant_order_id) return String(obj.merchant_order_id);
  return '';
}

function isTxnSuccess(obj) {
  return obj && (obj.success === true || obj.success === 'true' || obj.success === 1);
}

module.exports = {
  paymobConfig,
  setupStatus,
  isConfigured,
  createIntention,
  verifyTransactionHmac,
  orderIdFromTransaction,
  isTxnSuccess,
  paymobHttpsError,
};
