// Service worker : permet d'installer l'appli et de l'ouvrir sans réseau.
// Stratégie "réseau d'abord", sans aucun cache HTTP : on prend toujours la
// dernière version ; la copie locale ne sert que si le serveur est injoignable.
// Sur le PC (localhost), il ne fait rien : le serveur local est toujours là.
const CACHE = 'paddock-v2';
const LOCAL = ['localhost', '127.0.0.1'].includes(self.location.hostname);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE || LOCAL) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  if (LOCAL) return; // en local : aucun cache, toujours les fichiers du disque
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
