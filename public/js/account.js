/* =========================================================================
   Telepathy – Customer accounts & session cards
   Auth: Firebase Phone OTP only (no email/PIN)
   ========================================================================= */
(function (global) {
  'use strict';

  function ensureFirebase() {
    if (typeof firebase === 'undefined') return null;
    if (!firebase.apps.length && global.TPCodes && global.TPCodes.config) {
      firebase.initializeApp(global.TPCodes.config);
    } else if (!firebase.apps.length) return null;
    return firebase;
  }

  function phoneKey(phone) {
    if (global.TPPhoneAuth && global.TPPhoneAuth.phoneKey) {
      return global.TPPhoneAuth.phoneKey(phone);
    }
    const digits = String(phone || '').replace(/\D/g, '').slice(-15);
    return digits || '';
  }

  function phoneKeyFromUser(user) {
    if (global.TPPhoneAuth && global.TPPhoneAuth.phoneKeyFromUser) {
      return global.TPPhoneAuth.phoneKeyFromUser(user);
    }
    if (!user || !user.phoneNumber) return '';
    return phoneKey(user.phoneNumber);
  }

  function userDataPath(phoneKeyVal) {
    return 'userData/' + phoneKeyVal;
  }

  function sessionPlayLink(code) {
    const base = (typeof location !== 'undefined' && location.origin) ? location.origin : 'https://www.teleplay.online';
    return base + '/play?session=' + encodeURIComponent(code) + '&lang=ar';
  }

  function roomPlayLink(roomId) {
    const base = (typeof location !== 'undefined' && location.origin) ? location.origin : 'https://www.teleplay.online';
    return base + '/play?room=' + encodeURIComponent(roomId) + '&lang=ar';
  }

  function myPageLink() {
    const base = (typeof location !== 'undefined' && location.origin) ? location.origin : 'https://www.teleplay.online';
    return base + '/my';
  }

  async function linkAuthUid(phoneKeyVal, authUid, extra) {
    const fb = ensureFirebase();
    if (!fb || !phoneKeyVal || !authUid) return;
    extra = extra || {};
    const patch = {
      authUid,
      updatedAt: Date.now(),
    };
    if (extra.phone) patch.phone = String(extra.phone).slice(0, 30);
    if (extra.name) patch.name = String(extra.name).slice(0, 80);
    if (extra.role) patch.role = String(extra.role).slice(0, 20);
    patch.authMethod = 'phone';
    await fb.database().ref('phoneIndex/' + phoneKeyVal).update(patch).catch(() => {});
  }

  /** After phone OTP — ensure phoneIndex + return phoneKey. */
  async function afterPhoneSignIn(user) {
    const pk = phoneKeyFromUser(user);
    if (!pk) throw new Error('phone_required');
    const fb = ensureFirebase();
    const idxRef = fb.database().ref('phoneIndex/' + pk);
    const idxSnap = await idxRef.once('value');
    const now = Date.now();
    if (!idxSnap.exists()) {
      await idxRef.set({
        authUid: user.uid,
        phone: String(user.phoneNumber || '').slice(0, 30),
        authMethod: 'phone',
        role: 'customer',
        registeredAt: now,
        updatedAt: now,
      });
    } else {
      await idxRef.update({
        authUid: user.uid,
        phone: String(user.phoneNumber || '').slice(0, 30),
        authMethod: 'phone',
        updatedAt: now,
      });
    }
    user.__phoneKey = pk;
    return pk;
  }

  /** Create customer profile on first visit (after OTP). */
  async function setupCustomerProfile(user, name) {
    const fb = ensureFirebase();
    if (!fb || !user) throw new Error('init');
    const pk = user.__phoneKey || phoneKeyFromUser(user);
    if (!pk) throw new Error('phone_required');
    const displayName = String(name || '').trim().slice(0, 80);
    if (!displayName) throw new Error('name_required');

    const profRef = fb.database().ref(userDataPath(pk) + '/profile');
    const profSnap = await profRef.once('value');
    const now = Date.now();

    if (!profSnap.exists()) {
      await profRef.set({
        name: displayName,
        phone: String(user.phoneNumber || '').slice(0, 30),
        phoneKey: pk,
        role: 'customer',
        createdAt: now,
        totalSessions: 0,
      });
      await fb.database().ref('phoneIndex/' + pk).update({ name: displayName, role: 'customer' });
    }

    user.__phoneKey = pk;
    return pk;
  }

  async function hasCustomerProfile(phoneKeyVal) {
    const fb = ensureFirebase();
    if (!fb || !phoneKeyVal) return false;
    const snap = await fb.database().ref(userDataPath(phoneKeyVal) + '/profile').once('value');
    return snap.exists();
  }

  /** Lookup uid by phone (admin). */
  async function lookupByPhone(phone) {
    const fb = ensureFirebase();
    const pk = phoneKey(phone);
    if (!fb || !pk) return null;
    const snap = await fb.database().ref('phoneIndex/' + pk).once('value');
    const v = snap.val();
    if (!v) return null;
    return { phoneKey: pk, ...v };
  }

  async function getProfile(phoneKeyVal) {
    const fb = ensureFirebase();
    if (!fb || !phoneKeyVal) return null;
    const snap = await fb.database().ref(userDataPath(phoneKeyVal) + '/profile').once('value');
    return snap.val();
  }

  async function listSessions(phoneKeyVal) {
    const fb = ensureFirebase();
    if (!fb || !phoneKeyVal) return [];
    const snap = await fb.database().ref(userDataPath(phoneKeyVal) + '/sessions').once('value');
    const out = [];
    snap.forEach((s) => { out.push({ id: s.key, ...s.val() }); });
    out.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    return out;
  }

  async function listCustomerOrders(phoneKeyVal) {
    const fb = ensureFirebase();
    if (!fb || !phoneKeyVal) return [];
    const snap = await fb.database().ref('customerOrders/' + phoneKeyVal).once('value');
    const out = [];
    snap.forEach((s) => { out.push({ id: s.key, ...s.val() }); });
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  /** Current phone-authenticated customer (for orders). */
  async function resolveLoggedInCustomer() {
    const fb = ensureFirebase();
    if (!fb) return null;
    const user = fb.auth().currentUser;
    if (!user || !user.phoneNumber) return null;
    const pk = phoneKeyFromUser(user);
    if (!pk) return null;
    try { await afterPhoneSignIn(user); } catch (_) {}
    const profile = await getProfile(pk);
    const name = String((profile && profile.name) || '').trim();
    return {
      uid: user.uid,
      phoneKey: pk,
      phone: String(user.phoneNumber || ''),
      name,
      hasProfile: !!name,
    };
  }

  /** Place order tied to logged-in account phone. */
  async function createOrderForAccount(pkg, extras) {
    extras = extras || {};
    const customer = await resolveLoggedInCustomer();
    if (!customer) {
      const err = new Error('login_required');
      err.code = 'login_required';
      throw err;
    }
    const buyerName = customer.name || String(extras.name || '').trim();
    if (!buyerName) {
      const err = new Error('name_required');
      err.code = 'name_required';
      throw err;
    }
    if (!global.TPCodes || !global.TPCodes.createOrder) throw new Error('init');
    return global.TPCodes.createOrder({
      packageId: pkg.id || pkg.packageId,
      packageName: pkg.name || pkg.packageName,
      packageType: (Number(pkg.codesCount) || 1) > 1 ? 'business' : 'individual',
      codesCount: Number(pkg.codesCount) || 1,
      sessionsPerCode: Number(pkg.sessionsPerCode) || 5,
      price: Number(pkg.price) || 0,
      currency: pkg.currency || 'USD',
      buyerName,
      buyerPhone: customer.phone,
      buyerEmail: String(extras.email || '').trim(),
      notes: String(extras.notes || '').trim(),
      source: extras.source || 'account',
      paymentMethod: extras.paymentMethod || 'whatsapp',
    });
  }

  /** List registered phone accounts (admin). */
  async function listAccounts(opts) {
    const fb = ensureFirebase();
    if (!fb) return [];
    const snap = await fb.database().ref('phoneIndex').once('value');
    const out = [];
    snap.forEach((s) => {
      out.push({ phoneKey: s.key, ...s.val() });
    });
    out.sort((a, b) => (Number(b.registeredAt) || Number(b.updatedAt) || 0) - (Number(a.registeredAt) || Number(a.updatedAt) || 0));
    if (opts && opts.role) out = out.filter((a) => (a.role || 'customer') === opts.role);
    return out;
  }

  async function linkOrderToCustomer(phoneKeyVal, orderId, orderMeta) {
    const fb = ensureFirebase();
    if (!fb || !phoneKeyVal || !orderId) return;
    await fb.database().ref('customerOrders/' + phoneKeyVal + '/' + orderId).set({
      status: 'pending',
      packageId: orderMeta.packageId || '',
      packageName: orderMeta.packageName || '',
      price: Number(orderMeta.price) || 0,
      currency: orderMeta.currency || 'USD',
      sessionsCount: Number(orderMeta.sessionsCount) || 5,
      createdAt: orderMeta.createdAt || Date.now(),
    });
  }

  function customerOrderPayload(order, status, extra) {
    order = order || {};
    extra = extra || {};
    return {
      status: status || order.status || 'pending',
      packageId: order.packageId || '',
      packageName: order.packageName || '',
      price: Number(order.price) || 0,
      currency: order.currency || 'USD',
      sessionsCount: Number(extra.sessionsCount || ((Number(order.codesCount) || 1) * (Number(order.sessionsPerCode) || 5))),
      createdAt: Number(order.createdAt || extra.createdAt || Date.now()),
      fulfilledAt: Number(extra.fulfilledAt || order.fulfilledAt || 0),
    };
  }

  async function ensureCustomerOrderMirror(order) {
    const fb = ensureFirebase();
    if (!fb || !order) return null;
    const pk = order.phoneKey || phoneKey(order.buyerPhone);
    const orderId = order.id || order.orderId;
    if (!pk || !orderId) return null;
    const payload = customerOrderPayload(order, order.status || 'pending', {});
    await fb.database().ref('customerOrders/' + pk + '/' + orderId).update(payload);
    return { phoneKey: pk, orderId, payload };
  }

  async function provisionFromOrder(order, adminUid) {
    const fb = ensureFirebase();
    if (!fb) throw new Error('init');
    const pk = phoneKey(order.buyerPhone);
    if (!pk) throw new Error('phone_required');
    const name = String(order.buyerName || '').trim().slice(0, 80);
    const sessionsCount = Math.max(1, Math.min(500,
      (Number(order.codesCount) || 1) * (Number(order.sessionsPerCode) || 5)
    ));

    const now = Date.now();
    const orderId = order.id || order.orderId || '';
    const sessions = [];
    const updates = {};

    const profSnap = await fb.database().ref(userDataPath(pk) + '/profile').once('value');
    const prof = profSnap.val() || {};
    const startIndex = Number(prof.totalSessions || 0);

    for (let i = 0; i < sessionsCount; i++) {
      const sessionCode = global.TPCodes
        ? global.TPCodes.randomCode('JS', 6)
        : ('JS-' + Math.random().toString(36).slice(2, 8).toUpperCase());
      const sessionId = 's' + (startIndex + i + 1) + '_' + now;
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
      const normCode = global.TPCodes.normalize ? global.TPCodes.normalize(sessionCode) : sessionCode;
      updates[userDataPath(pk) + '/sessions/' + sessionId] = card;
      updates['sessionIndex/' + normCode] = {
        phoneKey: pk, sessionId, status: 'available', createdAt: now,
      };
      updates['accessCodes/' + sessionCode] = {
        type: 'session',
        status: 'active',
        maxSessions: 1,
        usedSessions: 0,
        createdAt: now,
        expiresAt: now + 1000 * 60 * 60 * 24 * 365,
        label: 'طلب ' + orderId,
        ownerId: pk,
        sessionId,
        ownerPhoneKey: pk,
        sold: true,
        soldAt: now,
        soldBy: adminUid || '',
        soldToName: name,
        soldToPhone: String(order.buyerPhone || '').slice(0, 30),
        soldOrderId: orderId,
      };
    }

    const profileUpdate = {
      name: name || prof.name || '',
      phone: String(order.buyerPhone || '').slice(0, 30),
      phoneKey: pk,
      role: prof.role || 'customer',
      createdAt: prof.createdAt || now,
      totalSessions: startIndex + sessionsCount,
      lastOrderId: orderId,
    };
    updates[userDataPath(pk) + '/profile'] = profileUpdate;
    if (orderId) updates[userDataPath(pk) + '/orders/' + orderId] = now;

    if (orderId) {
      updates['customerOrders/' + pk + '/' + orderId] = customerOrderPayload(order, 'fulfilled', {
        sessionsCount,
        fulfilledAt: now,
      });
      updates['orders/' + orderId + '/phoneKey'] = pk;
    }

    await fb.database().ref().update(updates);
    return { phoneKey: pk, sessions, sessionsCount, myLink: myPageLink() };
  }

  async function syncSessionStatus(sessionCode, patch) {
    const fb = ensureFirebase();
    if (!fb || !sessionCode) return;
    const code = (global.TPCodes && global.TPCodes.normalize)
      ? global.TPCodes.normalize(sessionCode)
      : String(sessionCode).toUpperCase().trim();
    const idxSnap = await fb.database().ref('sessionIndex/' + code).once('value');
    const idx = idxSnap.val();
    if (!idx || !idx.phoneKey || !idx.sessionId) return;
    const safe = {};
    if (patch.status) safe.status = patch.status;
    if (patch.roomId !== undefined) safe.roomId = patch.roomId;
    if (patch.usedAt) safe.usedAt = patch.usedAt;
    if (patch.scorePct != null) safe.scorePct = patch.scorePct;
    if (patch.partnerName) safe.partnerName = patch.partnerName;
    await fb.database().ref(userDataPath(idx.phoneKey) + '/sessions/' + idx.sessionId).update(safe).catch(() => {});
    const idxPatch = {};
    if (patch.status) idxPatch.status = patch.status;
    if (patch.roomId !== undefined) idxPatch.roomId = patch.roomId;
    if (Object.keys(idxPatch).length) {
      await fb.database().ref('sessionIndex/' + code).update(idxPatch).catch(() => {});
    }
  }

  async function markSessionActive(sessionCode, roomId) {
    await syncSessionStatus(sessionCode, { status: 'active', roomId: roomId || '' });
  }

  async function returnSession(sessionCode) {
    const fb = ensureFirebase();
    if (!fb || !sessionCode) return;
    const code = (global.TPCodes && global.TPCodes.normalize)
      ? global.TPCodes.normalize(sessionCode)
      : String(sessionCode).toUpperCase().trim();
    const idxSnap = await fb.database().ref('sessionIndex/' + code).once('value');
    const idx = idxSnap.val() || {};
    const roomId = idx.roomId || '';
    await syncSessionStatus(sessionCode, { status: 'available', roomId: '' });
    await fb.database().ref('accessRooms/' + code).remove().catch(() => {});
    if (roomId && /^[A-Z0-9]{6}$/.test(roomId)) {
      await fb.database().ref('rooms/' + roomId).remove().catch(() => {});
    }
  }

  async function markSessionUsed(sessionCode, meta) {
    meta = meta || {};
    await syncSessionStatus(sessionCode, {
      status: 'used',
      usedAt: Date.now(),
      scorePct: Number(meta.scorePct || 0),
      partnerName: String(meta.partnerName || '').slice(0, 30),
      roomId: meta.roomId || '',
    });
  }

  async function syncCustomerOrderStatus(phoneKeyVal, orderId, status) {
    const fb = ensureFirebase();
    if (!fb || !phoneKeyVal || !orderId) return;
    const patch = { status: status || 'pending' };
    if (status === 'cancelled') patch.cancelledAt = Date.now();
    await fb.database().ref('customerOrders/' + phoneKeyVal + '/' + orderId).update(patch).catch(() => {});
  }

  /** Customer cancels own pending order (before activation). */
  async function cancelCustomerOrder(orderId) {
    const fb = ensureFirebase();
    if (!fb || !orderId) throw new Error('order_required');
    const customer = await resolveLoggedInCustomer();
    if (!customer) {
      const err = new Error('login_required');
      err.code = 'login_required';
      throw err;
    }
    const pk = customer.phoneKey;
    const custSnap = await fb.database().ref('customerOrders/' + pk + '/' + orderId).once('value');
    const cust = custSnap.val();
    if (!cust || (cust.status || 'pending') !== 'pending') {
      const err = new Error('cannot_cancel');
      err.code = 'cannot_cancel';
      throw err;
    }
    const now = Date.now();
    const updates = {};
    updates['customerOrders/' + pk + '/' + orderId + '/status'] = 'cancelled';
    updates['customerOrders/' + pk + '/' + orderId + '/cancelledAt'] = now;
    const orderSnap = await fb.database().ref('orders/' + orderId).once('value');
    const order = orderSnap.val() || {};
    if (order.phoneKey === pk && (order.status || 'pending') === 'pending') {
      updates['orders/' + orderId + '/status'] = 'cancelled';
      updates['orders/' + orderId + '/cancelledAt'] = now;
      updates['orders/' + orderId + '/cancelledBy'] = customer.uid;
    }
    await fb.database().ref().update(updates);
    return { orderId, phoneKey: pk };
  }

  /** Customer removes a cancelled order from their list. */
  async function deleteCustomerOrder(orderId) {
    const fb = ensureFirebase();
    if (!fb || !orderId) throw new Error('order_required');
    const customer = await resolveLoggedInCustomer();
    if (!customer) {
      const err = new Error('login_required');
      err.code = 'login_required';
      throw err;
    }
    const pk = customer.phoneKey;
    const custSnap = await fb.database().ref('customerOrders/' + pk + '/' + orderId).once('value');
    const cust = custSnap.val();
    if (!cust || cust.status !== 'cancelled') {
      const err = new Error('cannot_delete');
      err.code = 'cannot_delete';
      throw err;
    }
    await fb.database().ref('customerOrders/' + pk + '/' + orderId).remove();
    return { orderId, phoneKey: pk };
  }

  function accountDeliveryMessage(opts) {
    opts = opts || {};
    const name = opts.name || '';
    const greeting = name ? ('مرحباً ' + name + ' 👋') : 'مرحباً 👋';
    const myLink = opts.myLink || myPageLink();
    const count = Number(opts.sessionsCount) || 5;
    const lines = [
      greeting,
      '',
      '🎮 *تحدي التخاطر* — بطاقاتك جاهزة!',
      '',
      '👤 *ادخل حسابك:*',
      myLink,
      '',
      '🃏 تم تفعيل *' + count + '* بطاقات جلسة',
      '• سجّل دخول برقم واتساب + رمز SMS',
      '• اضغط «ابدأ تحدي» وادعُ صديقك',
      '',
      'استمتع! 💜',
    ];
    return lines.join('\n');
  }

  /** Admin: update name/role in phoneIndex + profile. */
  async function adminUpdateAccount(phoneKey, data) {
    data = data || {};
    const fb = ensureFirebase();
    if (!fb || !phoneKey) throw new Error('phone_required');
    const now = Date.now();
    const idxPatch = { updatedAt: now };
    if (data.name != null) idxPatch.name = String(data.name).trim().slice(0, 80);
    if (data.role) idxPatch.role = String(data.role).slice(0, 20);
    await fb.database().ref('phoneIndex/' + phoneKey).update(idxPatch);
    const profRef = fb.database().ref(userDataPath(phoneKey) + '/profile');
    const profSnap = await profRef.once('value');
    if (profSnap.exists()) {
      const profPatch = {};
      if (data.name != null) profPatch.name = String(data.name).trim().slice(0, 80);
      if (data.role) profPatch.role = String(data.role).slice(0, 20);
      if (Object.keys(profPatch).length) await profRef.update(profPatch);
    }
  }

  /** Admin: set role customer | reseller | admin. */
  async function adminSetRole(phoneKey, authUid, newRole, opts) {
    opts = opts || {};
    const fb = ensureFirebase();
    if (!fb || !phoneKey || !authUid) throw new Error('auth_required');
    const role = String(newRole || 'customer');

    if (role === 'admin') {
      await fb.database().ref('admins/' + authUid).set(true);
      await fb.database().ref('resellers/' + authUid).remove().catch(function () {});
      await adminUpdateAccount(phoneKey, { role: 'admin', name: opts.name });
      return { role: 'admin', uid: authUid };
    }

    if (role === 'reseller') {
      if (!global.TPCodes || !global.TPCodes.saveReseller) throw new Error('init');
      const snap = await fb.database().ref('resellers/' + authUid).once('value');
      const existing = snap.val() || {};
      await global.TPCodes.saveReseller(authUid, {
        phone: opts.phone || existing.phone || '',
        name: opts.name || existing.name || '',
        tier: opts.tier || existing.tier || 'bronze',
        discountPct: Math.max(0, Math.min(90, Number(opts.discountPct ?? existing.discountPct ?? 0))),
        balance: Math.max(0, Number(opts.balance ?? existing.balance ?? 0)),
        notes: opts.notes || existing.notes || '',
        active: opts.active !== false,
        createdAt: existing.createdAt || Date.now(),
        totalGenerated: existing.totalGenerated || 0,
        totalSpent: existing.totalSpent || 0,
      });
      await fb.database().ref('admins/' + authUid).remove().catch(() => {});
      await adminUpdateAccount(phoneKey, { role: 'reseller', name: opts.name });
      return { role: 'reseller', uid: authUid };
    }

    await fb.database().ref('admins/' + authUid).remove().catch(() => {});
    const rs = await fb.database().ref('resellers/' + authUid).once('value');
    if (rs.exists()) await fb.database().ref('resellers/' + authUid).update({ active: false });
    await adminUpdateAccount(phoneKey, { role: 'customer', name: opts.name });
    return { role: 'customer', uid: authUid };
  }

  /** Admin: remove account data from RTDB (Auth user remains). */
  async function adminDeleteAccount(phoneKey, authUid) {
    const fb = ensureFirebase();
    if (!fb || !phoneKey) throw new Error('phone_required');
    const updates = {};
    updates['phoneIndex/' + phoneKey] = null;
    updates['userData/' + phoneKey] = null;
    updates['customerOrders/' + phoneKey] = null;
    if (authUid) {
      updates['resellers/' + authUid] = null;
      updates['admins/' + authUid] = null;
    }
    await fb.database().ref().update(updates);
  }

  global.TPAccount = {
    phoneKey,
    phoneKeyFromUser,
    userDataPath,
    afterPhoneSignIn,
    setupCustomerProfile,
    hasCustomerProfile,
    lookupByPhone,
    listAccounts,
    adminUpdateAccount,
    adminSetRole,
    adminDeleteAccount,
    resolveLoggedInCustomer,
    createOrderForAccount,
    linkAuthUid,
    getProfile,
    listSessions,
    listCustomerOrders,
    linkOrderToCustomer,
    ensureCustomerOrderMirror,
    provisionFromOrder,
    markSessionActive,
    returnSession,
    markSessionUsed,
    syncSessionStatus,
    syncCustomerOrderStatus,
    cancelCustomerOrder,
    deleteCustomerOrder,
    sessionPlayLink,
    roomPlayLink,
    myPageLink,
    accountDeliveryMessage,
  };
})(window);
