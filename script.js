const RIO_CUARTO_LAT = -33.1232;
const RIO_CUARTO_LON = -64.3493;
const SC_LAT = -33.205;
const SC_LON = -64.440;
const RIO_BBOX = "-64.55,-33.25,-64.20,-33.05";
const MAPBOX_TOKEN = ENV.MAPBOX_TOKEN;

let LUGARES_VIP = [];
let TARIFAS_TAXI = { dia: { bajada: 1945, ficha: 950 }, noche: { bajada: 2110, ficha: 1050 } }; // Valores por defecto

mapboxgl.accessToken = MAPBOX_TOKEN;
var map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [RIO_CUARTO_LON, RIO_CUARTO_LAT],
    zoom: 14,
    pitchWithRotate: false,
    dragRotate: false // Bloqueamos la rotación 3D para máximo rendimiento 2D
});

// Definir variables globales para marcadores y ruta
let markerA, markerB, gpsMarker;
let routeControl;
let coordOrigen = null;
let coordDestino = null;
let activeInputId = '';
let polylineRuta = false;
let distanciaCalculada = 0;

async function cargarLugaresVIP() {
    try {
        const response = await fetch('lugares.json');
        if (!response.ok) throw new Error("No se pudo cargar el JSON");
        LUGARES_VIP = await response.json();
    } catch (error) {
        console.error("Error JSON:", error);
        LUGARES_VIP = [];
    }
}

async function cargarTarifas() {
    try {
        const response = await fetch('tarifas.json');
        if (!response.ok) throw new Error("No se pudo cargar el JSON de tarifas");
        TARIFAS_TAXI = await response.json();
        console.log("Tarifas cargadas:", TARIFAS_TAXI);
    } catch (error) {
        console.warn("No se pudieron cargar las tarifas de tarifas.json, usando valores por defecto.", error);
    }
}

