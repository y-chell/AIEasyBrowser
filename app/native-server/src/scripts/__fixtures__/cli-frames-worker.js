// One script for dedicated, shared and service workers of the frames fixture.
/* global self */
self.workerKind = new URL(self.location.href).searchParams.get('kind');
self.runMarker = '@@RUN_ID@@';
if (self.workerKind === 'shared') {
  self.onconnect = (event) => event.ports[0].start();
}
if (self.workerKind === 'service') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
}
