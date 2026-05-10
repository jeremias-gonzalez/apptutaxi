// ============================================================
//  TUTAXI — conductor.js
//  Lógica completa del panel de conductor
// ============================================================

// ── Inicializar Supabase y Mapbox ─────────────────────────────
// ENV se carga desde supabase/env.js (debe ir antes en el HTML)
const { createClient } = supabase;
const db = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY);
mapboxgl.accessToken = ENV.MAPBOX_TOKEN;

// Estado global
let conductorId      = null;
let viajeActualId    = null;
let viajeEnCursoData = null;
let realtimeCanal    = null;
let timerInterval    = null;
let timerSeconds     = 20;
let disponible       = false;
let gpsWatchId       = null;
let viajeEntrante    = null;

// Estado navegación
let navMap          = null;
let conductorMarker = null;
let posActual       = null;
let rumbo           = 0;
let velocidad       = 0;
let siguiendo       = true;
let distanciaTotal  = 0;
let ultimaRuta      = 0;
let navGpsWatch     = null;

// ══════════════════════════════════════════
//  SISTEMA DE VISTAS
// ══════════════════════════════════════════
function mostrarPantalla(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════
async function loginConductor() {
    const email = document.getElementById('l-email').value.trim();
    const pass  = document.getElementById('l-pass').value;
    const btn   = document.getElementById('btn-ingresar');
    const errEl = document.getElementById('login-error');

    if (!email || !pass) { mostrarErrorLogin('Completá todos los campos.'); return; }
    btn.disabled = true; btn.textContent = 'Ingresando...';
    errEl.classList.remove('show');

    const { data, error } = await db.auth.signInWithPassword({ email, password: pass });
    if (error) {
        btn.disabled = false; btn.textContent = 'Ingresar';
        mostrarErrorLogin('Email o contraseña incorrectos.');
        return;
    }
    await iniciarApp(data.user);
}

function mostrarErrorLogin(msg) {
    const el = document.getElementById('login-error');
    el.textContent = msg; el.classList.add('show');
}

async function logoutConductor() {
    if (realtimeCanal) db.removeChannel(realtimeCanal);
    detenerGPS();
    await db.auth.signOut();
    mostrarPantalla('screen-login');
}

// ══════════════════════════════════════════
//  INICIAR APP
// ══════════════════════════════════════════
async function iniciarApp(user) {
    mostrarPantalla('screen-app');
    try {
        const { data: perfil, error } = await db.from('conductores')
            .select('id, nombre').eq('user_id', user.id).maybeSingle();
        
        if (error) throw error;
        
        if (!perfil) {
            showToast('Usuario sin perfil de conductor asignado', 'error');
            console.warn('⚠️ No se encontró registro en tabla "conductores" para user_id:', user.id);
            return;
        }

        conductorId = perfil.id;
        console.log('✅ Conductor identificado:', conductorId, perfil.nombre);
        
        await cargarViajeActivo();
        await cargarHistorialHoy();
        showToast(`Bienvenido, ${perfil.nombre}`, 'success');
    } catch (err) {
        console.error('Error al iniciar app:', err);
        showToast('Error al cargar perfil', 'error');
    }
}

// ══════════════════════════════════════════
//  DISPONIBILIDAD Y GPS
// ══════════════════════════════════════════
async function toggleDisponibilidad() {
    const toggle = document.getElementById('toggle-disp');
    if (!conductorId) {
        showToast('Error: Perfil de conductor no encontrado', 'error');
        toggle.checked = false;
        return;
    }

    disponible = toggle.checked;
    
    // Actualizar UI
    document.getElementById('disp-label').textContent = disponible ? 'Online' : 'Offline';
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');

    if (disponible) {
        dot.style.backgroundColor = '#22c55e'; // verde
        text.textContent = 'Disponible — esperando viajes...';
        suscribirViajes();
        iniciarGPS();
    } else {
        dot.style.backgroundColor = '#4b5563'; // gris
        text.textContent = 'Desconectado — activá disponibilidad para recibir viajes';
        if (realtimeCanal) { db.removeChannel(realtimeCanal); realtimeCanal = null; }
        detenerGPS();
    }

    // Persistir en base de datos
    try {
        const { error } = await db.from('conductores')
            .update({ disponible, activo: disponible })
            .eq('id', conductorId);
        
        if (error) throw error;
        console.log('✅ Disponibilidad actualizada:', disponible);
    } catch (err) {
        console.error('Error al actualizar disponibilidad:', err);
        showToast('Error al conectar con el servidor', 'error');
        // Revertir UI en caso de fallo crítico
        toggle.checked = !disponible;
        toggleDisponibilidad(); 
    }
}

function iniciarGPS() {
    if (!navigator.geolocation || gpsWatchId !== null) return;
    
    // Función para actualizar posición
    const actualizarPos = async (pos) => {
        const { latitude: lat, longitude: lng, heading } = pos.coords;
        posActual = { lat, lng };
        rumbo = heading || 0;
        
        if (!conductorId) return;
        
        console.log('📍 Actualizando GPS en DB:', lat, lng);
        const { error } = await db.from('conductores')
            .update({ 
                lat, 
                lng, 
                activo: true, 
                updated_at: new Date().toISOString() 
            })
            .eq('id', conductorId);
            
        if (error) console.error('Error GPS DB:', error.message);
    };

    // Primera actualización inmediata
    navigator.geolocation.getCurrentPosition(actualizarPos);

    // Seguimiento continuo
    gpsWatchId = navigator.geolocation.watchPosition(
        actualizarPos,
        (err) => {
            console.warn('GPS Error:', err.message);
            if (err.code === 1) showToast('Por favor, activa el GPS', 'error');
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
}


function detenerGPS() {
    if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
}

// ══════════════════════════════════════════
//  REALTIME — NUEVOS VIAJES
//  Estrategia: Asignación directa vía Edge Function
// ══════════════════════════════════════════
function suscribirViajes() {
    if (realtimeCanal) db.removeChannel(realtimeCanal);

    realtimeCanal = db.channel('conductor-viajes-' + conductorId)
        // ── ESTRATEGIA: ASIGNACIÓN DIRECTA (Solo reacciona si el viaje es para mí) ──
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'viajes' },
            (payload) => {
                const v = payload.new;
                
                // Caso 1: El viaje es asignado a este conductor
                if (v.estado === 'notificado' && v.conductor_id === conductorId && !viajeActualId) {
                    mostrarAlerta(v);
                }
                
                // Caso 2: El pasajero cancela mientras el conductor ve la alerta
                if (v.estado === 'cancelado' && viajeEntrante?.id === v.id) {
                    cerrarAlerta();
                    showToast('El pasajero canceló el viaje', 'info');
                }
            })

        .subscribe(async (status) => {
            console.log('📡 Realtime status:', status);
            if (status === 'SUBSCRIBED') {
                await buscarViajesExistentes();
            }
        });

    // Fallback: Polling cada 15 segundos por si Realtime falla
    if (window.pollingViajes) clearInterval(window.pollingViajes);
    window.pollingViajes = setInterval(() => {
        if (disponible && !viajeActualId) {
            buscarViajesExistentes();
        }
    }, 15000);
}


// Busca viajes que ya están en la base de datos (para cuando te conectás tarde)
async function buscarViajesExistentes() {
    if (!disponible || viajeActualId) return;

    console.log('🔍 Buscando viajes pendientes pre-existentes...');
    const { data: viajes, error } = await db.from('viajes')
        .select('*')
        .or(`estado.eq.pendiente,and(estado.eq.notificado,conductor_id.eq.${conductorId})`)
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) { console.error('Error buscando pendientes:', error); return; }

    for (const v of viajes) {
        if (v.estado === 'notificado' && v.conductor_id === conductorId) {
            mostrarAlerta(v);
            break;
        }
    }
}





