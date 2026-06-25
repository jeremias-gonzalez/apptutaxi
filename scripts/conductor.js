// ============================================================
//  TUTAXI — conductor.js
//  Lógica completa del panel de conductor
// ============================================================

// ENV se carga desde supabase/env.js (debe ir antes en el HTML)
mapboxgl.accessToken = ENV.MAPBOX_TOKEN;

// Estado global
let conductorId       = null;
let viajeActualId     = null;
let viajeEnCursoData  = null;
let viajeSiguiente    = null;
let realtimeCanal     = null;
let timerInterval     = null;
let timerSeconds      = 20;
let disponible        = false;
let gpsWatchId        = null;
let viajeEntrante     = null;
let heartbeatInterval = null; // ← Mejora 1: presencia online

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
    detenerHeartbeat();                          // ← Mejora 1
    if (realtimeCanal) db.removeChannel(realtimeCanal);
    if (window.pollingViajes) clearInterval(window.pollingViajes);
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

        // Mostrar nombre en header
        const nombreEl = document.getElementById('conductor-nombre');
        if (nombreEl) nombreEl.textContent = perfil.nombre || '';
        
        await cargarViajeActivo();
        await cargarHistorialHoy();
        showToast(`Bienvenido, ${perfil.nombre || 'conductor'} 👋`, 'success');
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
        dot.style.backgroundColor = '#22c55e';
        text.textContent = 'Disponible — esperando viajes...';
        iniciarHeartbeat();   // ← Mejora 1
        suscribirViajes();
        iniciarGPS();
    } else {
        dot.style.backgroundColor = '#4b5563';
        text.textContent = 'Desconectado — activá disponibilidad para recibir viajes';
        detenerHeartbeat();   // ← Mejora 1
        if (realtimeCanal) { db.removeChannel(realtimeCanal); realtimeCanal = null; }
        if (window.pollingViajes) clearInterval(window.pollingViajes);
        detenerGPS();
    }

    // Persistir en base de datos
    try {
        const { error } = await db.from('conductores')
            .update({ 
                disponible: disponible, 
                activo: disponible,
                updated_at: new Date().toISOString()
            })
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
    
    const actualizarPos = async (pos) => {
        const { latitude: lat, longitude: lng, heading } = pos.coords;
        posActual = { lat, lng };
        rumbo = heading || rumbo;
        
        if (!conductorId) return;
        
        const { error } = await db.from('conductores')
            .update({ lat, lng, activo: true, updated_at: new Date().toISOString() })
            .eq('id', conductorId);
            
        if (error) console.error('Error GPS DB:', error.message);
    };

    // Primera lectura inmediata
    navigator.geolocation.getCurrentPosition(actualizarPos, () => {}, { enableHighAccuracy: true });

    // Watcher único de fondo
    gpsWatchId = navigator.geolocation.watchPosition(
        actualizarPos,
        (err) => {
            if (err.code === 1) showToast('Por favor, activá el GPS', 'error');
            else console.warn('GPS Error:', err.message);
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
}


function detenerGPS() {
    if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
}

// ══════════════════════════════════════════
//  HEARTBEAT DE PRESENCIA (Mejora 1)
// ══════════════════════════════════════════
function iniciarHeartbeat() {
    detenerHeartbeat();
    heartbeatInterval = setInterval(async () => {
        if (!conductorId || !disponible) return;
        await db.from('conductores')
            .update({ updated_at: new Date().toISOString(), activo: true })
            .eq('id', conductorId);
    }, 20000);
}

function detenerHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ══════════════════════════════════════════
//  REALTIME — NUEVOS VIAJES
// ══════════════════════════════════════════
function suscribirViajes() {
    if (realtimeCanal) db.removeChannel(realtimeCanal);

    realtimeCanal = db.channel('conductor-viajes-general')
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'viajes' },
            (payload) => {
                const v = payload.new;
                if (v.estado === 'pendiente') {
                    mostrarAlerta(v);
                }
            })
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'viajes' },
            (payload) => {
                const v = payload.new;
                
                if ((v.estado === 'notificado' && v.conductor_id === conductorId) || v.estado === 'pendiente') {
                    if (!viajeEntrante || viajeEntrante.id !== v.id) {
                        mostrarAlerta(v);
                    }
                }
                
                if (v.estado === 'cancelado' && (viajeEntrante?.id === v.id || viajeActualId === v.id || viajeSiguiente?.id === v.id)) {
                    detenerNavegacion();
                    cerrarAlerta();
                    if (viajeActualId === v.id) {
                        viajeActualId = null;
                        viajeEnCursoData = null;
                        document.getElementById('viaje-activo').style.display = 'none';
                        mostrarPantalla('screen-app');
                    }
                    if (viajeSiguiente?.id === v.id) {
                        viajeSiguiente = null;
                    }
                    showToast('El viaje fue cancelado por el pasajero', 'error');
                }
            })
        .subscribe(async (status) => {
            console.log('📡 Realtime status:', status);
            if (status === 'SUBSCRIBED') {
                await buscarViajesExistentes();
            }
            // Mejora 2: Reconexión automática si el canal se cae
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                console.warn('⚠️ Canal Realtime caído. Reconectando en 5s...');
                setTimeout(() => { if (disponible) suscribirViajes(); }, 5000);
            }
        });

    if (window.pollingViajes) clearInterval(window.pollingViajes);
    window.pollingViajes = setInterval(() => {
        if (disponible) {
            buscarViajesExistentes();
        }
    }, 15000);
}

