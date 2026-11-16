// sw.js — アプリ本体を端末に保存し、電波が弱い場所や圏外でも開けるようにする
// 方針: 通信できるときは常に最新を取りに行き(ネットワーク優先)、
//       3秒待っても返ってこない・圏外のときは端末に保存した版を使う。
// ※記録データ自体は IndexedDB にあり、このファイルとは関係ない。
'use strict';

const CACHE = 'kintore-app-v1';
const NETWORK_TIMEOUT_MS = 3000;
const CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'db.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES);
    try {
      await cache.add(new Request(CHART_URL, { mode: 'no-cors' }));
    } catch (e) {
      // Chart.js が取れなくてもインストールは続ける(次に開いたときに保存される)
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.url === CHART_URL) {
    event.respondWith(cacheFirst(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
});

// バージョン固定の Chart.js は、保存済みならそれを使う
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {});

  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
  } catch (e) {
    // 圏外・遅いとき: 保存済みの版を使う(app.js?v=7 なども app.js として探す)
    const cached = (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    if (cached) return cached;
    return network; // 保存済みがなければ通信を待つ
  }
}