// ══════════════════════════════════════════
//  ALERTA VIAJE ENTRANTE
// ══════════════════════════════════════════
function mostrarAlerta(viaje) {
    viajeEntrante = viaje;
    const fmt = (n) => Number(n).toLocaleString('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });

    document.getElementById('al-precio').textContent  = fmt(viaje.precio_estimado);
    document.getElementById('al-dist').textContent    = viaje.distancia_km ? Number(viaje.distancia_km).toFixed(1) + ' km' : '';
    document.getElementById('al-origen').textContent  = viaje.origen_texto  || '—';
    document.getElementById('al-destino').textContent = viaje.destino_texto || '—';
    
    // UI: Mostrar alerta usando Tailwind classes
    const alerta = document.getElementById('alerta-viaje');
    alerta.classList.remove('hidden');
    alerta.classList.add('flex');
    
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    iniciarTimer();
}

function iniciarTimer() {
    clearInterval(timerInterval);
    timerSeconds = 20; actualizarTimer();
    timerInterval = setInterval(() => {
        timerSeconds--;
        actualizarTimer();
        if (timerSeconds <= 0) { clearInterval(timerInterval); rechazarViaje(); }
    }, 1000);
}

function actualizarTimer() {
    const c = 126;
    document.getElementById('timer-prog').style.strokeDashoffset = c - (timerSeconds / 20) * c;
    document.getElementById('timer-num').textContent = timerSeconds;
}

function cerrarAlerta() {
    clearInterval(timerInterval);
    const alerta = document.getElementById('alerta-viaje');
    alerta.classList.add('hidden');
    alerta.classList.remove('flex');
    viajeEntrante = null;
}

async function aceptarViaje() {
    if (!viajeEntrante) return;
    clearInterval(timerInterval);
    const viaje = viajeEntrante;
    cerrarAlerta();

    // Intentar aceptar el viaje de forma segura
    let query = db.from('viajes').update({
        estado: 'en_curso',
        conductor_id: conductorId, // Asegurarnos de que el conductor quede asignado
        aceptado_at: new Date().toISOString()
    }).eq('id', viaje.id);

    // Si el viaje ya venía notificado a este conductor, filtramos por eso
    if (viaje.estado === 'notificado') {
        query = query.eq('estado', 'notificado').eq('conductor_id', conductorId);
    } else {
        // Fallback: si era pendiente, solo aceptamos si nadie más lo tomó
        query = query.eq('estado', 'pendiente').is('conductor_id', null);
    }

    const { error } = await query;


    if (error) { alert('No se pudo aceptar el viaje.'); return; }

    viajeActualId = viaje.id;
    mostrarViajeActivo(viaje);
    await cargarHistorialHoy();
}

async function rechazarViaje() {
    cerrarAlerta();
    if (!viajeEntrante) return;

    // Volver a pendiente para que el algoritmo intente con otro conductor
    await db.from('viajes').update({
        estado: 'pendiente',
        conductor_id: null
    }).eq('id', viajeEntrante.id).eq('conductor_id', conductorId);
}

// ══════════════════════════════════════════
//  VIAJE ACTIVO
// ══════════════════════════════════════════
function mostrarViajeActivo(viaje) {
    viajeEnCursoData = viaje;
    const fmt = (n) => Number(n).toLocaleString('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });
    document.getElementById('va-precio').textContent  = fmt(viaje.precio_estimado);
    document.getElementById('va-origen').textContent  = viaje.origen_texto  || '—';
    document.getElementById('va-destino').textContent = viaje.destino_texto || '—';
    document.getElementById('viaje-activo').style.display = 'block';
}

async function cargarViajeActivo() {
    if (!conductorId) return;
    const { data } = await db.from('viajes')
        .select('*').eq('conductor_id', conductorId).eq('estado', 'en_curso').maybeSingle();
    if (data) { viajeActualId = data.id; mostrarViajeActivo(data); }
}

async function completarViaje() {
    if (!viajeActualId) return;
    await db.from('viajes').update({
        estado: 'completado',
        completado_at: new Date().toISOString()
    }).eq('id', viajeActualId);

    viajeActualId = null; viajeEnCursoData = null;
    document.getElementById('viaje-activo').style.display = 'none';
    // Marcar conductor como disponible de nuevo
    if (conductorId) await db.from('conductores').update({ disponible: true }).eq('id', conductorId);
    await cargarHistorialHoy();
}

// ══════════════════════════════════════════
//  HISTORIAL
// ══════════════════════════════════════════
async function cargarHistorialHoy() {
    if (!conductorId) return;
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const { data } = await db.from('viajes').select('*')
        .eq('conductor_id', conductorId)
        .gte('created_at', hoy.toISOString())
        .order('created_at', { ascending: false });

    const fmt = (n) => Number(n).toLocaleString('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });
    const container = document.getElementById('historial-hoy');
    if (!data || data.length === 0) {
        container.innerHTML = `<div class="empty-hist"><i class="fas fa-route"></i><p>Aún no aceptaste viajes hoy.</p></div>`;
        return;
    }
    container.innerHTML = data.map(v => `
        <div class="historial-item">
            <div class="hi-route">
                <div class="hi-addr">${(v.origen_texto||'').split(',')[0]} → ${(v.destino_texto||'').split(',')[0]}</div>
                <div class="hi-sub">${v.distancia_km ? Number(v.distancia_km).toFixed(1)+' km · ' : ''}${v.estado}</div>
            </div>
            <div class="hi-price">${fmt(v.precio_estimado)}</div>
        </div>`).join('');
}

// ══════════════════════════════════════════
//  NAVEGACIÓN — TRANSICIÓN DE VISTAS
// ══════════════════════════════════════════
function irANavegacion() {
    if (!viajeEnCursoData) return;
    mostrarPantalla('screen-nav');
    document.getElementById('nav-destino-addr').textContent = viajeEnCursoData.destino_texto || 'Destino';
    iniciarNavegacion();
}

function volverDeNavegacion() {
    detenerNavegacion();
    mostrarPantalla('screen-app');
}

async function completarDesdeNav() {
    await completarViaje();
    detenerNavegacion();
    mostrarPantalla('screen-app');
}

// ══════════════════════════════════════════
//  MAPA DE NAVEGACIÓN
// ══════════════════════════════════════════
const ICONOS_MANIOBRA = {
    'turn-left':'↰','turn-right':'↱','turn-slight-left':'↖','turn-slight-right':'↗',
    'turn-sharp-left':'↺','turn-sharp-right':'↻','uturn':'⇅','roundabout':'⟳',
    'arrive':'🏁','depart':'↑','straight':'↑','merge':'⇒',
};

function iniciarNavegacion() {
    const destLat = viajeEnCursoData?.destino_lat;
    const destLng = viajeEnCursoData?.destino_lng;

    if (!navMap) {
        navMap = new mapboxgl.Map({
            container: 'nav-map',
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            zoom: 16, pitch: 60, bearing: 0,
            center: destLng && destLat ? [destLng, destLat] : [-64.35, -33.12]
        });
        navMap.on('touchstart', () => {
            siguiendo = false;
            document.getElementById('btn-centrar').classList.remove('active-btn');
        });
        navMap.on('load', () => {
            if (destLat && destLng) agregarMarcadorDestino(destLng, destLat);
            iniciarGPSNavegacion();
            mostrarToastNav('GPS activado — navegando 🗺️');
            if (destLat && destLng) setTimeout(() => buscarViajesCercanos(destLat, destLng), 3000);
        });
    } else {
        navMap.resize();
        if (destLat && destLng) agregarMarcadorDestino(destLng, destLat);
        iniciarGPSNavegacion();
        if (destLat && destLng) setTimeout(() => buscarViajesCercanos(destLat, destLng), 3000);
    }
}

function detenerNavegacion() {
    if (navGpsWatch !== null) { navigator.geolocation.clearWatch(navGpsWatch); navGpsWatch = null; }
    document.getElementById('nav-sugerencias').classList.remove('show');
}

function agregarMarcadorDestino(lng, lat) {
    const el = document.createElement('div');
    el.style.cssText = 'width:34px;height:34px;background:#FFD700;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;box-shadow:0 4px 16px rgba(255,215,0,0.5)';
    el.textContent = '🏁';
    new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(navMap);
}

function iniciarGPSNavegacion() {
    if (!navigator.geolocation) return;
    if (navGpsWatch !== null) navigator.geolocation.clearWatch(navGpsWatch);

    let ultimoUpdate = 0;
    navGpsWatch = navigator.geolocation.watchPosition(async (pos) => {
        const { latitude: lat, longitude: lng, speed, heading } = pos.coords;
        velocidad = speed ? Math.round(speed * 3.6) : 0;
        rumbo     = heading || rumbo;
        posActual = { lat, lng };

        document.getElementById('nav-vel').textContent = velocidad || '—';
        actualizarMarcadorConductor(lng, lat, rumbo);

        const ahora = Date.now();
        if (conductorId && (ahora - ultimoUpdate) > 3000) {
            ultimoUpdate = ahora;
            await db.from('conductores').update({ lat, lng, updated_at: new Date().toISOString() }).eq('id', conductorId);
        }
        if (!ultimaRuta || (ahora - ultimaRuta) > 25000) {
            ultimaRuta = ahora;
            await calcularRutaNavegacion(lng, lat);
        }
    }, (err) => console.warn('GPS nav:', err.message),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 });
}

function actualizarMarcadorConductor(lng, lat, heading) {
    if (!conductorMarker) {
        const el = document.createElement('div');
        el.innerHTML = `<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;">
            <svg width="44" height="44" viewBox="0 0 44 44" style="filter:drop-shadow(0 4px 12px rgba(255,215,0,0.6))">
                <circle cx="22" cy="22" r="20" fill="#FFD700" opacity="0.2"/>
                <circle cx="22" cy="22" r="14" fill="#FFD700"/>
                <path d="M22 8 L28 28 L22 24 L16 28 Z" fill="#000"/>
            </svg></div>`;
        conductorMarker = new mapboxgl.Marker({ element: el, anchor: 'center', rotationAlignment: 'map' })
            .setLngLat([lng, lat]).addTo(navMap);
    } else {
        conductorMarker.setLngLat([lng, lat]);
    }
    conductorMarker.setRotation(heading);
    if (siguiendo) navMap.easeTo({ center:[lng,lat], bearing:heading, pitch:60, zoom:17, duration:1000 });
}

async function calcularRutaNavegacion(origenLng, origenLat) {
    const destLat = viajeEnCursoData?.destino_lat;
    const destLng = viajeEnCursoData?.destino_lng;
    if (!destLat || !destLng) return;

    try {
        const url  = `https://api.mapbox.com/directions/v5/mapbox/driving/${origenLng},${origenLat};${destLng},${destLat}?steps=true&geometries=geojson&language=es&access_token=${ENV.MAPBOX_TOKEN}`;
        const data = await (await fetch(url)).json();
        const ruta = data.routes?.[0];
        if (!ruta) return;

        distanciaTotal = distanciaTotal || ruta.distance;

        const geomData = { type:'Feature', geometry:ruta.geometry };
        if (navMap.getSource('nav-ruta')) {
            navMap.getSource('nav-ruta').setData(geomData);
        } else {
            navMap.addSource('nav-ruta', { type:'geojson', data:geomData });
            navMap.addLayer({ id:'nav-ruta-glow', type:'line', source:'nav-ruta',
                layout:{'line-join':'round','line-cap':'round'},
                paint:{'line-color':'#FFD700','line-width':10,'line-opacity':0.12}});
            navMap.addLayer({ id:'nav-ruta-line', type:'line', source:'nav-ruta',
                layout:{'line-join':'round','line-cap':'round'},
                paint:{'line-color':'#FFD700','line-width':5,'line-opacity':0.9}});
        }
        

        const paso     = ruta.legs[0]?.steps?.[0];
        const maniobra = paso?.maneuver?.modifier
            ? `${paso.maneuver.type}-${paso.maneuver.modifier}`.replace(/ /g,'-')
            : paso?.maneuver?.type || '';
        document.getElementById('nav-icono').textContent = ICONOS_MANIOBRA[maniobra] || '↑';
        const distPaso = paso?.distance || 0;
        document.getElementById('nav-dist').textContent  = distPaso < 1000 ? Math.round(distPaso)+'m' : (distPaso/1000).toFixed(1)+'km';
        document.getElementById('nav-calle').textContent = paso?.maneuver?.instruction || paso?.name || 'Continuar';

        const distKm = ruta.distance / 1000;
        const durMin = Math.max(1, Math.round(ruta.duration / 60));
        document.getElementById('nav-eta').textContent       = durMin + ' min';
        document.getElementById('nav-dist-rest').textContent = distKm < 1 ? Math.round(ruta.distance)+'m' : distKm.toFixed(1)+'km';

        if (distanciaTotal > 0) {
            const prog = Math.max(0, Math.min(100, (1 - ruta.distance / distanciaTotal) * 100));
            document.getElementById('nav-progress').style.width = prog + '%';
        }
    } catch(e) { console.warn('Ruta error:', e); }
}

function centrarConductor() {
    siguiendo = true;
    document.getElementById('btn-centrar').classList.add('active-btn');
    if (posActual && navMap) navMap.easeTo({ center:[posActual.lng,posActual.lat], zoom:17, pitch:60, bearing:rumbo, duration:800 });
}

function orientarNorte() {
    if (navMap) navMap.easeTo({ bearing:0, pitch:0, duration:600 });
    const btn = document.getElementById('btn-norte');
    btn.classList.add('active-btn');
    setTimeout(() => btn.classList.remove('active-btn'), 700);
}

// ══════════════════════════════════════════
//  VIAJES CERCANOS AL DESTINO
// ══════════════════════════════════════════
function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function buscarViajesCercanos(destLat, destLng) {
    try {
        const { data: viajes } = await db.from('viajes')
            .select('*').in('estado', ['pendiente','notificado'])
            .order('created_at', { ascending: false }).limit(20);

        if (!viajes?.length) return;

        const cercanos = viajes.filter(v => {
            if (!v.origen_lat || !v.origen_lng) return false;
            return haversineM(destLat, destLng, v.origen_lat, v.origen_lng) <= 3000;
        }).slice(0, 3);

        if (cercanos.length === 0) return;
        renderizarSugerencias(cercanos);
    } catch(e) { console.warn('Sugerencias:', e); }
}

function renderizarSugerencias(viajes) {
    const fmt = (n) => Number(n).toLocaleString('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });
    const container = document.getElementById('nav-sugerencias');
    const cards = viajes.map((v, i) => `
        <div class="sug-card" style="animation-delay:${i*0.08}s" onclick="aceptarSugerencia('${v.id}')">
            <div class="sug-icon">🚖</div>
            <div class="sug-info">
                <div class="sug-origen">${v.origen_texto?.split(',')[0]||'—'} → ${v.destino_texto?.split(',')[0]||'—'}</div>
                <div class="sug-sub">${v.distancia_km ? Number(v.distancia_km).toFixed(1)+' km' : ''}</div>
            </div>
            <div class="sug-precio">${fmt(v.precio_estimado)}</div>
        </div>`).join('');

    container.innerHTML = `<div class="sug-label">🚖 Viajes cercanos al destino</div>${cards}`;
    container.classList.add('show');
    setTimeout(() => container.classList.remove('show'), 15000);
}

async function aceptarSugerencia(viajeId) {
    document.getElementById('nav-sugerencias').classList.remove('show');
    const { data: viaje } = await db.from('viajes').select('*').eq('id', viajeId).maybeSingle();
    if (!viaje || !['pendiente','notificado'].includes(viaje.estado)) {
        mostrarToastNav('Este viaje ya no está disponible');
        return;
    }
    mostrarAlerta(viaje);
}

function mostrarToastNav(msg) {
    const el = document.getElementById('nav-toast');
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
window.addEventListener('load', async () => {
    const { data: { session } } = await db.auth.getSession();
    if (session) await iniciarApp(session.user);

    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && document.getElementById('screen-login').classList.contains('active'))
            loginConductor();
    });
});

// ── NOTIFICACIONES (TOAST) ──────────────────────────────────
function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-24 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-full text-sm font-bold shadow-2xl z-[1000] transition-all duration-300 transform translate-y-10 opacity-0`;
    
    const colors = {
        success: 'bg-green-500 text-black',
        error:   'bg-red-500 text-white',
        info:    'bg-[#FFD700] text-black'
    };
    
    toast.className += ' ' + (colors[type] || colors.info);
    toast.textContent = msg;
    
    document.body.appendChild(toast);
    
    // Animar entrada
    setTimeout(() => {
        toast.classList.remove('translate-y-10', 'opacity-0');
    }, 100);
    
    // Salida
    setTimeout(() => {
        toast.classList.add('translate-y-10', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