async function buscarViajesExistentes() {
    if (!disponible) return;

    try {
        let { data: viajes } = await db.from('viajes')
            .select('*')
            .eq('conductor_id', conductorId)
            .eq('estado', 'notificado')
            .limit(1);

        if (!viajes || viajes.length === 0) {
            const resp = await db.from('viajes')
                .select('*')
                .eq('estado', 'pendiente')
                .is('conductor_id', null)
                .limit(1);
            viajes = resp.data;
        }

        if (viajes && viajes.length > 0) {
            mostrarAlerta(viajes[0]);
        }
    } catch (err) {
        console.error('Error:', err);
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
    
    // GUARDAR COPIA DEL VIAJE antes de limpiar la alerta
    const viajeAceptado = { ...viajeEntrante }; 
    
    clearInterval(timerInterval);
    const viajeId = viajeAceptado.id;
    cerrarAlerta(); // Esto limpia viajeEntrante, pero ya tenemos copia

    // Buscar el estado real en la base de datos ahora mismo
    const { data: currentViaje, error: selError } = await db.from('viajes').select('estado, conductor_id').eq('id', viajeId).single();
    
    if (selError || !currentViaje || currentViaje.estado === 'cancelado' || currentViaje.estado === 'completado' || currentViaje.estado === 'en_curso') {
        showToast('El viaje ya no está disponible.', 'error');
        return;
    }
    
    // Si ya lo tiene otro chofer asignado (no nulo y distinto a mi id)
    if (currentViaje.conductor_id && currentViaje.conductor_id !== conductorId) {
        showToast('El viaje ya fue tomado por otro conductor.', 'error');
        return;
    }

    // Actualizar directamente de forma segura
    const { error: updError } = await db.from('viajes').update({
        estado: 'en_curso',
        conductor_id: conductorId,
        aceptado_at: new Date().toISOString()
    }).eq('id', viajeId);

    if (updError) { 
        console.error("Detalle del error de update:", updError);
        showToast('Error: ' + updError.message, 'error'); 
        return; 
    }

    // Usar la copia preservada para el estado local
    const viajeActualizado = { ...viajeAceptado, estado: 'en_curso', conductor_id: conductorId };

    if (viajeActualId) {
        viajeSiguiente = viajeActualizado;
        showToast('Viaje encolado. Al finalizar el actual, comenzarás este.', 'success');
    } else {
        viajeActualId = viajeId;
        viajeEnCursoData = viajeActualizado;
        mostrarViajeActivo(viajeEnCursoData);
        await cargarHistorialHoy();
        iniciarProcesoNavegacion(viajeEnCursoData);
    }
}

async function rechazarViaje() {
    // Guardar referencia ANTES de cerrarAlerta (que lo nullea)
    const viajeRechazado = viajeEntrante;
    cerrarAlerta();
    if (!viajeRechazado) return;

    // Volver a pendiente para que el algoritmo intente con otro conductor
    const { error } = await db.from('viajes').update({
        estado: 'pendiente',
        conductor_id: null
    }).eq('id', viajeRechazado.id).eq('conductor_id', conductorId);

    if (!error) console.log('✅ Viaje devuelto al pool');
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
    // Ocultar estado de espera
    const espera = document.getElementById('estado-espera');
    if (espera) espera.style.display = 'none';
}

async function cargarViajeActivo() {
    if (!conductorId) return;
    const { data } = await db.from('viajes')
        .select('*').eq('conductor_id', conductorId).eq('estado', 'en_curso').maybeSingle();
    if (data) {
        viajeActualId    = data.id;
        viajeEnCursoData = data;   // ← Mejora 3: restaurar contexto completo
        mostrarViajeActivo(data);
        showToast('Viaje en curso recuperado 🔄', 'info');
    }
}

async function completarViaje() {
    if (!viajeActualId) return;
    await db.from('viajes').update({
        estado: 'completado',
        completado_at: new Date().toISOString()
    }).eq('id', viajeActualId);

    document.getElementById('viaje-activo').style.display = 'none';

    if (viajeSiguiente) {
        showToast('Viaje anterior completado. Iniciando viaje encolado.', 'success');
        const vSig = viajeSiguiente;
        viajeSiguiente = null;
        viajeActualId = vSig.id;
        viajeEnCursoData = vSig;
        mostrarViajeActivo(vSig);
        iniciarProcesoNavegacion(vSig);
        await cargarHistorialHoy();
        return;
    }

    viajeActualId = null; 
    viajeEnCursoData = null;
    const espera = document.getElementById('estado-espera');
    if (espera) espera.style.display = 'flex';
    
    detenerNavegacion();
    mostrarPantalla('screen-app');
    showToast('¡Viaje completado! Listo para el próximo.', 'success');
    await cargarHistorialHoy();
}

async function cancelarViajeConductor() {
    if (!viajeActualId) return;
    await db.from('viajes').update({ estado: 'pendiente', conductor_id: null }).eq('id', viajeActualId);
    
    detenerNavegacion();
    document.getElementById('viaje-activo').style.display = 'none';
    const espera = document.getElementById('estado-espera');
    if (espera) espera.style.display = 'flex';
    
    viajeActualId = null; 
    viajeEnCursoData = null;
    
    if (viajeSiguiente) {
        showToast('Viaje cancelado. Iniciando viaje encolado.', 'info');
        const vSig = viajeSiguiente;
        viajeSiguiente = null;
        viajeActualId = vSig.id;
        viajeEnCursoData = vSig;
        mostrarViajeActivo(vSig);
        iniciarProcesoNavegacion(vSig);
        return;
    }

    mostrarPantalla('screen-app');
    showToast('Viaje cancelado. Devuelto a pendientes.', 'info');
    await cargarHistorialHoy();
}

function hablar(texto) {
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(texto);
        utterance.lang = 'es-AR';
        window.speechSynthesis.speak(utterance);
    }
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

    // Resumen del día (si el elemento existe)
    const resumenEl = document.getElementById('resumen-hoy');
    if (resumenEl && data?.length > 0) {
        const completados = data.filter(v => v.estado === 'completado');
        resumenEl.textContent = `${completados.length} viaje${completados.length !== 1 ? 's' : ''} completado${completados.length !== 1 ? 's' : ''}`;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `<div class="text-center py-8 text-gray-600 text-sm font-medium"><i class="fas fa-route text-2xl opacity-20 block mb-2"></i>Sin viajes todavía</div>`;
        return;
    }

    // Mejora 6: Historial con hora + badge de estado visual
    container.innerHTML = data.map(v => {
        const hora = new Date(v.created_at).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
        const badge = v.estado === 'completado'
            ? `<span class="hi-badge hi-badge--ok">✓ Completado</span>`
            : v.estado === 'cancelado'
            ? `<span class="hi-badge hi-badge--cancel">✗ Cancelado</span>`
            : `<span class="hi-badge hi-badge--curso">● En curso</span>`;
        return `
        <div class="historial-item">
            <div class="hi-route">
                <div class="hi-hora-estado"><span class="hi-hora">${hora}</span>${badge}</div>
                <div class="hi-addr">${(v.origen_texto||'').split(',')[0]} → ${(v.destino_texto||'').split(',')[0]}</div>
                <div class="hi-sub">${v.distancia_km ? Number(v.distancia_km).toFixed(1)+' km' : '—'}</div>
            </div>
            <div class="hi-price">${fmt(v.precio_estimado)}</div>
        </div>`;
    }).join('');
}

