/* CardSnap service worker — app-shell 離線快取 */
const CACHE = 'cardsnap-v1';
const SHELL = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/app.js',
  './assets/icon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  // 同源:cache-first;跨源(CDN OCR 等):network-first 不快取
  const sameOrigin = new URL(request.url).origin === self.location.origin;
  if (sameOrigin) {
    e.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
        return res;
      }).catch(() => caches.match('./index.html')))
    );
  }
});
