// Service worker minimo: serve per poter "installare" l'app sul telefono.
// I dati restano sempre aggiornati: nessuna cache dei contenuti.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
