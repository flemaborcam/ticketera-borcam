// Service worker mínimo: Android exige que exista uno para poder "instalar" el sitio como app.
// A propósito NO guarda nada en caché (ni app.js, ni index.html, ni las respuestas de la API):
// ya tuvimos suficientes dolores de cabeza con deploys que tardaban en verse — cachear acá sumaría
// otra causa posible para lo mismo. Cada visita sigue pidiendo todo directo al servidor, como hoy.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => {
  // No interceptamos ninguna petición: se deja pasar tal cual al navegador.
});
