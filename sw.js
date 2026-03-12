const CACHE_NAME = 'tutaxi-v2'; // Changed version to bust cache
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
    self.skipWaiting(); // Force the waiting service worker to become the active service worker
    event.waitUntil(
        caches.open(CACHE_NAME)
        .then(cache => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                .map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim()) // claim clients immediately
    );
});

self.addEventListener('fetch', event => {
    // Para llamadas a APIs externas críticas, solo Fetch
    if (event.request.url.includes('geocode.arcgis.com') || 
        event.request.url.includes('router.project-osrm.org') || 
        event.request.url.includes('api.mapbox.com')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Estrategia Network-First para asegurar que el usuario siempre
    // tenga la app y script más recientes. Si no hay internet,
    // cae (fallback) al caché.
    event.respondWith(
        fetch(event.request).then(response => {
            // Actualizar el caché en segundo plano
            if (response && response.status === 200 && response.type === 'basic') {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseClone);
                });
            }
            return response;
        }).catch(() => {
            // Si la red falla (offline), retorna del caché
            return caches.match(event.request);
        })
    );
});

self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