// ══════════════════════════════════════════
//  NAVEGACIÓN — TRANSICIÓN DE VISTAS
// ══════════════════════════════════════════
function iniciarProcesoNavegacion(viaje) {
    mostrarPantalla('screen-nav');
    
    const btnComenzar = document.getElementById('btn-comenzar-nav');
    const btnFinalizar = document.getElementById('btn-finalizar-nav');
    if (btnComenzar) btnComenzar.classList.remove('hidden');
    if (btnFinalizar) btnFinalizar.classList.add('hidden');

    document.getElementById('nav-destino-addr').textContent = 'A buscar pasajero: ' + (viaje.origen_texto || 'Pasajero');
    
    // Resetear distancia para la nueva etapa
    distanciaTotal = 0;
    ultimaRuta = 0;

    iniciarNavegacion();
    showToast('Navegando al punto de encuentro', 'info');
    hablar('Navegando a la dirección de inicio');

    // Trazar ruta al origen del pasajero una vez que el mapa esté listo
    setTimeout(() => {
        trazarRutaNavegacion(viaje.origen_lat, viaje.origen_lng, 'Recoger Pasajero');
    }, 1800);
}

// Traza la ruta de navegacion hacia un destino especifico
function trazarRutaNavegacion(destLat, destLng, etiqueta) {
    if (posActual) {
        // Posicion GPS ya disponible: trazar de inmediato
        calcularRutaNavegacion(posActual.lng, posActual.lat, destLng, destLat);
    } else {
        // GPS aun no disponible: reintentar hasta 10 veces (5 segundos)
        let intentos = 0;
        const retry = setInterval(() => {
            intentos++;
            if (posActual) {
                clearInterval(retry);
                calcularRutaNavegacion(posActual.lng, posActual.lat, destLng, destLat);
            } else if (intentos >= 10) {
                clearInterval(retry);
                showToast('No se pudo obtener GPS. Activá la ubicación.', 'error');
            }
        }, 500);
    }
}

