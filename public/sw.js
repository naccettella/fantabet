// Service worker: serve per "installare" l'app sul telefono e per mostrare le notifiche.
// I dati restano sempre aggiornati: nessuna cache dei contenuti.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// notifiche mandate dallo script di aggiornamento (solo campi "data": titolo, testo, link)
self.addEventListener('push', e => {
  let p = {}; try { p = e.data ? e.data.json() : {}; } catch (err) {}
  const d = p.data || p;
  e.waitUntil(self.registration.showNotification(d.title || 'Fanta Bet', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate?.(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
