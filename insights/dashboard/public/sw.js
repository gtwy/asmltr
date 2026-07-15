// asmltr insights — service worker.
// Deliberately minimal: it exists to make the dashboard installable and to carry push +
// notification-click handlers. It does NOT cache responses — nginx injects per-request auth
// tokens into index.html, so caching that would be a security/staleness footgun. A no-op fetch
// handler is enough to satisfy browsers' installability heuristic while leaving the network alone.
const SW_VERSION = 'asmltr-sw-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Passthrough — having a fetch handler at all is what some browsers require for install; we
// intentionally don't call respondWith(), so requests hit the network normally (tokens intact).
self.addEventListener('fetch', () => {});

// Web Push (fires only once VAPID/subscription are configured — background turn-complete alerts).
// Payload shape: { title, body, tag, url }.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(d.title || 'asmltr', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: d.url || '/' },
    })
  );
});

// Tapping a notification focuses an existing dashboard tab (navigating it) or opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) { if ('focus' in c) { try { await c.navigate(url); } catch (_) {} return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
