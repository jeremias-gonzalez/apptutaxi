const RIO_CUARTO_LAT = -33.1232;
const RIO_CUARTO_LON = -64.3493;
const SC_LAT = -33.205; 
const SC_LON = -64.440;
const RIO_BBOX = "-64.55,-33.25,-64.20,-33.05"; 

let LUGARES_VIP = [];
let TARIFAS_TAXI = { dia: { bajada: 1750, ficha: 880 }, noche: { bajada: 1900, ficha: 950 } }; // Valores por defecto

var map = L.map('map', { zoomControl: false }).setView([RIO_CUARTO_LAT, RIO_CUARTO_LON], 14);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© OSM', maxZoom: 19 }).addTo(map);

var coordOrigen = null;
var coordDestino = null;
var distanciaCalculada = 0; 
var activeInputId = null;
var gpsMarker = null; 

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

// --- RUTAS Y MAPA ---
var controlRutas = L.Routing.control({
    waypoints: [], 
    routeWhileDragging: true, 
    addWaypoints: false, 
    show: false,
    router: L.Routing.osrmv1({
        serviceUrl: 'https://router.project-osrm.org/route/v1',
        profile: 'driving',
        routingOptions: { alternatives: true, steps: false }
    }),
    lineOptions: { styles: [ { className: 'route-line-animated' } ], extendToWaypoints: true, missingRouteTolerance: 0.1 },
    altLineOptions: { styles: [ { className: 'leaflet-routing-alt-line' } ] },
    createMarker: function(i, wp, nWps) {
        if (i === 0) {
             const startIcon = L.divIcon({ className: 'gps-dot-container', html: '<div class="gps-pulse"></div><div class="gps-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
            return L.marker(wp.latLng, { draggable: true, icon: startIcon });
        }
        else if (i === nWps - 1) {
            return L.marker(wp.latLng, { draggable: true, icon: L.divIcon({ className: 'custom-div-icon', iconSize: [30, 30], iconAnchor: [5, 25], html: '<div class="map-icon-inner flag-icon-small"><i class="fas fa-flag-checkered"></i></div>' }) });
        }
        return null;
    }
}).addTo(map);

controlRutas.on('routesfound', function(e) {
    var bestRoute = e.routes[0];
    actualizarDatosRuta(bestRoute);
    if (!document.getElementById('panel-resultados').classList.contains('visible')) {
         map.fitBounds(L.latLngBounds([coordOrigen, coordDestino]), { paddingTopLeft: [50, 50], paddingBottomRight: [50, 300] });
         document.getElementById('loader').style.display = 'none';
         document.getElementById('panel-inputs').classList.add('hidden');
         document.getElementById('panel-resultados').classList.add('visible');
    } else { document.getElementById('loader').style.display = 'none'; }
    if(gpsMarker && coordOrigen.equals(gpsMarker.getLatLng())) { map.removeLayer(gpsMarker); }
});

controlRutas.on('routeselected', function(e) {
    var selectedRoute = e.route;
    actualizarDatosRuta(selectedRoute);
});

function actualizarDatosRuta(route) {
    let kmReales = route.summary.totalDistance / 1000;
    distanciaCalculada = kmReales * 1.10; // 10% Extra
    calcularPrecio();
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
            document.getElementById('input-origen').style.borderColor = "#444";
            document.getElementById('input-destino').style.borderColor = "#444";
        }, 500);
        return;
    }
    showToast("Calculando la mejor ruta...", "success");
    document.getElementById('loader').style.display = 'flex';
    controlRutas.setWaypoints([coordOrigen, coordDestino]);
}

