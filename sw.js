// Service Worker: cacht ausschließlich den App-Code, damit ordnu offline startet.
// Keine Bilder, keine Projektdaten (PFLICHTENHEFT 1). Bei jeder Code-Änderung VERSION erhöhen.

const VERSION = 'ordnu-v1-007';
const APP_FILES = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/board.js',
  './js/files.js',
  './js/history.js',
  './js/model.js',
  './js/scaling.js',
  './js/viewer.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Erst Netz (aktueller Code), bei fehlendem Netz der Cache. Nur eigene App-Dateien.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const base = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(base)) return;
  const path = url.pathname.slice(base.length);
  const known = APP_FILES.some(f => f.slice(2) === path);
  if (!known) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