// --- TOAST SYSTEM ---
function showToast(mensaje, tipo = 'normal') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    let icon = tipo === 'error' ? 'exclamation-triangle' : (tipo === 'success' ? 'check-circle' : 'info-circle');
    let color = tipo === 'error' ? '#ff4444' : 'var(--color-principal)';
    toast.innerHTML = `<i class="fas fa-${icon}" style="color: ${color}"></i><span>${mensaje}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hiding');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}



// Removed duplicate let declarations

async function calcularRutaDirecta(origen, destino) {
    // Usamos 'driving-traffic' en lugar de driving normal para obtener la ruta más rápida considerando el tráfico en vivo.
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${origen.lng},${origen.lat};${destino.lng},${destino.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
            throw new Error("No route found");
        }

        const ruta = data.routes[0];

        // --- DRAW NEW ROUTE IN MAPBOX GL JS ---
        const coordenadasGeoJSON = ruta.geometry.coordinates; // Mapbox expects [lng, lat]

        const emptyData = {
            'type': 'Feature',
            'properties': {},
            'geometry': {
                'type': 'LineString',
                'coordinates': []
            }
        };

        if (map.getSource('route')) {
            map.getSource('route').setData(emptyData);
        } else {
            map.addSource('route', {
                'type': 'geojson',
                'data': emptyData
            });
            // Casing (borde exterior oscuro)
            map.addLayer({
                'id': 'route-casing',
                'type': 'line',
                'source': 'route',
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                'paint': {
                    'line-color': '#111111',
                    'line-width': 10,
                    'line-opacity': 0.8
                }
            });
            // Línea principal (dorada)
            map.addLayer({
                'id': 'route',
                'type': 'line',
                'source': 'route',
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                'paint': {
                    'line-color': '#FFD700',
                    'line-width': 5,
                    'line-opacity': 1
                }
            });
            polylineRuta = true; // Flag to know route exists
        }

        // Animación progresiva de la ruta
        let coordIndex = 0;
        let animatedCoords = [];

        function animateRoute() {
            if (coordIndex < coordenadasGeoJSON.length) {
                // Dibujar varios segmentos por frame para mayor velocidad
                let speed = Math.max(1, Math.floor(coordenadasGeoJSON.length / 40));
                for (let j = 0; j < speed && coordIndex < coordenadasGeoJSON.length; j++) {
                    animatedCoords.push(coordenadasGeoJSON[coordIndex]);
                    coordIndex++;
                }

                map.getSource('route').setData({
                    'type': 'Feature',
                    'properties': {},
                    'geometry': {
                        'type': 'LineString',
                        'coordinates': animatedCoords
                    }
                });
                requestAnimationFrame(animateRoute);
            }
        }

        // Iniciar animación
        animateRoute();

        // Add/Update Markers
        if (markerA) markerA.remove();
        if (markerB) markerB.remove();

        const elStart = document.createElement('div');
        elStart.className = 'uber-origen-container';
        elStart.innerHTML = '<div class="uber-origen-pulse"></div><div class="uber-origen"></div>';

        const elEnd = document.createElement('div');
        elEnd.className = 'uber-destino-container';
        elEnd.innerHTML = '<div class="uber-destino"></div>';

        const rawOrigen = document.getElementById('input-origen').value;
        const nombreOrigen = (rawOrigen && rawOrigen !== "Ubicación detectada" && rawOrigen !== "Mi Ubicación Actual") ? rawOrigen : 'Punto de partida';
        const labelA = nombreOrigen.length > 28 ? nombreOrigen.substring(0, 25) + '...' : nombreOrigen;

        const rawDestino = document.getElementById('input-destino').value || 'Destino';
        const labelB = rawDestino.length > 28 ? rawDestino.substring(0, 25) + '...' : rawDestino;

        const popupOrigen = new mapboxgl.Popup({ offset: 25, closeButton: false, closeOnClick: false, className: 'custom-map-popup' })
            .setHTML(`<button onclick="editarInput('origen')" class="btn-map-modifier">${labelA} <i class="fas fa-arrow-right" style="margin-left:5px;"></i></button>`);

        const popupDestino = new mapboxgl.Popup({ offset: [0, -25], closeButton: false, closeOnClick: false, className: 'custom-map-popup' })
            .setHTML(`<button onclick="editarInput('destino')" class="btn-map-modifier">${labelB} <i class="fas fa-arrow-right" style="margin-left:5px;"></i></button>`);

        markerA = new mapboxgl.Marker(elStart)
            .setLngLat([origen.lng, origen.lat])
            .setPopup(popupOrigen)
            .addTo(map);

        markerB = new mapboxgl.Marker({ element: elEnd, offset: [0, -15] })
            .setLngLat([destino.lng, destino.lat])
            .setPopup(popupDestino)
            .addTo(map);

        // Open popups by default
        markerA.togglePopup();
        markerB.togglePopup();

        // Adjust map bounds
        const bounds = new mapboxgl.LngLatBounds(
            coordenadasGeoJSON[0],
            coordenadasGeoJSON[0]
        );
        for (const coord of coordenadasGeoJSON) {
            bounds.extend(coord);
        }

        map.fitBounds(bounds, {
            padding: { top: 50, bottom: 400, left: 50, right: 50 }
        });

        // Use summary distance
        let kmReales = ruta.distance / 1000;
        distanciaCalculada = kmReales; // Exact distance
        calcularPrecio();

        document.getElementById('loader').style.display = 'none';
        document.getElementById('panel-inputs').classList.add('hidden');
        document.getElementById('panel-resultados').classList.remove('minimized'); // Asegurarnos que no arranque minimizado
        document.getElementById('panel-resultados').classList.add('visible');
        
        // --- Populate and show Floating Trip Card ---
        document.getElementById('origen-text').innerText = inputOrigen || "Ubicación Actual";
        document.getElementById('destino-text').innerText = inputDestino;
        document.getElementById('floating-trip-card').classList.add('visible');

        // Hide GPS marker permanently while viewing the route directly
        if (gpsMarker) { gpsMarker.remove(); }

    } catch (error) {
        console.error("Error calculando ruta:", error);
        document.getElementById('loader').style.display = 'none';
        showToast("No se pudo calcular la ruta. Intenta de nuevo.", "error");
    }
}

function intercambiarUbicaciones() {
    const inputOrigen = document.getElementById('input-origen');
    const inputDestino = document.getElementById('input-destino');
    const textoTemp = inputOrigen.value;
    inputOrigen.value = inputDestino.value;
    inputDestino.value = textoTemp;
    const coordTemp = coordOrigen;
    coordOrigen = coordDestino;
    coordDestino = coordTemp;
    inputOrigen.style.borderColor = "var(--color-principal)";
    inputDestino.style.borderColor = "var(--color-principal)";
    setTimeout(() => {
        inputOrigen.style.borderColor = "#444";
        inputDestino.style.borderColor = "#444";
    }, 300);
}

function procesarCalculo() {
    if (!coordOrigen || !coordDestino) {
        showToast("Debes seleccionar ambas direcciones", "error");
        document.getElementById('input-origen').style.borderColor = "#ff4444";
        document.getElementById('input-destino').style.borderColor = "#ff4444";
        setTimeout(() => {
            document.getElementById('input-origen').style.borderColor = "var(--color-borde)";
            document.getElementById('input-destino').style.borderColor = "var(--color-borde)";
        }, 500);
        return;
    }
    showToast("Calculando la mejor ruta...", "success");
    document.getElementById('loader').style.display = 'flex';
    calcularRutaDirecta(coordOrigen, coordDestino);
}

// --- BUSCADOR HÍBRIDO OPTIMIZADO CON MAPBOX GEOCODING ---
async function buscarSugerenciasHibridas(query) {
    const lista = document.getElementById('lista-compartida');
    lista.innerHTML = '';
    const nombresVistos = new Set();
    const coordenadasVistas = new Set();

    const queryLower = query.toLowerCase().trim();
    let busquedaParaApi = query;
    const tieneNumero = /\d/.test(query);

    if (!tieneNumero) {
        if (queryLower.includes("peron oeste") || queryLower.includes("perón oeste")) {
            busquedaParaApi = busquedaParaApi.replace(/peron oeste|perón oeste/i, "Avenida Presidente Perón Oeste");
        }
        else if (queryLower.includes("peron este") || queryLower.includes("perón este")) {
            busquedaParaApi = busquedaParaApi.replace(/peron este|perón este/i, "Avenida Presidente Perón Este");
        }
    }

    // Multi-word fuzzy search for local POIs
    const queryWords = queryLower.split(' ').filter(word => word.length > 0);
    const resultadosLocales = LUGARES_VIP.filter(lugar => {
        const nombreYAliasCombinados = lugar.nombre.toLowerCase() + " " + (lugar.alias ? lugar.alias.join(" ") : "");
        // Check if ALL typed words exist somewhere in the name or aliases
        return queryWords.every(word => nombreYAliasCombinados.includes(word));
    });

    resultadosLocales.forEach(lugar => {
        nombresVistos.add(lugar.nombre.toLowerCase());
        const keyCoord = lugar.lat.toFixed(3) + "," + lugar.lon.toFixed(3);
        coordenadasVistas.add(keyCoord);
        const li = document.createElement('li');
        // Seamless UI: Use the exact same icon and styling as Mapbox results
        li.innerHTML = `<div class="result-icon"><i class="fas fa-map-marker-alt"></i></div><div class="result-text"><span class="result-title">${lugar.nombre}</span><span class="result-sub">${lugar.direccion}</span></div>`;
        li.onclick = () => { usarCoordenadaDirecta(lugar.nombre, lugar.lat, lugar.lon); };
        lista.appendChild(li);
    });

    const urlMapbox = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(busquedaParaApi)}.json?bbox=${RIO_BBOX}&proximity=${RIO_CUARTO_LON},${RIO_CUARTO_LAT}&types=address,poi,neighborhood&language=es&autocomplete=true&fuzzyMatch=true&access_token=${MAPBOX_TOKEN}`;

    try {
        const response = await fetch(urlMapbox);
        const data = await response.json();

        if (data.features && data.features.length > 0) {
            data.features.forEach(feature => {
                // El nombre principal (ej. Centro, San Martin 123)
                let titulo = feature.text;
                if (feature.address) titulo += ' ' + feature.address;

                // Contexto (ej. Río Cuarto, Córdoba)
                let ciudad = "Río Cuarto";
                if (feature.context) {
                    const ctxPlace = feature.context.find(c => c.id.startsWith('place'));
                    if (ctxPlace) ciudad = ctxPlace.text;
                }

                const subtitulo = ciudad;

                // Mapbox devuelve [lon, lat]
                const lng = feature.geometry.coordinates[0];
                const lat = feature.geometry.coordinates[1];

                const keyCoord = lat.toFixed(4) + "," + lng.toFixed(4);
                const huellaDigital = titulo.toLowerCase().replace(/[^a-z0-9]/g, "");

                if (coordenadasVistas.has(keyCoord) || nombresVistos.has(huellaDigital)) return;

                coordenadasVistas.add(keyCoord);
                nombresVistos.add(huellaDigital);

                const li = document.createElement('li');
                let iconoClass = feature.place_type.includes('poi') ? 'fa-store' : 'fa-map-marker-alt';

                li.innerHTML = `<div class="result-icon"><i class="fas ${iconoClass}"></i></div><div class="result-text"><span class="result-title">${titulo}</span><span class="result-sub">${subtitulo}</span></div>`;
                li.onclick = () => { usarCoordenadaDirecta(`${titulo}, ${subtitulo}`, lat, lng); };
                lista.appendChild(li);
            });
            if (lista.children.length > 0) lista.style.display = 'block';
        }
    } catch (e) { console.error("Error Mapbox Geocoding:", e); }
}

