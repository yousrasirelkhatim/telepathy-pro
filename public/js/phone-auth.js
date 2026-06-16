/* =========================================================================
   Telepathy – Firebase Phone Auth (shared: /my, /admin, index buy)
   Invisible reCAPTCHA on send button (proven pattern) + visible fallback div
   ========================================================================= */
(function (global) {
  'use strict';

  let recaptchaVerifier = null;
  let confirmationResult = null;
  let recaptchaRendered = false;
  let recaptchaAnchorId = '';
  let recaptchaSize = 'invisible';

  function ensureFirebase() {
    if (typeof firebase === 'undefined') return null;
    if (!firebase.apps.length && global.TPCodes && global.TPCodes.config) {
      firebase.initializeApp(global.TPCodes.config);
    } else if (!firebase.apps.length) return null;
    return firebase;
  }

  function phoneKey(phone) {
    const digits = String(phone || '').replace(/\D/g, '').slice(-15);
    return digits || '';
  }

  function toE164(phone, defaultCountry) {
    defaultCountry = String(defaultCountry || '20').replace(/\D/g, '');
    let raw = String(phone || '').trim();
    if (!raw) {
      const err = new Error('phone_required');
      err.code = 'phone_required';
      throw err;
    }
    if (raw.startsWith('+')) return '+' + raw.replace(/\D/g, '');
    let d = raw.replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('0') && defaultCountry) d = defaultCountry + d.slice(1);
    if (!d) {
      const err = new Error('phone_required');
      err.code = 'phone_required';
      throw err;
    }
    return '+' + d;
  }

  function phoneKeyFromUser(user) {
    if (!user || !user.phoneNumber) return '';
    return phoneKey(user.phoneNumber);
  }

  function isInteractiveElement(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    return tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  /** Resolve container: invisible → keep button; normal → dedicated div wrap. */
  function resolveRecaptchaHostId(anchorId, size) {
    const el = document.getElementById(anchorId);
    if (!el) return anchorId;
    if (!isInteractiveElement(el)) return anchorId;
    if (size === 'invisible') return anchorId;

    const candidates = [
      anchorId.replace(/Btn$/i, '-recaptcha-wrap'),
      anchorId.replace(/btn$/i, '-recaptcha-wrap'),
      'recaptcha-wrap',
    ];
    for (let i = 0; i < candidates.length; i++) {
      const wrap = document.getElementById(candidates[i]);
      if (wrap && !isInteractiveElement(wrap)) return candidates[i];
    }

    const parent = el.parentElement;
    if (parent) {
      const sibling = parent.querySelector('[id$="-recaptcha-wrap"], .recaptcha-host');
      if (sibling && !isInteractiveElement(sibling) && sibling.id) return sibling.id;
    }

    return anchorId;
  }

  function resetRecaptcha() {
    confirmationResult = null;
    recaptchaRendered = false;
    recaptchaAnchorId = '';
    recaptchaSize = 'invisible';
    if (recaptchaVerifier) {
      try { recaptchaVerifier.clear(); } catch (_) {}
      recaptchaVerifier = null;
    }
  }

  function emptyRecaptchaHost(hostId) {
    const el = document.getElementById(hostId);
    if (!el) return null;
    if (!isInteractiveElement(el)) el.innerHTML = '';
    el.removeAttribute('data-recaptcha-ready');
    return el;
  }

  function normalizeRecaptchaOpts(anchorId, maybeOpts) {
    const size = maybeOpts && maybeOpts.size === 'normal' ? 'normal' : 'invisible';
    const hostId = resolveRecaptchaHostId(anchorId, size);
    return { anchorId: hostId, size: size };
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function withTimeout(promise, ms, code) {
    return Promise.race([
      promise,
      wait(ms).then(function () {
        const err = new Error(code || 'recaptcha_timeout');
        err.code = code || 'recaptcha_timeout';
        throw err;
      }),
    ]);
  }

  async function prepareRecaptcha(anchorId, maybeOpts) {
    if (global.TPCodes && global.TPCodes.init) global.TPCodes.init();
    const fb = ensureFirebase();
    if (!fb || typeof fb.auth !== 'function') throw new Error('auth_not_loaded');
    if (!anchorId) throw new Error('recaptcha_required');

    const opts = normalizeRecaptchaOpts(anchorId, maybeOpts);
    if (recaptchaVerifier && recaptchaRendered && recaptchaAnchorId === opts.anchorId && recaptchaSize === opts.size) {
      return;
    }

    resetRecaptcha();
    recaptchaAnchorId = opts.anchorId;
    recaptchaSize = opts.size;

    const auth = fb.auth();
    try { auth.useDeviceLanguage(); } catch (_) {}

    const el = emptyRecaptchaHost(opts.anchorId);
    if (!el) throw new Error('recaptcha_required');

    recaptchaVerifier = new fb.auth.RecaptchaVerifier(opts.anchorId, {
      size: opts.size,
      callback: function () {
        el.setAttribute('data-recaptcha-ready', '1');
      },
      'expired-callback': function () {
        recaptchaRendered = false;
        el.removeAttribute('data-recaptcha-ready');
      },
    });

    await withTimeout(recaptchaVerifier.render(), 20000, 'recaptcha_timeout');
    recaptchaRendered = true;
    el.setAttribute('data-recaptcha-ready', '1');
  }

  async function prepareRecaptchaWithRetry(anchorId, maybeOpts, attempts) {
    const max = attempts || 2;
    let lastErr = null;
    for (let i = 0; i < max; i++) {
      try {
        await prepareRecaptcha(anchorId, maybeOpts);
        return;
      } catch (e) {
        lastErr = e;
        resetRecaptcha();
        if (i < max - 1) await wait(600);
      }
    }
    throw lastErr || new Error('recaptcha_required');
  }

  async function signInWithRecaptcha(auth, e164, anchorId, opts) {
    const settings = normalizeRecaptchaOpts(anchorId, opts);
    if (!recaptchaVerifier || !recaptchaRendered || recaptchaAnchorId !== settings.anchorId || recaptchaSize !== settings.size) {
      await prepareRecaptchaWithRetry(settings.anchorId, { size: settings.size }, 2);
    }
    if (!recaptchaVerifier) throw new Error('recaptcha_required');
    return auth.signInWithPhoneNumber(e164, recaptchaVerifier);
  }

  async function sendOtp(phone, anchorId, defaultCountry, maybeOpts) {
    const fb = ensureFirebase();
    if (!fb) throw new Error('init');
    const auth = fb.auth();
    const e164 = toE164(phone, defaultCountry);
    const opts = maybeOpts && typeof maybeOpts === 'object' ? maybeOpts : {};
    let size = opts.size === 'normal' ? 'normal' : 'invisible';

    try {
      confirmationResult = await signInWithRecaptcha(auth, e164, anchorId, { size: size });
      return { e164: e164, masked: maskPhone(e164), mode: size };
    } catch (e) {
      resetRecaptcha();
      if (size === 'invisible') {
        try {
          confirmationResult = await signInWithRecaptcha(auth, e164, anchorId, { size: 'normal' });
          return { e164: e164, masked: maskPhone(e164), mode: 'normal' };
        } catch (e2) {
          resetRecaptcha();
          throw e2;
        }
      }
      throw e;
    }
  }

  async function verifyOtp(code) {
    if (!confirmationResult) {
      const err = new Error('no_pending_otp');
      err.code = 'no_pending_otp';
      throw err;
    }
    const cred = await confirmationResult.confirm(String(code || '').trim());
    confirmationResult = null;
    return cred.user;
  }

  function maskPhone(e164) {
    const d = String(e164 || '').replace(/\D/g, '');
    if (d.length < 4) return e164;
    return '+' + d.slice(0, Math.min(4, d.length)) + '••••' + d.slice(-3);
  }

  function friendlyError(e) {
    const code = e && e.code;
    const map = {
      'auth/invalid-phone-number': 'رقم الهاتف غير صالح — استخدم +2010...',
      'auth/missing-phone-number': 'أدخل رقم الهاتف',
      'auth/too-many-requests': 'محاولات كثيرة — انتظر 15 دقيقة',
      'auth/code-expired': 'انتهت صلاحية الرمز — أعد الإرسال',
      'auth/invalid-verification-code': 'رمز التحقق غير صحيح',
      'auth/captcha-check-failed': 'فشل تحقق Google — عطّل AdBlock واستخدم Chrome',
      'auth/missing-recaptcha-token': 'أكمل مربع Google ثم أعد الإرسال',
      'auth/quota-exceeded': 'تجاوز SMS — فعّل Blaze في Firebase',
      'auth/operation-not-allowed': 'فعّل Phone في Firebase → Authentication',
      'auth/billing-not-enabled': 'SMS يحتاج خطة Blaze في Firebase',
      'auth/invalid-app-credential': 'خطأ reCAPTCHA — Ctrl+F5',
      'auth/app-not-authorized': 'أضف teleplay.online في Firebase Authorized domains',
      'auth/invalid-api-key': 'خطأ إعداد Firebase — راجع API key restrictions',
      'auth/network-request-failed': 'تحقق من الإنترنت',
      recaptcha_timeout: 'تعذّر تحميل Google — عطّل AdBlock وأعد المحاولة',
      phone_required: 'أدخل رقم الهاتف',
      no_pending_otp: 'أرسل رمز التحقق أولاً',
      recaptcha_required: 'تعذّر تحميل التحقق — أعد تحميل الصفحة',
      auth_not_loaded: 'تعذّر تحميل Firebase',
    };
    const msg = map[code] || (e && e.message) || 'تعذّر إكمال العملية';
    return code && !map[code] ? (msg + ' (' + code + ')') : msg;
  }

  global.TPPhoneAuth = {
    phoneKey: phoneKey,
    toE164: toE164,
    phoneKeyFromUser: phoneKeyFromUser,
    prepareRecaptcha: prepareRecaptcha,
    prepareRecaptchaWithRetry: prepareRecaptchaWithRetry,
    resetRecaptcha: resetRecaptcha,
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    maskPhone: maskPhone,
    friendlyError: friendlyError,
  };
})(window);
