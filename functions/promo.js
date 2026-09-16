'use strict';

/**
 * Promo Codes & Affiliate helpers — server-side authoritative.
 * Never trust client-computed prices; always recompute here before hitting the
 * payment gateway.
 *
 * This module is intentionally **stateless**: it takes the promo record + order
 * as input, and returns the amounts. RTDB updates are performed by callers in
 * index.js (createPaymobCheckout / fulfillPaidOrder) so we keep webhook
 * fulfillment idempotent.
 */

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24).trim();
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Validate a promo record (already fetched from RTDB) against an order amount.
 * Returns { ok, reason, discountAmount, finalPrice, commission, promo }.
 * `reason` is one of: 'not_found' | 'disabled' | 'expired' | 'used_up' |
 * 'below_min' | 'self_use'.
 */
function evaluatePromo(promo, opts) {
  opts = opts || {};
  const price = Math.max(0, Number(opts.price) || 0);
  const buyerPhoneKey = String(opts.buyerPhoneKey || '');

  if (!promo) {
    return { ok: false, reason: 'not_found', discountAmount: 0, finalPrice: price, commission: 0 };
  }
  if (promo.status === 'disabled') {
    return { ok: false, reason: 'disabled', discountAmount: 0, finalPrice: price, commission: 0 };
  }
  const now = Date.now();
  if (promo.status === 'expired' || (promo.expiresAt && Number(promo.expiresAt) > 0 && now > Number(promo.expiresAt))) {
    return { ok: false, reason: 'expired', discountAmount: 0, finalPrice: price, commission: 0 };
  }
  const limit = Number(promo.usageLimit || 0);
  const used = Number(promo.usedCount || 0);
  if (limit > 0 && used >= limit) {
    return { ok: false, reason: 'used_up', discountAmount: 0, finalPrice: price, commission: 0 };
  }
  const minOrder = Number(promo.minOrderAmount || 0);
  if (minOrder > 0 && price < minOrder) {
    return {
      ok: false,
      reason: 'below_min',
      discountAmount: 0,
      finalPrice: price,
      commission: 0,
      minOrderAmount: minOrder,
    };
  }
  // Anti self-referral: buyer cannot use their own code.
  if (promo.affiliateId && buyerPhoneKey && String(promo.affiliateId) === buyerPhoneKey) {
    return { ok: false, reason: 'self_use', discountAmount: 0, finalPrice: price, commission: 0 };
  }

  let discount = 0;
  if (String(promo.discountType) === 'percent') {
    const pct = Math.max(0, Math.min(100, Number(promo.discountValue) || 0));
    discount = (price * pct) / 100;
  } else {
    discount = Math.max(0, Number(promo.discountValue) || 0);
  }
  discount = Math.min(discount, price);
  const final = Math.max(0, price - discount);

  let commission = 0;
  if (String(promo.commissionType) === 'percent') {
    const pct = Math.max(0, Math.min(100, Number(promo.commissionValue) || 0));
    commission = (final * pct) / 100;
  } else {
    commission = Math.max(0, Number(promo.commissionValue) || 0);
  }

  return {
    ok: true,
    reason: 'ok',
    promo,
    discountAmount: round2(discount),
    finalPrice: round2(final),
    commission: round2(commission),
    affiliateId: String(promo.affiliateId || ''),
    affiliateName: String(promo.affiliateName || ''),
  };
}

/** Fetch + evaluate in one call, given RTDB admin reference. */
async function evaluateFromDb(db, rawCode, opts) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'not_found', discountAmount: 0, finalPrice: Math.max(0, Number((opts||{}).price) || 0), commission: 0 };
  const snap = await db.ref('promoCodes/' + code).once('value');
  const promo = snap.exists() ? { code, ...snap.val() } : null;
  return evaluatePromo(promo, opts);
}

module.exports = {
  normalizeCode,
  evaluatePromo,
  evaluateFromDb,
};