function inicializarInputs() {
    const inputOrigen = document.getElementById('input-origen');
    const inputDestino = document.getElementById('input-destino');
    const listaCompartida = document.getElementById('lista-compartida');
    inputOrigen.addEventListener('focus', () => { activeInputId = 'input-origen'; listaCompartida.style.display = 'none'; });
    inputDestino.addEventListener('focus', () => { activeInputId = 'input-destino'; listaCompartida.style.display = 'none'; });
    configurarInput(inputOrigen);
    configurarInput(inputDestino);
}

function configurarInput(inputElement) {
    let timeout = null;
    inputElement.addEventListener('input', function () {
        const query = this.value;
        const lista = document.getElementById('lista-compartida');

        // Mover la lista dinámicamente debajo del input que se está usando
        this.parentNode.appendChild(lista);

        if (query.length < 2) { lista.style.display = 'none'; return; }
        clearTimeout(timeout);
        mostrarSkeleton(lista);
        timeout = setTimeout(() => { buscarSugerenciasHibridas(query); }, 300);
    });
}

function mostrarSkeleton(lista) {
    lista.style.display = 'block';
    lista.innerHTML = '';
    for (let i = 0; i < 3; i++) {
        const li = document.createElement('li');
        li.style.pointerEvents = 'none';
        li.innerHTML = `<div class="skeleton-icon"></div><div class="skeleton-text-group"><div class="skeleton-line-long"></div><div class="skeleton-line-short"></div></div>`;
        lista.appendChild(li);
    }
}

