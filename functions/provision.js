'use strict';

const crypto = require('crypto');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// CSPRNG — session codes are bearer credentials (whoever holds JS-XXXXXX can
// enter the session), so they must not come from a predictable PRNG.
function randomCode(prefix, len = 6) {
  let s = '';
  for (let i = 0; i < len; i += 1) {
    s += ALPHA[crypto.randomInt(ALPHA.length)];
  }
  return prefix ? `${prefix}-${s}` : s;
}

function phoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-15);
}

function customerOrderPayload(order, status, extra) {
  extra = extra || {};
  return {
    status: status || order.status || 'pending',
    packageId: order.packageId || '',
    packageName: order.packageName || '',
    price: Number(order.price) || 0,
    currency: order.currency || 'USD',
    sessionsCount: Number(extra.sessionsCount ||
      ((Number(order.codesCount) || 1) * (Number(order.sessionsPerCode) || 5))),
    createdAt: Number(order.createdAt || extra.createdAt || Date.now()),
    fulfilledAt: Number(extra.fulfilledAt || order.fulfilledAt || 0),
  };
}

/** Provision JS session cards for individual orders (same logic as client account.js). */
async function provisionFromOrder(db, order, fulfilledBy) {
  const pk = order.phoneKey || phoneKey(order.buyerPhone);
  if (!pk) throw new Error('phone_required');

  const orderId = order.id || order.orderId || '';
  const name = String(order.buyerName || '').trim().slice(0, 80);
  const sessionsCount = Math.max(1, Math.min(500,
    (Number(order.codesCount) || 1) * (Number(order.sessionsPerCode) || 5)
  ));

  const now = Date.now();
  const userDataPath = (key) => `userData/${key}`;

  const profSnap = await db.ref(`${userDataPath(pk)}/profile`).once('value');
  const prof = profSnap.val() || {};
  const startIndex = Number(prof.totalSessions || 0);
  const updates = {};
  const sessions = [];

  for (let i = 0; i < sessionsCount; i += 1) {
    const sessionCode = randomCode('JS', 6);
    const sessionId = `s${startIndex + i + 1}_${now}`;
    const card = {
      index: startIndex + i + 1,
      sessionCode,
      status: 'available',
      orderId,
      packageId: order.packageId || '',
      createdAt: now,
      roomId: '',
      usedAt: 0,
      scorePct: 0,
      partnerName: '',
    };
    sessions.push({ sessionId, sessionCode, ...card });
    updates[`${userDataPath(pk)}/sessions/${sessionId}`] = card;
    updates[`sessionIndex/${sessionCode}`] = {
      phoneKey: pk,
      sessionId,
      status: 'available',
      createdAt: now,
    };
    updates[`accessCodes/${sessionCode}`] = {
      type: 'session',
      status: 'active',
      maxSessions: 1,
      usedSessions: 0,
      createdAt: now,
      expiresAt: now + 1000 * 60 * 60 * 24 * 365,
      label: `طلب ${orderId}`,
      ownerId: pk,
      sessionId,
      ownerPhoneKey: pk,
      sold: true,
      soldAt: now,
      soldBy: fulfilledBy || 'stripe',
      soldToName: name,
      soldToPhone: String(order.buyerPhone || '').slice(0, 30),
      soldOrderId: orderId,
    };
  }

  updates[`${userDataPath(pk)}/profile`] = {
    name: name || prof.name || '',
    phone: String(order.buyerPhone || '').slice(0, 30),
    phoneKey: pk,
    role: prof.role || 'customer',
    createdAt: prof.createdAt || now,
    totalSessions: startIndex + sessionsCount,
    lastOrderId: orderId,
  };
  if (orderId) updates[`${userDataPath(pk)}/orders/${orderId}`] = now;

  if (orderId) {
    updates[`customerOrders/${pk}/${orderId}`] = customerOrderPayload(order, 'fulfilled', {
      sessionsCount,
      fulfilledAt: now,
    });
    updates[`orders/${orderId}/phoneKey`] = pk;
  }

  await db.ref().update(updates);
  return { phoneKey: pk, sessions, sessionsCount };
}

module.exports = { provisionFromOrder, phoneKey };