async function confirmarPasajeroABordo() {
    if (!viajeEnCursoData) return;
    
    showToast('Iniciando viaje al destino', 'success');
    hablar('Viaje iniciado. Navegando al destino');
    
    document.getElementById('nav-destino-addr').textContent = 'Destino Final: ' + (viajeEnCursoData.destino_texto || 'Final');

    const btnComenzar = document.getElementById('btn-comenzar-nav');
    const btnFinalizar = document.getElementById('btn-finalizar-nav');
    if (btnComenzar) btnComenzar.classList.add('hidden');
    if (btnFinalizar) btnFinalizar.classList.remove('hidden');

    // Resetear distancia para la nueva etapa (pasajero → destino)
    distanciaTotal = 0;
    ultimaRuta = 0;

    await db.from('viajes').update({ estado: 'en_curso' }).eq('id', viajeActualId);

    trazarRutaNavegacion(viajeEnCursoData.destino_lat, viajeEnCursoData.destino_lng, 'Destino Final');
}

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

// Mejora 7: Estilo del mapa según hora del día
function esNoche() {
    const h = new Date().getHours();
    return h >= 20 || h < 7;
}

function iniciarNavegacion() {
    // Centrar en posicion actual del conductor o fallback a Río Cuarto
    const centerLng = posActual ? posActual.lng : -64.35;
    const centerLat = posActual ? posActual.lat : -33.12;

    if (!navMap) {
        navMap = new mapboxgl.Map({
            container: 'nav-map',
            style: esNoche()
                ? 'mapbox://styles/mapbox/navigation-night-v1'
                : 'mapbox://styles/mapbox/navigation-day-v1',
            zoom: 16, pitch: 60, bearing: 0,
            center: [centerLng, centerLat]
        });
        navMap.on('touchstart', () => {
            siguiendo = false;
            document.getElementById('btn-centrar').classList.remove('active-btn');
        });
        navMap.on('load', () => {
            iniciarGPSNavegacion();
            showToast('GPS activado — navegando 🗺️', 'info');
        });
    } else {
        navMap.resize();
        navMap.easeTo({ center: [centerLng, centerLat], zoom: 16, pitch: 60, duration: 600 });
        iniciarGPSNavegacion();
    }
}

function detenerNavegacion() {
    // Limpiar watcher de navegación
    if (navGpsWatch !== null) { navigator.geolocation.clearWatch(navGpsWatch); navGpsWatch = null; }
    if (conductorMarker) { try { conductorMarker.remove(); } catch(e) {} conductorMarker = null; }
    if (navMap) { try { navMap.remove(); } catch(e) {} navMap = null; }
    distanciaTotal = 0;
    ultimaRuta = 0;
    // Restaurar GPS de fondo
    if (disponible) iniciarGPS();
}