// --- BUSCADOR HÍBRIDO OPTIMIZADO (ANTI-DUPLICADOS) ---
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
        li.style.background = "#2d2d2d"; 
        li.innerHTML = `<div class="result-icon" style="color: gold;"><i class="fas fa-star"></i></div><div class="result-text"><span class="result-title">${lugar.nombre}</span><span class="result-sub">${lugar.direccion}</span></div>`;
        li.onclick = () => { usarCoordenadaDirecta(lugar.nombre, lugar.lat, lugar.lon); };
        lista.appendChild(li);
    });

    let textoConContexto = busquedaParaApi.toLowerCase().match(/(rio cuarto|higueras|holmberg|catalina)/) ? busquedaParaApi : `${busquedaParaApi}, Rio Cuarto, Cordoba`;

    if (tieneNumero) {
        const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&singleLine=${encodeURIComponent(textoConContexto)}&searchExtent=${RIO_BBOX}&maxLocations=10&outFields=Match_addr,Place_Addr,Type&countryCode=ARG`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.candidates && data.candidates.length > 0) {
                 data.candidates.forEach(candidate => {
                    let titulo = candidate.address.split(',')[0];
                    const keyCoord = candidate.location.y.toFixed(4) + "," + candidate.location.x.toFixed(4);
                    if (coordenadasVistas.has(keyCoord) || nombresVistos.has(titulo.toLowerCase())) return;
                    coordenadasVistas.add(keyCoord);
                    nombresVistos.add(titulo.toLowerCase());
                    const li = document.createElement('li');
                    li.innerHTML = `<div class="result-icon"><i class="fas fa-map-marker-alt"></i></div><div class="result-text"><span class="result-title">${titulo}</span><span class="result-sub">Dirección exacta</span></div>`;
                    li.onclick = () => { usarCoordenadaDirecta(titulo, candidate.location.y, candidate.location.x); };
                    lista.appendChild(li);
                });
                if (lista.children.length > 0) lista.style.display = 'block';
            }
        } catch(e) { console.error(e); }
    } else {
        const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?f=json&text=${encodeURIComponent(textoConContexto)}&searchExtent=${RIO_BBOX}&category=Address,POI&maxSuggestions=10&countryCode=ARG`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.suggestions && data.suggestions.length > 0) {
                const vistos = new Set();
                data.suggestions.forEach(item => {
                    let texto = item.text;
                    texto = texto.replace(", Córdoba, ARG", "").replace(", ARG", "").replace(", Córdoba", "");
                    let titulo = texto.split(',')[0];
                    if (titulo.includes("Las Vertientes")) titulo = titulo.replace("Las Vertientes", "Santa Catalina");
                    if (!texto.toLowerCase().match(/(rio cuarto|río cuarto|higueras|catalina|holmberg|vertientes)/)) return;
                    const huellaDigital = titulo.toLowerCase().replace(/[^a-z0-9]/g, "");
                    if (nombresVistos.has(huellaDigital)) return;
                    nombresVistos.add(huellaDigital);
                    if (vistos.has(texto)) return;
                    vistos.add(texto);
                    const partes = texto.split(',');
                    const subtitulo = partes.length > 1 ? partes.slice(1).join(',').trim() : "Río Cuarto";
                    const li = document.createElement('li');
                    let iconoClass = item.isCollection ? 'fa-store' : 'fa-road';
                    li.innerHTML = `<div class="result-icon"><i class="fas ${iconoClass}"></i></div><div class="result-text"><span class="result-title">${titulo}</span><span class="result-sub">${subtitulo}</span></div>`;
                    li.onclick = () => { resolverUbicacion(item.magicKey, texto); };
                    lista.appendChild(li);
                });
                if (lista.children.length > 0) lista.style.display = 'block';
            }
        } catch(e) { console.error(e); }
    }
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
    inputElement.addEventListener('input', function() {
        const query = this.value;
        const lista = document.getElementById('lista-compartida');
        if (query.length < 2) { lista.style.display = 'none'; return; }
        clearTimeout(timeout);
        mostrarSkeleton(lista);
        timeout = setTimeout(() => { buscarSugerenciasHibridas(query); }, 300);
    });
}

function mostrarSkeleton(lista) {
    lista.style.display = 'block';
    lista.innerHTML = ''; 
    for(let i=0; i<3; i++) {
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
    const latlng = L.latLng(lat, lon);
    if (activeInputId === 'input-origen') { coordOrigen = latlng; } else { coordDestino = latlng; const datosAGuardar = { direccion: nombre, lat: lat, lng: lon }; localStorage.setItem('ultimoDestinoTaxi', JSON.stringify(datosAGuardar)); cargarHistorial(); }
}

async function resolverUbicacion(magicKey, textoMostrado) {
    const inputActivo = document.getElementById(activeInputId);
    inputActivo.value = textoMostrado; 
    document.getElementById('lista-compartida').style.display = 'none';
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&magicKey=${magicKey}&singleLine=${encodeURIComponent(textoMostrado)}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.candidates && data.candidates.length > 0) {
            const cand = data.candidates[0];
            const latlng = L.latLng(cand.location.y, cand.location.x);
            if (activeInputId === 'input-origen') { coordOrigen = latlng; } else { coordDestino = latlng; const datosAGuardar = { direccion: textoMostrado, lat: cand.location.y, lng: cand.location.x }; localStorage.setItem('ultimoDestinoTaxi', JSON.stringify(datosAGuardar)); cargarHistorial(); }
        }
    } catch (e) { console.error(e); }
}