function usarCoordenadaDirecta(nombre, lat, lon) {
    const inputActivo = document.getElementById(activeInputId);
    inputActivo.value = nombre;
    document.getElementById('lista-compartida').style.display = 'none';
    const latlng = { lat: lat, lng: lon }; // Mapbox GL JS friendly
    if (activeInputId === 'input-origen') { coordOrigen = latlng; } else { coordDestino = latlng; const datosAGuardar = { direccion: nombre, lat: lat, lng: lon }; localStorage.setItem('ultimoDestinoTaxi', JSON.stringify(datosAGuardar)); cargarHistorial(); }
}

// Ya no usamos resolverUbicacion porque la API de Mapbox nos da las lat/lng directamente en la primera petición. (Se borra la función)

function obtenerUbicacionActual() {
    const inputOrigen = document.getElementById('input-origen');
    if ("geolocation" in navigator) {
        inputOrigen.classList.add('input-loading');
        const opcionesGPS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
        const onExito = async function (position) {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            coordOrigen = { lat: lat, lng: lon }; // Mapbox GL JS friendly
            map.flyTo({ center: [lon, lat], zoom: 16, essential: true });

            const elStart = document.createElement('div');
            elStart.className = 'uber-origen-container';
            elStart.innerHTML = '<div class="uber-origen-pulse"></div><div class="uber-origen"></div>';

            if (gpsMarker) gpsMarker.remove();
            gpsMarker = new mapboxgl.Marker(elStart).setLngLat([lon, lat]).addTo(map);
            try {
                // Modificado para usar Mapbox Geocoding inverso
                const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=address,poi&language=es&access_token=${MAPBOX_TOKEN}`;
                const resp = await fetch(url);
                const data = await resp.json();
                if (data.features && data.features.length > 0) {
                    let feature = data.features[0];
                    let direccion = feature.text;
                    if (feature.address) direccion += ' ' + feature.address;

                    let ciudad = "Río Cuarto";
                    if (feature.context) {
                        const ctxPlace = feature.context.find(c => c.id.startsWith('place'));
                        if (ctxPlace) ciudad = ctxPlace.text;
                    }

                    const distSC = calcularDistanciaKm(SC_LAT, SC_LON, lat, lon);
                    if (distSC < 5 && (ciudad === "Las Vertientes" || ciudad === "Holmberg")) ciudad = "Santa Catalina";
                    if (ciudad) direccion += `, ${ciudad}`;
                    inputOrigen.value = direccion;
                } else { inputOrigen.value = "Ubicación detectada"; }
            } catch (e) { inputOrigen.value = "Mi Ubicación Actual"; }
            finally { inputOrigen.classList.remove('input-loading'); }
        };
        navigator.geolocation.getCurrentPosition(onExito, function (error) {
            navigator.geolocation.getCurrentPosition(onExito, (err) => {
                inputOrigen.classList.remove('input-loading');
                inputOrigen.placeholder = "Escribe tu dirección...";
            }, { enableHighAccuracy: false, timeout: 15000 });
        }, opcionesGPS);
    }
}

function calcularDistanciaKm(lat1, lon1, lat2, lon2) { const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180; const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2); const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); return R * c; }
function cargarHistorial() { const guardado = localStorage.getItem('ultimoDestinoTaxi'); if (guardado) { const datos = JSON.parse(guardado); const container = document.getElementById('historial-container'); const link = document.getElementById('historial-valor'); let nombreCorto = datos.direccion.length > 30 ? datos.direccion.substring(0, 28) + '...' : datos.direccion; link.innerText = nombreCorto; container.style.display = 'block'; link.onclick = function () { document.getElementById('input-destino').value = datos.direccion; coordDestino = { lat: datos.lat, lng: datos.lng }; } } }
function calcularPrecio() { const ahora = new Date(); const hora = ahora.getHours(); let esNoche = (hora >= 21 || hora < 7); let tarifaActual = esNoche ? TARIFAS_TAXI.noche : TARIFAS_TAXI.dia; let bajada = tarifaActual.bajada; let ficha = tarifaActual.ficha; let textoTarifa = esNoche ? "🌜 Noche" : "🌞 Día"; document.getElementById('badge-tarifa').innerText = textoTarifa; let km = distanciaCalculada; let calculoBruto = bajada + (km * ficha); let resultadoFinal = calculoBruto - (calculoBruto * 0.10); document.getElementById('precio-original').innerText = calculoBruto.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' }); document.getElementById('precio-final').innerText = resultadoFinal.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' }); document.getElementById('distancia-final').innerText = km.toFixed(2) + ' km'; }
// --- BUSCADOR HÍBRIDO OPTIMIZADO CON MAPBOX GEOCODING ---
async function buscarSugerenciasHibridas(query) {
    const lista = document.getElementById('lista-compartida');
    lista.innerHTML = '';
    const nombresVistos = new Set();
    const coordenadasVistas = new Set();

    const queryLower = query.toLowerCase().trim();
    let busquedaParaApi = query;
    const tieneNumero = /\d/.test(query);

    if (!tieneNumero) {
        if (queryLower.includes("peron oeste") || queryLower.includes("perón oeste")) {
            busquedaParaApi = busquedaParaApi.replace(/peron oeste|perón oeste/i, "Avenida Presidente Perón Oeste");
        }
        else if (queryLower.includes("peron este") || queryLower.includes("perón este")) {
            busquedaParaApi = busquedaParaApi.replace(/peron este|perón este/i, "Avenida Presidente Perón Este");
        }
    }

    const resultadosLocales = LUGARES_VIP.filter(lugar =>
        lugar.nombre.toLowerCase().includes(queryLower) ||
        lugar.alias.some(alias => alias.includes(queryLower))
    );

    resultadosLocales.forEach(lugar => {
        nombresVistos.add(lugar.nombre.toLowerCase());
        const keyCoord = lugar.lat.toFixed(3) + "," + lugar.lon.toFixed(3);
        coordenadasVistas.add(keyCoord);
        const li = document.createElement('li');
        li.style.background = "rgba(40,40,40,0.8)";
        li.innerHTML = `<div class="result-icon" style="color: gold;"><i class="fas fa-star"></i></div><div class="result-text"><span class="result-title">${lugar.nombre}</span><span class="result-sub">${lugar.direccion}</span></div>`;
        li.onclick = () => { usarCoordenadaDirecta(lugar.nombre, lugar.lat, lugar.lon); };
        lista.appendChild(li);
    });

    const urlMapbox = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(busquedaParaApi)}.json?bbox=${RIO_BBOX}&proximity=${RIO_CUARTO_LON},${RIO_CUARTO_LAT}&types=address,poi,neighborhood&language=es&access_token=${MAPBOX_TOKEN}`;

    try {
        const response = await fetch(urlMapbox);
        const data = await response.json();

        if (data.features && data.features.length > 0) {
            data.features.forEach(feature => {
                let titulo = feature.text;
                if (feature.address) titulo += ' ' + feature.address;

                let ciudad = "Río Cuarto";
                if (feature.context) {
                    const ctxPlace = feature.context.find(c => c.id.startsWith('place'));
                    if (ctxPlace) ciudad = ctxPlace.text;
                }

                const subtitulo = ciudad;
                const lng = feature.geometry.coordinates[0];
                const lat = feature.geometry.coordinates[1];

                const keyCoord = lat.toFixed(4) + "," + lng.toFixed(4);
                const huellaDigital = titulo.toLowerCase().replace(/[^a-z0-9]/g, "");

                if (coordenadasVistas.has(keyCoord) || nombresVistos.has(huellaDigital)) return;

                coordenadasVistas.add(keyCoord);
                nombresVistos.add(huellaDigital);

                const li = document.createElement('li');
                let iconoClass = feature.place_type.includes('poi') ? 'fa-store' : 'fa-map-marker-alt';

                li.innerHTML = `<div class="result-icon"><i class="fas ${iconoClass}"></i></div><div class="result-text"><span class="result-title">${titulo}</span><span class="result-sub">${subtitulo}</span></div>`;
                li.onclick = () => { usarCoordenadaDirecta(`${titulo}, ${subtitulo}`, lat, lng); };
                lista.appendChild(li);
            });
            if (lista.children.length > 0) lista.style.display = 'block';
        }
    } catch (e) { console.error("Error Mapbox Geocoding:", e); }
}

function inicializarInputs() {
    const inputOrigen = document.getElementById('input-origen');
    const inputDestino = document.getElementById('input-destino');
    const listaCompartida = document.getElementById('lista-compartida');
    inputOrigen.addEventListener('focus', () => { activeInputId = 'input-origen'; listaCompartida.style.display = 'none'; });
    inputDestino.addEventListener('focus', () => { activeInputId = 'input-destino'; listaCompartida.style.display = 'none'; });
    configurarInput(inputOrigen);
    configurarInput(inputDestino);
}

function configurarInput(inputElement) {
    let timeout = null;
    inputElement.addEventListener('input', function () {
        const query = this.value;
        const lista = document.getElementById('lista-compartida');

        // Insertar siempre inmediatamente después del contenedor de inputs de la ruta, NO adentro del label
        const container = document.querySelector('.input-route-container');
        if(container && container.parentNode) {
            container.parentNode.insertBefore(lista, container.nextSibling);
        }

        if (query.length < 2) { lista.style.display = 'none'; return; }
        clearTimeout(timeout);
        mostrarSkeleton(lista);
        timeout = setTimeout(() => { buscarSugerenciasHibridas(query); }, 300);
    });
}

function mostrarSkeleton(lista) {
    lista.style.display = 'block';
    lista.innerHTML = '';
    for (let i = 0; i < 3; i++) {
        const li = document.createElement('li');
        li.style.pointerEvents = 'none';
        li.innerHTML = `<div class="skeleton-icon"></div><div class="skeleton-text-group"><div class="skeleton-line-long"></div><div class="skeleton-line-short"></div></div>`;
        lista.appendChild(li);
    }
}

function usarCoordenadaDirecta(nombre, lat, lon) {
    const inputActivo = document.getElementById(activeInputId);
    inputActivo.value = nombre;
    document.getElementById('lista-compartida').style.display = 'none';
    const latlng = { lat: lat, lng: lon }; 
    if (activeInputId === 'input-origen') { coordOrigen = latlng; } else { coordDestino = latlng; const datosAGuardar = { direccion: nombre, lat: lat, lng: lon }; localStorage.setItem('ultimoDestinoTaxi', JSON.stringify(datosAGuardar)); cargarHistorial(); }
}

function obtenerUbicacionActual() {
    const inputOrigen = document.getElementById('input-origen');
    if ("geolocation" in navigator) {
        inputOrigen.classList.add('input-loading');
        const opcionesGPS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
        const onExito = async function (position) {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            coordOrigen = { lat: lat, lng: lon }; 
            map.flyTo({ center: [lon, lat], zoom: 16, essential: true });

            const elStart = document.createElement('div');
            elStart.className = 'uber-origen-container';
            elStart.innerHTML = '<div class="uber-origen-pulse"></div><div class="uber-origen"></div>';

            if (gpsMarker) gpsMarker.remove();
            gpsMarker = new mapboxgl.Marker(elStart).setLngLat([lon, lat]).addTo(map);
            try {
                const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=address,poi&language=es&access_token=${MAPBOX_TOKEN}`;
                const resp = await fetch(url);
                const data = await resp.json();
                if (data.features && data.features.length > 0) {
                    let feature = data.features[0];
                    let direccion = feature.text;
                    if (feature.address) direccion += ' ' + feature.address;

                    let ciudad = "Río Cuarto";
                    if (feature.context) {
                        const ctxPlace = feature.context.find(c => c.id.startsWith('place'));
                        if (ctxPlace) ciudad = ctxPlace.text;
                    }

                    const distSC = calcularDistanciaKm(SC_LAT, SC_LON, lat, lon);
                    if (distSC < 5 && (ciudad === "Las Vertientes" || ciudad === "Holmberg")) ciudad = "Santa Catalina";
                    if (ciudad) direccion += `, ${ciudad}`;
                    inputOrigen.value = direccion;
                } else { inputOrigen.value = "Ubicación detectada"; }
            } catch (e) { inputOrigen.value = "Mi Ubicación Actual"; }
            finally { inputOrigen.classList.remove('input-loading'); }
        };
        navigator.geolocation.getCurrentPosition(onExito, function (error) {
            navigator.geolocation.getCurrentPosition(onExito, (err) => {
                inputOrigen.classList.remove('input-loading');
                inputOrigen.placeholder = "Escribe tu dirección...";
            }, { enableHighAccuracy: false, timeout: 15000 });
        }, opcionesGPS);
    }
}

function calcularDistanciaKm(lat1, lon1, lat2, lon2) { const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180; const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2); const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); return R * c; }
function cargarHistorial() { const guardado = localStorage.getItem('ultimoDestinoTaxi'); if (guardado) { const datos = JSON.parse(guardado); const container = document.getElementById('historial-container'); const link = document.getElementById('historial-valor'); let nombreCorto = datos.direccion.length > 30 ? datos.direccion.substring(0, 28) + '...' : datos.direccion; link.innerText = nombreCorto; container.style.display = 'block'; link.onclick = function () { document.getElementById('input-destino').value = datos.direccion; coordDestino = { lat: datos.lat, lng: datos.lng }; } } }
function calcularPrecio() { const ahora = new Date(); const hora = ahora.getHours(); let esNoche = (hora >= 21 || hora < 7); let tarifaActual = esNoche ? TARIFAS_TAXI.noche : TARIFAS_TAXI.dia; let bajada = tarifaActual.bajada; let ficha = tarifaActual.ficha; let textoTarifa = esNoche ? "🚕 Noche" : "☀️ Día"; document.getElementById('badge-tarifa').innerText = textoTarifa; let km = distanciaCalculada; let calculoBruto = bajada + (km * ficha); let resultadoFinal = calculoBruto - (calculoBruto * 0.10); document.getElementById('precio-original').innerText = calculoBruto.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' }); document.getElementById('precio-final').innerText = resultadoFinal.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' }); document.getElementById('distancia-final').innerText = km.toFixed(2) + ' km'; }

function volverAlFormulario() {
    document.getElementById('panel-resultados').classList.remove('visible');
    document.getElementById('panel-resultados').classList.remove('minimized');
    document.getElementById('floating-trip-card').classList.remove('visible');
    document.getElementById('panel-inputs').classList.remove('hidden');

    // Restore GPS marker unconditionally
    if (gpsMarker) {
        gpsMarker.addTo(map);
    }

    // Reset View
    map.flyTo({ center: [RIO_CUARTO_LON, RIO_CUARTO_LAT], zoom: 14, pitch: 0, bearing: 0, essential: true });

    if (map.getSource('route')) {
        map.getSource('route').setData({
            'type': 'Feature',
            'properties': {},
            'geometry': {
                'type': 'LineString',
                'coordinates': []
            }
        });
    }

    if (markerA) { markerA.remove(); markerA = null; }
    if (markerB) { markerB.remove(); markerB = null; }
}

function editarInput(tipo) {
    volverAlFormulario();
    setTimeout(() => {
        const inputId = tipo === 'origen' ? 'input-origen' : 'input-destino';
        const inputElement = document.getElementById(inputId);
        inputElement.focus();
        // Optional: Select text so it's easy to over-type
        inputElement.select();
    }, 400); // Wait for the transition
}
function pedirPorWhatsapp(tipo) {
    let origen = document.getElementById('input-origen').value;
    
    // Si no está definida el origen real
    if (!origen || origen === "Ubicación detectada" || origen === "Mi Ubicación Actual") {
        showToast("Por favor selecciona una dirección exacta primero.", "error");
        return;
    }

    let numero = "";
    let mensaje = "";

    // Bot Automático (Dorado)
    if (tipo === 'bot') {
        numero = "5493586540211";
        mensaje = origen;
    } 
// Opción Mascota (Verde)
    else if (tipo === 'mascota') {
        numero = "5493584199122";
        mensaje = `Hola, necesito un movil a ${origen} y llevo una mascota mediana/chica`;
    } 
    // Opción Programar Pendiente (Verde)
    else if (tipo === 'pendiente') {
        // En lugar de enviar directo, abrimos modal interactivo
        document.getElementById('modal-programar').classList.add('visible');
        return; 
    }

    if (numero !== "") {
        window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`, '_blank');
    }
}

// --- LOGICA MODAL PROGRAMACION ---
function cerrarModalProgramar() {
    document.getElementById('modal-programar').classList.remove('visible');
}

function confirmarProgramacion() {
    let origen = document.getElementById('input-origen').value;
    let horaInput = document.getElementById('input-hora-programada').value;

    if (!horaInput) {
        showToast("Por favor selecciona una hora.", "error");
        return;
    }

    document.getElementById('modal-programar').classList.remove('visible');
    
    let numero = "5493584199122";
    let mensaje = `Hola, necesito un pendiente para las ${horaInput}hs en ${origen}`;
    window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`, '_blank');
}

window.addEventListener('load', () => {
    cargarLugaresVIP();
    cargarTarifas();
    obtenerUbicacionActual();
    cargarHistorial();
    inicializarInputs();
});

function togglePanelResultados() {
    const panel = document.getElementById('panel-resultados');
    panel.classList.toggle('minimized');
}