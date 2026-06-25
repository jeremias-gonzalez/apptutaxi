const CACHE_NAME = 'tutaxi-v1';

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {

    const url = new URL(event.request.url);

    // IGNORAR EXTENSIONES
    if (
        url.protocol !== 'http:' &&
        url.protocol !== 'https:'
    ) {
        return;
    }

    // APIs externas SIN CACHE
    if (
        url.href.includes('geocode.arcgis.com') ||
        url.href.includes('router.project-osrm.org') ||
        url.href.includes('api.mapbox.com')
    ) {

        event.respondWith(fetch(event.request));

        return;
    }

    // NETWORK FIRST
    event.respondWith(

        fetch(event.request)

            .then(async response => {

                // SOLO CACHEAR RESPUESTAS VÁLIDAS
                if (
                    response &&
                    response.status === 200 &&
                    (
                        response.type === 'basic' ||
                        response.type === 'cors'
                    )
                ) {

                    const cache = await caches.open(CACHE_NAME);

                    try {

                        await cache.put(
                            event.request,
                            response.clone()
                        );

                    } catch (err) {

                        console.warn('No se pudo cachear:', err);
                    }
                }

                return response;
            })

            .catch(async () => {

                const cached =
                    await caches.match(event.request);

                return cached || Response.error();
            })
    );
});