function obtenerUbicacionActual() {
    const inputOrigen = document.getElementById('input-origen');
    if ("geolocation" in navigator) {
        inputOrigen.classList.add('input-loading');
        const opcionesGPS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
        const onExito = async function(position) {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            coordOrigen = L.latLng(lat, lon);
            map.setView([lat, lon], 16);
            const gpsIcon = L.divIcon({ className: 'gps-dot-container', html: '<div class="gps-pulse"></div><div class="gps-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
            if(gpsMarker) map.removeLayer(gpsMarker);
            gpsMarker = L.marker([lat, lon], { icon: gpsIcon }).addTo(map);
            try {
                const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=json&featureTypes=&location=${lon},${lat}`;
                const resp = await fetch(url);
                const data = await resp.json();
                if(data && data.address) {
                    let direccion = data.address.Address;
                    let ciudad = data.address.City;
                    const distSC = calcularDistanciaKm(SC_LAT, SC_LON, lat, lon);
                    if(distSC < 5 && (ciudad === "Las Vertientes" || ciudad === "Holmberg")) ciudad = "Santa Catalina";
                    if(ciudad) direccion += `, ${ciudad}`;
                    inputOrigen.value = direccion;
                } else { inputOrigen.value = "Ubicación detectada"; }
            } catch(e) { inputOrigen.value = "Mi Ubicación Actual"; } 
            finally { inputOrigen.classList.remove('input-loading'); }
        };
        navigator.geolocation.getCurrentPosition(onExito, function(error) { 
                navigator.geolocation.getCurrentPosition(onExito, (err) => {
                    inputOrigen.classList.remove('input-loading'); 
                    inputOrigen.placeholder = "Escribe tu dirección...";
                }, { enableHighAccuracy: false, timeout: 15000 });
            }, opcionesGPS);
    }
}

function calcularDistanciaKm(lat1, lon1, lat2, lon2) { const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180; const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2); const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); return R * c; }
function cargarHistorial() { const guardado = localStorage.getItem('ultimoDestinoTaxi'); if (guardado) { const datos = JSON.parse(guardado); const container = document.getElementById('historial-container'); const link = document.getElementById('historial-valor'); let nombreCorto = datos.direccion.length > 30 ? datos.direccion.substring(0, 28) + '...' : datos.direccion; link.innerText = nombreCorto; container.style.display = 'block'; link.onclick = function() { document.getElementById('input-destino').value = datos.direccion; coordDestino = L.latLng(datos.lat, datos.lng); } } }
function calcularPrecio() { const ahora = new Date(); const hora = ahora.getHours(); let esNoche = (hora >= 21 || hora < 7); let tarifaActual = esNoche ? TARIFAS_TAXI.noche : TARIFAS_TAXI.dia; let bajada = tarifaActual.bajada; let ficha = tarifaActual.ficha; let textoTarifa = esNoche ? "🌜 Noche" : "🌞 Día"; document.getElementById('badge-tarifa').innerText = textoTarifa; let km = distanciaCalculada; let calculoBruto = bajada + (km * ficha); let resultadoFinal = calculoBruto - (calculoBruto * 0.10); document.getElementById('precio-original').innerText = calculoBruto.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' }); document.getElementById('precio-final').innerText = resultadoFinal.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' }); document.getElementById('distancia-final').innerText = km.toFixed(2) + ' km'; }
function volverAlFormulario() { document.getElementById('panel-resultados').classList.remove('visible'); document.getElementById('panel-inputs').classList.remove('hidden'); if(gpsMarker && !map.hasLayer(gpsMarker)) gpsMarker.addTo(map); controlRutas.setWaypoints([]); }
function pedirPorWhatsapp() { let origen = document.getElementById('input-origen').value; let destino = document.getElementById('input-destino').value; let precio = document.getElementById('precio-final').innerText; let numero = "5493584199122"; let mensaje = `Hola! 🚖\nQuiero solicitar un taxi.\n\n📍 *Desde:* ${origen}\n🏁 *Hasta:* ${destino}\n💰 *Precio Est:* ${precio}`; window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`, '_blank'); }

function typeWriter() {
    const text = "10% DE DESCUENTO EN TODOS TUS VIAJES!";
    const element = document.getElementById('typing-text');
    const speed = 70; 
    let i = 0;
    function type() {
        if (i < text.length) {
            element.innerHTML += text.charAt(i);
            i++;
            setTimeout(type, speed);
        }
    }
    setTimeout(type, 500); 
}

window.addEventListener('load', () => {
    cargarLugaresVIP();
    cargarTarifas();
    typeWriter();
    setTimeout(() => {
        document.getElementById('splash-logo-container').style.display = 'none';
        document.getElementById('splash-loader-container').style.display = 'flex';
        setTimeout(() => {
            document.getElementById('splash-screen').classList.add('splash-hidden');
            obtenerUbicacionActual();
            cargarHistorial();
            inicializarInputs();
        }, 3500); 
    }, 2000); 
});