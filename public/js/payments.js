/* Telepathy — Paymob (Egypt) + Stripe payments client */
(function (global) {
  'use strict';

  let paymobEnabled = false;  let stripeEnabled = false;

  async function loadPaymentSettings() {
    if (!global.TPCodes || !TPCodes.getSettings) {
      return { paymobEnabled: false, stripeEnabled: false, cardEnabled: false };
    }
    try {
      const s = await TPCodes.getSettings();
      paymobEnabled = s.paymobEnabled === true || s.paymobEnabled === 'true';
      stripeEnabled = s.stripeEnabled === true || s.stripeEnabled === 'true';
      return {
        paymobEnabled,
        stripeEnabled,
        cardEnabled: paymobEnabled || stripeEnabled,
        currency: s.currency || 'EGP',
        paymobPublicKey: s.paymobPublicKey || '',
      };
    } catch (_) {
      return { paymobEnabled: false, stripeEnabled: false, cardEnabled: false };
    }
  }

  function activeCardProvider(settings) {
    settings = settings || {};
    if (settings.paymobEnabled) return 'paymob';
    if (settings.stripeEnabled) return 'stripe';
    return '';
  }

  function configurePayMethods(opts) {
    opts = opts || {};
    const paySettings = {
      paymobEnabled: opts.paymobEnabled !== undefined ? opts.paymobEnabled : paymobEnabled,
      stripeEnabled: opts.stripeEnabled !== undefined ? opts.stripeEnabled : stripeEnabled,
    };
    const isIndividual = (Number(opts.codesCount) || 1) === 1;
    const provider = activeCardProvider(paySettings);
    const enabled = !!provider;
    const stripeBtn = document.getElementById(opts.stripeBtnId || 'payStripeBtn');
    const stripeHint = document.getElementById(opts.stripeHintId || 'payStripeHint');
    const divider = document.getElementById(opts.dividerId) ||
      document.querySelector((opts.dividerSelector || '#payMethods .pay-divider'));
    const waBtn = document.getElementById(opts.waBtnId || 'payWhatsAppBtn');
    if (waBtn) waBtn.style.display = '';
    if (stripeBtn) {
      stripeBtn.style.display = isIndividual ? '' : 'none';
      stripeBtn.disabled = !enabled;
      if (provider === 'paymob') {
        stripeBtn.textContent = enabled
          ? '💳 الدفع الإلكتروني — فيزا / محفظة (Paymob)'
          : '💳 الدفع الإلكتروني (قريباً)';
      } else {
        stripeBtn.textContent = enabled
          ? '💳 الدفع بالفيزا — تفعيل فوري'
          : '💳 الدفع بالفيزا (قريباً)';
      }
    }
    if (stripeHint) {
      stripeHint.style.display = isIndividual ? 'block' : 'none';
      if (enabled) {
        stripeHint.textContent = provider === 'paymob'
          ? '✨ بعد الدفع — البطاقات تُفعَّل تلقائياً (بطاقة · محفظة · InstaPay)'
          : '✨ بعد الدفع بالبطاقة — البطاقات تُفعَّل تلقائياً في حسابك';
      } else {
        stripeHint.textContent = '📱 حالياً: أكمل الطلب عبر واتساب — الدفع الإلكتروني يُفعَّل بعد موافقة Paymob';
      }
    }
    if (divider) divider.style.display = isIndividual ? 'flex' : 'none';
    return { isIndividual, cardEnabled: enabled, provider };
  }

  function buildWhatsAppOrderText(order, lang) {
    if (global.TPCodes && TPCodes.buildOrderWhatsAppMessage) {
      return TPCodes.buildOrderWhatsAppMessage(order, lang);
    }
    return 'طلب ' + (order && order.id) + ' — ' + (order && order.packageName);
  }

  async function startPaymobCheckout(orderId) {
    if (typeof firebase === 'undefined' || typeof firebase.functions !== 'function') {
      const err = new Error('functions_not_loaded');
      err.code = 'functions_not_loaded';
      throw err;
    }
    const functions = firebase.app().functions('us-central1');
    const fn = functions.httpsCallable('createPaymobCheckout');
    const res = await fn({ orderId: String(orderId || '') });
    const url = res && res.data && res.data.url;
    if (!url) {
      const err = new Error('checkout_failed');
      err.code = 'checkout_failed';
      throw err;
    }
    window.location.assign(url);
    return url;
  }

  async function startStripeCheckout(orderId) {
    if (typeof firebase === 'undefined' || typeof firebase.functions !== 'function') {
      const err = new Error('functions_not_loaded');
      err.code = 'functions_not_loaded';
      throw err;
    }
    const fn = firebase.app().functions('us-central1').httpsCallable('createStripeCheckout');
    const res = await fn({ orderId: String(orderId || '') });
    const url = res && res.data && res.data.url;
    if (!url) {
      const err = new Error('checkout_failed');
      err.code = 'checkout_failed';
      throw err;
    }
    window.location.href = url;
  }

  async function startCardCheckout(orderId, settings) {
    settings = settings || await loadPaymentSettings();
    const provider = activeCardProvider(settings);
    if (provider === 'paymob') return startPaymobCheckout(orderId);
    if (provider === 'stripe') return startStripeCheckout(orderId);
    const err = new Error('card_disabled');
    err.code = 'card_disabled';
    throw err;
  }

  function friendlyError(e) {
    const code = e && (e.code || e.message);
    const rawMsg = (e && e.message) || '';
    const map = {
      'functions/not-found': 'خدمة الدفع غير منشورة — تواصل مع الدعم',
      'functions/unauthenticated': 'سجّل دخولك أولاً',
      'functions/permission-denied': 'الطلب لا يخص حسابك',
      'functions/failed-precondition': rawMsg || 'الدفع الإلكتروني غير متاح حالياً',
      'functions/internal': rawMsg && rawMsg.toLowerCase() !== 'internal'
        ? rawMsg
        : 'تعذّر بدء الدفع — حاول مجدداً أو تواصل مع الدعم',      functions_not_loaded: 'جاري تحميل نظام الدفع — أعد المحاولة',
      checkout_failed: 'تعذّر فتح صفحة الدفع',
      card_disabled: 'الدفع الإلكتروني غير مفعّل — استخدم واتساب',
    };
    if (map[code]) return map[code];
    if (rawMsg && rawMsg.toLowerCase() !== 'internal') return rawMsg;
    return 'تعذّر بدء الدفع';
  }

  function orderErrorMessage(e, lang) {
    if (e && e.message === 'rate_limited') {
      return (lang === 'en' ? 'Too many orders — wait ' : 'طلبات كثيرة — انتظر ')
        + (e.waitSec || 60) + (lang === 'en' ? 's' : ' ث');
    }
    if (e && (e.code === 'login_required' || e.message === 'login_required')) {
      return lang === 'en' ? 'Sign in first' : 'سجّل دخولك أولاً';
    }
    if (e && e.code === 'name_required') {
      return lang === 'en' ? 'Complete your profile name' : 'أكمل اسمك في الملف الشخصي أولاً';
    }
    return lang === 'en' ? 'Could not place order — try again' : 'تعذّر تسجيل الطلب — حاول مجدداً';
  }

  global.TPPayments = {
    loadPaymentSettings,
    activeCardProvider,
    configurePayMethods,
    buildWhatsAppOrderText,
    startPaymobCheckout,
    startStripeCheckout,
    startCardCheckout,
    friendlyError,
    orderErrorMessage,
  };
})(window);