function agregarMarcadorDestino(lng, lat) {
    const el = document.createElement('div');
    el.style.cssText = 'width:34px;height:34px;background:#FFD700;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;box-shadow:0 4px 16px rgba(255,215,0,0.5)';
    el.textContent = '🏁';
    new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(navMap);
}

function iniciarGPSNavegacion() {
    if (!navigator.geolocation) return;

    // Pausar el GPS de fondo para evitar dos watchers compitiendo
    // (causa Timeout en móviles)
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    if (navGpsWatch !== null) {
        navigator.geolocation.clearWatch(navGpsWatch);
        navGpsWatch = null;
    }

    let ultimoUpdate = 0;

    const onPos = async (pos) => {
        const { latitude: lat, longitude: lng, speed, heading } = pos.coords;
        velocidad = speed ? Math.round(speed * 3.6) : 0;
        rumbo     = heading || rumbo;
        posActual = { lat, lng };

        document.getElementById('nav-vel').textContent = velocidad || '—';
        actualizarMarcadorConductor(lng, lat, rumbo);

        const ahora = Date.now();
        // Actualizar DB cada 4 segundos (no en cada frame)
        if (conductorId && (ahora - ultimoUpdate) > 4000) {
            ultimoUpdate = ahora;
            await db.from('conductores')
                .update({ lat, lng, updated_at: new Date().toISOString() })
                .eq('id', conductorId);
        }
        // Recalcular ruta cada 25 segundos
        if (!ultimaRuta || (ahora - ultimaRuta) > 25000) {
            ultimaRuta = ahora;
            await calcularRutaNavegacion(lng, lat);
        }
    };

    const onErr = (err) => {
        console.warn('GPS nav error:', err.message);
        if (err.code === 1) {
            showToast('Permiso de GPS denegado. Activá la ubicación.', 'error');
            return;
        }
        // Timeout (3) o posición no disponible (2): reintentar con baja precisión
        if (err.code === 2 || err.code === 3) {
            console.log('Reintentando GPS con baja precisión...');
            navigator.geolocation.clearWatch(navGpsWatch);
            navGpsWatch = navigator.geolocation.watchPosition(
                onPos, 
                (e2) => console.warn('GPS baja precisión fallida:', e2.message),
                { enableHighAccuracy: false, maximumAge: 15000, timeout: 30000 }
            );
        }
    };

    navGpsWatch = navigator.geolocation.watchPosition(
        onPos, onErr,
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
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

async function calcularRutaNavegacion(origenLng, origenLat, dLng, dLat) {
    let destLat = dLat;
    let destLng = dLng;
    
    // Si no se proveen, determinamos a donde estamos yendo (origen o destino)
    if (!destLat || !destLng) {
        const btnComenzar = document.getElementById('btn-comenzar-nav');
        if (btnComenzar && !btnComenzar.classList.contains('hidden')) {
            destLat = viajeEnCursoData?.origen_lat;
            destLng = viajeEnCursoData?.origen_lng;
        } else {
            destLat = viajeEnCursoData?.destino_lat;
            destLng = viajeEnCursoData?.destino_lng;
        }
    }
    
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

function trazarRutaNavegacion(destLat, destLng, etiqueta) {
    // Nota: Esta función ahora se define antes de confirmarPasajeroABordo (linea ~590)
    // Esta declaracion al final es solo para claridad, la real esta arriba.
    if (posActual) {
        calcularRutaNavegacion(posActual.lng, posActual.lat, destLng, destLat);
    }
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

// Sugerencias removidas según requerimiento

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
    
    setTimeout(() => {
        toast.classList.remove('translate-y-10', 'opacity-0');
    }, 100);
    
    setTimeout(() => {
        toast.classList.add('translate-y-10', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ══════════════════════════════════════════
//  PANEL DE VIAJES PENDIENTES (Manual)
// ══════════════════════════════════════════
let viajePendienteSeleccionado = null;

function abrirPanelPendientes() {
    const panel = document.getElementById('panel-pendientes');
    panel.classList.remove('hidden');
    panel.classList.add('flex');
    cargarViajesPendientes();
}

function cerrarPanelPendientes(event) {
    // Si se llamó desde onclick del backdrop o directo, cerrar
    if (event && event.target !== document.getElementById('panel-pendientes')) return;
    const panel = document.getElementById('panel-pendientes');
    panel.classList.add('hidden');
    panel.classList.remove('flex');
}

async function cargarViajesPendientes() {
    const lista = document.getElementById('pendientes-lista');
    const count = document.getElementById('pendientes-count');
    
    lista.innerHTML = `<div class="text-center py-10 text-gray-700">
        <i class="fas fa-spinner fa-spin text-2xl mb-3 block"></i>
        <p class="text-xs font-medium">Buscando viajes...</p>
    </div>`;
    count.textContent = 'Cargando...';

    try {
        const { data: viajes, error } = await db.from('viajes')
            .select('*')
            .in('estado', ['pendiente', 'notificado'])
            .is('conductor_id', null)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        if (!viajes || viajes.length === 0) {
            count.textContent = 'Sin viajes disponibles';
            lista.innerHTML = `<div class="text-center py-14 text-gray-700">
                <i class="fas fa-car text-3xl opacity-20 block mb-3"></i>
                <p class="text-sm font-medium">No hay viajes pendientes</p>
                <p class="text-[10px] text-gray-600 mt-1">Actualizá en unos segundos</p>
            </div>`;
            return;
        }

        count.textContent = `${viajes.length} viaje${viajes.length !== 1 ? 's' : ''} disponible${viajes.length !== 1 ? 's' : ''}`;

        const fmt = (n) => Number(n).toLocaleString('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });

        lista.innerHTML = viajes.map((v, i) => `
        <div onclick="seleccionarViajeManual(${i})" data-idx="${i}"
            class="bg-[#111] border border-white/7 rounded-2xl p-4 cursor-pointer active:scale-[0.98] transition-all hover:border-gold/30">
            <div class="flex items-center justify-between mb-3">
                <span class="text-gold text-xl font-black">${fmt(v.precio_estimado)}</span>
                <span class="text-[10px] font-bold text-gray-500 bg-white/5 px-2 py-1 rounded-full">
                    ${v.distancia_km ? Number(v.distancia_km).toFixed(1) + ' km' : '—'}
                </span>
            </div>
            <div class="space-y-2">
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 rounded-full bg-white flex-shrink-0"></div>
                    <p class="text-xs font-medium text-white/70 truncate">${(v.origen_texto||'—').split(',')[0]}</p>
                </div>
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 bg-gold flex-shrink-0"></div>
                    <p class="text-xs font-bold text-white truncate">${(v.destino_texto||'—').split(',')[0]}</p>
                </div>
            </div>
        </div>`).join('');

        // Guardar viajes en memoria para acceder por índice
        window._viajesPendientesCache = viajes;

    } catch (err) {
        console.error('Error cargando pendientes:', err);
        count.textContent = 'Error al cargar';
        lista.innerHTML = `<div class="text-center py-10 text-red-500/60 text-sm">Error al conectar</div>`;
    }
}

function seleccionarViajeManual(idx) {
    const viajes = window._viajesPendientesCache;
    if (!viajes || !viajes[idx]) return;

    viajePendienteSeleccionado = viajes[idx];
    const v = viajePendienteSeleccionado;
    const fmt = (n) => Number(n).toLocaleString('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });

    document.getElementById('mpc-precio').textContent  = fmt(v.precio_estimado);
    document.getElementById('mpc-dist').textContent    = v.distancia_km ? Number(v.distancia_km).toFixed(1) + ' km' : '—';
    document.getElementById('mpc-origen').textContent  = v.origen_texto  || '—';
    document.getElementById('mpc-destino').textContent = v.destino_texto || '—';

    document.getElementById('modal-pendiente-confirm').classList.remove('hidden');
}

async function aceptarViajeManual() {
    if (!viajePendienteSeleccionado) return;
    
    // Cerrar ambos paneles
    document.getElementById('modal-pendiente-confirm').classList.add('hidden');
    const panel = document.getElementById('panel-pendientes');
    panel.classList.add('hidden');
    panel.classList.remove('flex');

    // Reutilizar el flujo de aceptación existente
    viajeEntrante = viajePendienteSeleccionado;
    viajePendienteSeleccionado = null;
    await aceptarViaje();
}

function rechazarViajeManual() {
    viajePendienteSeleccionado = null;
    document.getElementById('modal-pendiente-confirm').classList.add('hidden');
    showToast('Viaje ignorado', 'info');
}