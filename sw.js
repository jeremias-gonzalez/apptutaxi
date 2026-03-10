const CACHE_NAME = 'tutaxi-v1';
const ASSETS = [
    './',
    './index.html',
    './index.css',
    './script.js',
    './lugares.json',
    './tarifas.json',
    'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;800;900&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
        .then(cache => cache.addAll(ASSETS))
        .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                .map(key => caches.delete(key))
            );
        })
    );
});

self.addEventListener('fetch', event => {
    // Para rutas dinámicas (como la de arcgis o osrm), prefiero primero la red y luego la caché (opcional).
    // Para lo estático, intentamos caché primero.
    if (event.request.url.includes('geocode.arcgis.com') || event.request.url.includes('router.project-osrm.org')) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request).catch(() => {
                // Opcional: retornar una página offline genérica
            });
        })
    );
});
