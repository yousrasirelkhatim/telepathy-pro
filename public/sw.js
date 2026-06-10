// Telepathy Challenge – Service Worker (2026)
const CACHE_VERSION = 'telepathy-v46';
// NOTE: Do NOT precache HTML files — they must always be network-fresh.
// Otherwise users get stuck on a broken old version after a deploy.
const STATIC_ASSETS = [
  '/manifest.json',
  '/brand/favicon-96x96.png?v=40',
  '/brand/web-app-manifest-192x192.png?v=40',
  '/brand/web-app-manifest-512x512.png?v=40',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;900&display=swap',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-database-compat.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Never cache Firebase Realtime Database / Auth (real-time data)
  if (req.url.includes('firebaseio.com') || req.url.includes('googleapis.com/identitytoolkit')) {
    return;
  }

  // Network-first for HTML navigations (so users always get latest UI)
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => res) // do NOT cache HTML — always network-fresh
        .catch(() => caches.match(req).then((c) => c || new Response(
          '<!doctype html><meta charset="utf-8"><title>أوفلاين</title>'+
          '<body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a14;color:#fff">'+
          '<h1>📡 لا يوجد اتصال</h1><p>تحقق من الإنترنت وأعد المحاولة</p>'+
          '<button onclick="location.reload()" style="padding:12px 24px;border:0;border-radius:12px;background:#a855f7;color:#fff;font-weight:700">↻ إعادة</button>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )))
    );
    return;
  }

  // Cache-first for static assets (JS/CSS/images/fonts) — versioned via ?v=
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// Allow page to trigger immediate update
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
