/* CardSnap service worker — app-shell 離線快取 */
/* 版本號:CI 部署時把 __BUILD_ID__ 戳記為 commit SHA(見 scripts/stamp-version.sh);
   未戳記時(本機開發)自動用 'dev'。原始碼保持乾淨。 */
const BUILD_ID = '__BUILD_ID__';
const CACHE = 'cardsnap-' + (BUILD_ID.indexOf('__') === 0 ? 'dev' : BUILD_ID);
const SHELL = [
  './',
  './index.html',
  './app.html',
  './assets/styles.css',
  './assets/core.js',
  './assets/store.js',
  './assets/supabase-sync.js',
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
  const sameOrigin = new URL(request.url).origin === self.location.origin;
  if (!sameOrigin) return;  // 跨源(CDN / OCR)交給瀏覽器,不快取
  // 網路優先:永遠先抓最新,成功就更新快取;離線才用快取
  e.respondWith(
    fetch(request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(request, copy));
      return res;
    }).catch(() => caches.match(request).then(hit => hit || caches.match('./app.html')))
  );
});
