// Lágmarks service worker: gerir síðuna uppsetjanlega sem app. Engin skyndiminni, gögnin eru alltaf ný.
// (Hér bætist við 'push' hlustandi ef við förum yfir í vef-tilkynningar.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
