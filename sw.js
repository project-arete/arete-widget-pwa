// sw.js — Arete Widget PWA service worker (deterministic updates).
const VERSION = 'arete-widget-pwa-v5';
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./widget.css",
  "./faceplate.css",
  "./wpwa.css",
  "./browser-widget-bridge.js",
  "./app.js",
  "./faceplate.html",
  "./faceplate.js",
  "./faceplate-bridge.js",
  "./core/widget-spec.js",
  "./core/behavior-engine.js",
  "./js-yaml.mjs",
  "./logo.png",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest",
  "./compose.css",
  "./compose.js",
  "./compose-bridge.js",
  "./compose-fp-bridge.js",
  "./widgets/manifest.json",
  "./widgets/bulb.yaml",
  "./widgets/lease-bulb.yaml",
  "./widgets/lease-landlord.yaml",
  "./widgets/lease-tenant.yaml",
  "./widgets/oadr-controller.yaml",
  "./widgets/oadr-device.yaml",
  "./widgets/occupancy-display.yaml",
  "./widgets/occupancy-sensor.yaml",
  "./widgets/ping-responder.yaml",
  "./widgets/ping-sender.yaml",
  "./widgets/propagate-receiver.yaml",
  "./widgets/propagate-sender.yaml",
  "./widgets/switch.yaml",
  "./widgets/trust-consumer.yaml",
  "./widgets/trust-provider.yaml",
  "./widgets/value-display.yaml",
  "./widgets/value-source.yaml"
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request, { cache: 'no-cache' })
        .then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone())); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
