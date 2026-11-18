/*
 * Service Worker（v2.5.0）
 * ---------------------------------------------------------------
 * 设计原则：**网络优先，缓存只做离线兜底**。
 *
 * 为什么不用「缓存优先」：本项目历史上踩过发版缓存陷阱——发版后浏览器继续用旧 JS，
 * 登录后一直转圈，只能让用户手动清缓存。所以这里：
 *   1) 任何请求先走网络，成功就顺手更新缓存（stale-while-revalidate 的反向用法）；
 *   2) 网络失败（真离线）才回退缓存；
 *   3) /api/ 一律不缓存（行情要新，且带 Cookie 的响应不该落盘）。
 * 这样发版后用户刷新即可拿到新版本，离线时至少能打开壳页面。
 */
const CACHE = 'gp-shell-v1';
// 只预缓存「壳」资源；JS/CSS 交给运行时按需缓存，避免版本号变了还留旧文件
const SHELL = ['/', '/index.html', '/login.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  // 逐个 add：/index.html 需要登录才能 200，任何一个失败都不该让整批预缓存失败
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只接管同源请求；跨域（行情接口/图表 CDN）直接放过
  if (url.origin !== self.location.origin) return;
  // 接口与后台请求不缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      // 导航请求离线时兜底到壳页面
      if (req.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      return new Response('离线且没有缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
