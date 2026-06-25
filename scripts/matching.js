// ── Estado de Matching ──
let conductoresConsultados = []; // IDs de choferes que ya rechazaron o ignoraron
let matchingInterval = null;

// ── SOLICITAR VIAJE (llama al algoritmo) ─────────────────────
async function solicitarViaje() {
    // 1. Validaciones preventivas
    if (!db) { showToast('Sin conexión', 'error'); return; }
    if (viajeActivoId) { 
        showToast('Ya tienes un viaje en curso', 'warning'); 
        return; 
    }

    const btnSolicitar = document.getElementById('btn-solicitar');
    btnSolicitar.disabled = true;
    btnSolicitar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';

    try {
        const { data: viaje, error } = await db.from('viajes').insert({
            origen_texto:    document.getElementById('input-origen').value || 'Sin especificar',
            destino_texto:   document.getElementById('input-destino').value || 'Sin especificar',
            origen_lat:      ultimasCoordenadas?.origen?.lat,
            origen_lng:      ultimasCoordenadas?.origen?.lng,
            destino_lat:     ultimasCoordenadas?.destino?.lat,
            destino_lng:     ultimasCoordenadas?.destino?.lng,
            distancia_km:    distanciaCalculada,
            precio_estimado: obtenerPrecioActual(),
            tarifa_tipo:     esNocheAhora() ? 'noche' : 'dia',
            estado:          'pendiente',
            pasajero_token:  Math.random().toString(36).substring(2, 10).toUpperCase()
        }).select().single();

        if (error) throw error;

        // 2. Éxito: Bloquear estado global
        viajeActivoId = viaje.id;
        conductoresConsultados = [];
        
        mostrarPanelSeguimiento();
        escucharEstadoViaje(viaje.id);
        buscarSiguienteConductor(viaje);

    } catch (err) {
        console.error("Error en solicitud:", err);
        btnSolicitar.disabled = false;
        btnSolicitar.innerHTML = '<i class="fas fa-taxi"></i> SOLICITAR TAXI AHORA';
        showToast('Error al solicitar. Intente de nuevo.', 'error');
    }
}


// ── ALGORITMO DE MATCHING INTELIGENTE (Chain Logic) ──────────
async function buscarSiguienteConductor(viaje) {
    if (!viajeActivoId || viajeActivoId !== viaje.id) return;

    console.log('🔍 Iniciando búsqueda de chofer para el viaje:', viaje.id);
    
    try {
        // 1. Obtener todos los conductores ONLINE
        const { data: todos, error } = await db.from('conductores')
            .select('*')
            .eq('disponible', true)
            .eq('activo', true)
            .not('lat', 'is', null);

        if (error || !todos) throw error || new Error('No hay conductores online');

        // 2. Obtener viajes activos para saber quién está ocupado
        const { data: viajesActivos } = await db.from('viajes')
            .select('conductor_id, destino_lat, destino_lng')
            .eq('estado', 'en_curso');

        const ocupadosIds = (viajesActivos || []).map(v => v.conductor_id);

        // 3. Clasificar conductores según reglas (Libres vs Ocupados finalizando)
        let candidatos = [];

        for (let c of todos) {
            if (conductoresConsultados.includes(c.id)) continue;

            const esOcupado = ocupadosIds.includes(c.id);
            const distAlOrigen = haversineKm(c.lat, c.lng, viaje.origen_lat, viaje.origen_lng);

            if (!esOcupado) {
                // REGLA 1 & 4: Chofer libre (Prioridad Alta)
                candidatos.push({ ...c, prioridad: 1, distancia: distAlOrigen });
            } else {
                // REGLA 5 & 7: Chofer ocupado. Solo si está finalizando.
                const viajeActual = viajesActivos.find(v => v.conductor_id === c.id);
                const distADestinoActual = haversineKm(c.lat, c.lng, viajeActual.destino_lat, viajeActual.destino_lng);

                if (distADestinoActual < 1.5) { // 1.5km = "Finalizando"
                    // Prioridad Baja (2) pero califica
                    candidatos.push({ ...c, prioridad: 2, distancia: distAlOrigen });
                }
            }
        }

        // 4. Ordenar: Primero prioridad (1 antes que 2), luego distancia
        candidatos.sort((a, b) => a.prioridad - b.prioridad || a.distancia - b.distancia);

        if (candidatos.length === 0) {
            console.log('⏳ Sin candidatos disponibles. Reintentando en 10s...');
            document.getElementById('seg-estado-texto').textContent = 'Buscando conductores disponibles...';
            setTimeout(() => buscarSiguienteConductor(viaje), 10000);
            return;
        }

        // 5. Notificar al mejor candidato (CADENA)
        const mejor = candidatos[0];
        console.log('👉 Notificando al chofer:', mejor.nombre, '(Prioridad:', mejor.prioridad, ')');
        
        conductoresConsultados.push(mejor.id);
        
        await db.from('viajes').update({ 
            estado: 'notificado', 
            conductor_id: mejor.id 
        }).eq('id', viaje.id);

        // 6. Timer de espera (si no acepta en 22s, pasamos al siguiente)
        if (matchingInterval) clearTimeout(matchingInterval);
        matchingInterval = setTimeout(() => {
            verificarSiSaltearConductor(viaje.id);
        }, 22000);

    } catch(e) {
        console.error('Error en algoritmo:', e);
        setTimeout(() => buscarSiguienteConductor(viaje), 10000);
    }
}

async function verificarSiSaltearConductor(viajeId) {
    if (!viajeActivoId || viajeActivoId !== viajeId) return;

    const { data: v } = await db.from('viajes').select('estado').eq('id', viajeId).single();
    if (v && v.estado === 'notificado') {
        console.log('⏰ Tiempo de espera agotado para el chofer. Buscando siguiente...');
        // Resetear viaje a pendiente para que el loop lo tome de nuevo
        await db.from('viajes').update({ estado: 'pendiente', conductor_id: null }).eq('id', viajeId);
        // El listener de Realtime detectará el cambio a 'pendiente' y llamará a buscarSiguienteConductor
    }
}



// ── PANEL SEGUIMIENTO ─────────────────────────────────────────
function mostrarPanelSeguimiento() {
    document.getElementById('panel-seguimiento').classList.add('visible');
    document.getElementById('seg-estado-texto').textContent = 'Buscando conductor...';
    document.getElementById('seg-conductor-info').style.display = 'none';
    const dot = document.querySelector('.seg-dot');
    if (dot) { dot.className = 'seg-dot buscando'; }
}

// ── CONTROL DE CANCELACIÓN CON MODAL ─────────────────────────
function abrirModalCancelar() {
    document.getElementById('modal-confirmar-cancelar').classList.add('visible');
}

function cerrarModalCancelar() {
    document.getElementById('modal-confirmar-cancelar').classList.remove('visible');
}

async function confirmarCancelacionReal() {
    cerrarModalCancelar();
    if (!viajeActivoId) return;

    try {
        await db.from('viajes').update({ estado: 'cancelado' }).eq('id', viajeActivoId);
    } catch (e) {
        console.error('Error al cancelar:', e);
    }

    cancelarSeguimientoSilencioso();
    showToast('Búsqueda cancelada.', 'info');

    // Volver al panel de resultados (no al formulario), para que el usuario
    // pueda volver a solicitar el mismo viaje u otro sin tener que recalcular
    document.getElementById('panel-seguimiento').classList.remove('visible');
    document.getElementById('panel-resultados').classList.add('visible');
    document.getElementById('panel-resultados-content').classList.remove('hidden');
    document.getElementById('results-skeleton').classList.add('hidden');

    const btnSolicitar = document.getElementById('btn-solicitar');
    if (btnSolicitar) {
        btnSolicitar.style.display = 'flex';
        btnSolicitar.disabled = false;
        btnSolicitar.innerHTML = '<i class="fas fa-taxi"></i> SOLICITAR AHORA';
    }
}

function resetAppTotal() {
    // 1. Cerrar el modal de éxito
    const modalExito = document.getElementById('modal-exito');
    if (modalExito) modalExito.classList.remove('visible');
    
    // 2. Limpiar estado del seguimiento
    cancelarSeguimientoSilencioso();

    // 3. Limpiar inputs y coordenadas
    const inputOrigen  = document.getElementById('input-origen');
    const inputDestino = document.getElementById('input-destino');
    if (inputOrigen)  { inputOrigen.value  = ''; inputOrigen.removeAttribute('data-coord'); }
    if (inputDestino) { inputDestino.value = ''; inputDestino.removeAttribute('data-coord'); }

    // 4. Resetear variables globales
    distanciaCalculada = 0;
    ultimasCoordenadas = { origen: null, destino: null };
    coordOrigen = null;
    coordDestino = null;

    // 5. Volver al formulario limpio
    volverAlFormulario();

    // 6. Re-detectar ubicación GPS
    obtenerUbicacionActual();
}

function cancelarSeguimientoSilencioso() {
    if (matchingInterval) clearTimeout(matchingInterval);
    if (typeof realtimeViaje !== 'undefined' && realtimeViaje) {
        db?.removeChannel(realtimeViaje); realtimeViaje = null;
    }
    clearInterval(trackingInterval);
    if (taxiMarker) { taxiMarker.remove(); taxiMarker = null; }

    if (map && map.getLayer('ruta-taxi-linea'))  map.removeLayer('ruta-taxi-linea');
    if (map && map.getLayer('ruta-taxi-sombra')) map.removeLayer('ruta-taxi-sombra');
    if (map && map.getSource('ruta-taxi'))       map.removeSource('ruta-taxi');

    // Resetear variables del tracking del taxi y notificaciones
    if (typeof ultimaPosTaxi !== 'undefined') ultimaPosTaxi = null;
    if (typeof notificadoCerca !== 'undefined') notificadoCerca = false;
    if (typeof notificadoPuerta !== 'undefined') notificadoPuerta = false;

    viajeActivoId = null;
    document.getElementById('panel-seguimiento').classList.remove('visible');
   
}




let estadoViajeActual = 'pendiente';

// ── ESCUCHAR ESTADO DEL VIAJE ─────────────────────────────────
function escucharEstadoViaje(viajeId) {
    if (!db) return;
    if (typeof realtimeViaje !== 'undefined' && realtimeViaje) db.removeChannel(realtimeViaje);

    // Solicitar permiso para notificaciones fuera de la app
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    realtimeViaje = db
        .channel('viaje-pasajero-' + viajeId)
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'viajes', filter: `id=eq.${viajeId}` },
            async (payload) => {
                const v = payload.new;
                const txtEstado = document.getElementById('seg-estado-texto');
                const dot = document.querySelector('.seg-dot');
                estadoViajeActual = v.estado;

                if (v.estado === 'notificado') {
                    txtEstado.textContent = 'Un chofer está viendo tu solicitud...';
                    if (dot) dot.className = 'seg-dot notificado'; 
                } else if (v.estado === 'aceptado') {
                    if (matchingInterval) clearTimeout(matchingInterval);
                    viajeAceptado(v); // Chofer en camino al origen
                } else if (v.estado === 'en_curso') {
                    txtEstado.textContent = '¡Viaje en curso! Yendo al destino...';
                    if (dot) dot.className = 'seg-dot en-curso';
                    showToast('🚕 ¡Pasajero a bordo! Iniciando recorrido.', 'success');
                    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
                    
                    // Asegurar que el tracking sepa que cambió la fase para la ruta
                    iniciarTrackingConductor(v.conductor_id); 
                } else if (v.estado === 'completado') {
                    viajeCompletado();
                } else if (v.estado === 'cancelado' || v.estado === 'pendiente') {
                    if (matchingInterval) clearTimeout(matchingInterval);
                    showToast('Buscando otro conductor disponible...', 'info');
                    txtEstado.textContent = 'Reintentando búsqueda...';
                    if (dot) dot.className = 'seg-dot buscando';
                    
                    const { data: vFull } = await db.from('viajes').select('*').eq('id', viajeId).single();
                    buscarSiguienteConductor(vFull);
                }
            })
        .subscribe();
}

// ── REINTENTO automático si conductor rechaza ─────────────────
async function reintentar(viajeId) {
    // Volver a estado pendiente
    await db.from('viajes').update({ estado: 'pendiente', conductor_id: null }).eq('id', viajeId);
    // Llamar al algoritmo de nuevo
    try {
        await fetch(`${ENV.SUPABASE_URL}/functions/v1/smooth-action`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${ENV.SUPABASE_ANON_KEY}` 
            },
            body: JSON.stringify({ viaje_id: viajeId })
        });
    } catch(e) { console.warn('Reintento fallido:', e); }





}

// ── VIAJE ACEPTADO ────────────────────────────────────────────
async function viajeAceptado(viaje) {
    document.getElementById('seg-estado-texto').textContent = '¡Conductor en camino!';
    const dot = document.querySelector('.seg-dot');
    if (dot) dot.className = 'seg-dot aceptado';

    // LIMPIEZA: Quitar icono de auto cercano para evitar duplicados
    if (typeof desuscribirConductoresCercanos === 'function') {
        desuscribirConductoresCercanos();
    }

    if (viaje.conductor_id) {
        const { data: conductor } = await db
            .from('conductores').select('nombre, patente').eq('id', viaje.conductor_id).single();
        if (conductor) {
            document.getElementById('seg-nombre').textContent  = conductor.nombre  || 'Tu conductor';
            document.getElementById('seg-patente').textContent = conductor.patente || 'En camino';
        }
        document.getElementById('seg-conductor-info').style.display = 'flex';
        iniciarTrackingConductor(viaje.conductor_id);
    }

    if ('vibrate' in navigator) navigator.vibrate([100, 50, 100]);
    showToast('¡Conductor aceptó tu viaje!', 'success');
}

function viajeCompletado() {
    if (matchingInterval) clearTimeout(matchingInterval);
    
    const modalExito = document.getElementById('modal-exito');
    if (modalExito) modalExito.classList.add('visible');
    
    if ('vibrate' in navigator) navigator.vibrate([100, 50, 100]);
    
    // Limpiar rastro de seguimiento pero mantener el modal abierto
    if (typeof realtimeViaje !== 'undefined' && realtimeViaje) {
        db?.removeChannel(realtimeViaje); 
        realtimeViaje = null;
    }
    
    if (typeof trackingInterval !== 'undefined') {
        clearInterval(trackingInterval);
    }
}

function cerrarModalExito() {
    resetAppTotal();
}



// ── TRACKING CONDUCTOR EN MAPA ────────────────────────────────
function iniciarTrackingConductor(conductorId) {
    clearInterval(trackingInterval);

    const canalConductor = db
        .channel('conductor-pos-' + conductorId)
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'conductores', filter: `id=eq.${conductorId}` },
            (payload) => {
                const { lat, lng } = payload.new;
                if (lat && lng) {
                    moverTaxiEnMapa(lng, lat);
                    trazarRutaTaxi(lng, lat);
                    actualizarETA(lat, lng);
                }
            })
        .subscribe();

    // Polling de respaldo cada 8s
    trackingInterval = setInterval(async () => {
        if (!db) return;
        const { data } = await db.from('conductores').select('lat,lng').eq('id', conductorId).single();
        if (data?.lat && data?.lng) {
            moverTaxiEnMapa(data.lng, data.lat);
            trazarRutaTaxi(data.lng, data.lat);
            actualizarETA(data.lat, data.lng);
        }
    }, 8000);
}

let ultimaPosTaxi = null;
let notificadoCerca = false;
let notificadoPuerta = false;

function calcularRumbo(lat1, lng1, lat2, lng2) {
    if (lat1 === lat2 && lng1 === lng2) return null; // No hay movimiento
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const l1 = lat1 * Math.PI / 180;
    const l2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(l2);
    const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLng);
    const brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

function moverTaxiEnMapa(lng, lat) {
    let rumbo = null;
    if (ultimaPosTaxi) {
        rumbo = calcularRumbo(ultimaPosTaxi.lat, ultimaPosTaxi.lng, lat, lng);
    }
    ultimaPosTaxi = { lat, lng };

    if (!taxiMarker) {
        const el = document.createElement('div');
        el.className = 'taxi-marker';
        // Icono de Auto (Top-down) amarillo para rotar fluidamente
        el.innerHTML = `
            <div style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.4));">
                <svg width="24" height="42" viewBox="0 0 24 42" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <!-- Sombra base -->
                    <rect x="2" y="2" width="20" height="38" rx="6" fill="#000" fill-opacity="0.2"/>
                    <!-- Cuerpo del auto (Amarillo Taxi) -->
                    <rect x="2" y="1" width="20" height="38" rx="6" fill="#FFC107"/>
                    <rect x="3" y="2" width="18" height="36" rx="5" fill="#FFD54F"/>
                    <!-- Vidrios -->
                    <path d="M4 11C4 10 5 9 7 9H17C19 9 20 10 20 11V15H4V11Z" fill="#1C2833"/>
                    <path d="M4 27H20V31C20 32 19 33 17 33H7C5 33 4 32 4 31V27Z" fill="#1C2833"/>
                    <!-- Techo con letrero TAXI -->
                    <rect x="5" y="16" width="14" height="10" rx="2" fill="#F39C12"/>
                    <rect x="8" y="18" width="8" height="6" rx="1" fill="#FFF"/>
                    <!-- Luces delanteras y traseras -->
                    <rect x="3" y="1" width="4" height="2" rx="1" fill="#FFF"/>
                    <rect x="17" y="1" width="4" height="2" rx="1" fill="#FFF"/>
                    <rect x="3" y="37" width="4" height="2" rx="1" fill="#E74C3C"/>
                    <rect x="17" y="37" width="4" height="2" rx="1" fill="#E74C3C"/>
                </svg>
            </div>
        `;
        // anchor 'center' y rotationAlignment 'map' para que rote con la calle
        taxiMarker = new mapboxgl.Marker({ element: el, anchor: 'center', rotationAlignment: 'map' })
            .setLngLat([lng, lat])
            .addTo(map);
        if (rumbo !== null) taxiMarker.setRotation(rumbo);
    } else {
        taxiMarker.setLngLat([lng, lat]);
        if (rumbo !== null) taxiMarker.setRotation(rumbo);
    }
}

async function trazarRutaTaxi(taxiLng, taxiLat) {
    const origenLat = ultimasCoordenadas?.origen?.lat;
    const origenLng = ultimasCoordenadas?.origen?.lng;
    const destLat   = ultimasCoordenadas?.destino?.lat;
    const destLng   = ultimasCoordenadas?.destino?.lng;
    if (!origenLat || !destLat) return;

    // RUTA RELATIVA SEGÚN FASE:
    // Si estado es 'aceptado' -> ruta de taxi al origen.
    // Si estado es 'en_curso' -> ruta de taxi al destino.
    let coords = '';
    if (estadoViajeActual === 'aceptado') {
        coords = `${taxiLng},${taxiLat};${origenLng},${origenLat}`;
    } else if (estadoViajeActual === 'en_curso') {
        coords = `${taxiLng},${taxiLat};${destLng},${destLat}`;
    } else {
        // Backup: ruta completa
        coords = `${taxiLng},${taxiLat};${origenLng},${origenLat};${destLng},${destLat}`;
    }
    try {
        const data = await (await fetch(
            `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&access_token=${ENV.MAPBOX_TOKEN}`
        )).json();
        const geom = data.routes?.[0]?.geometry;
        if (!geom) return;

        const geomData = { type: 'Feature', geometry: geom };
        if (map.getSource('ruta-taxi')) {
            map.getSource('ruta-taxi').setData(geomData);
        } else {
            map.addSource('ruta-taxi', { type: 'geojson', data: geomData });
            map.addLayer({ id:'ruta-taxi-sombra', type:'line', source:'ruta-taxi',
                layout:{'line-join':'round','line-cap':'round'},
                paint:{'line-color':'#FFD700','line-width':10,'line-opacity':0.1}});
            map.addLayer({ id:'ruta-taxi-linea', type:'line', source:'ruta-taxi',
                layout:{'line-join':'round','line-cap':'round'},
                paint:{'line-color':'#FFD700','line-width':3,'line-opacity':0.85,'line-dasharray':[2,2]}});
        }

        const dur = data.routes?.[0]?.duration;
        if (dur) {
            const min = Math.max(1, Math.round(dur/60));
            document.getElementById('seg-eta').textContent = min + ' min';
            evaluarNotificacionesCliente(min, data.routes[0].distance);
        }
    } catch(e) { /* silencioso */ }
}

async function actualizarETA(taxiLat, taxiLng) {
    const origenLat = ultimasCoordenadas?.origen?.lat;
    const origenLng = ultimasCoordenadas?.origen?.lng;
    if (!origenLat) return;
    const distKm = haversineKm(taxiLat, taxiLng, origenLat, origenLng);
    const min = Math.max(1, Math.round(distKm / 0.5)); // 30 km/h avg
    document.getElementById('seg-eta').textContent = min + ' min';
    evaluarNotificacionesCliente(min, distKm * 1000);
}

function evaluarNotificacionesCliente(minutos, metros) {
    // Solo notificar si estamos esperando al conductor (fase 'aceptado')
    if (estadoViajeActual !== 'aceptado') return;

    // Si faltan 2 minutos o menos y no se ha notificado
    if (minutos <= 2 && !notificadoCerca && metros > 100) {
        const msg = '🚖 ¡Tu conductor está a 2 minutos!';
        showToast(msg, 'info');
        hablar('Tu taxi está muy cerca. Estará llegando en aproximadamente dos minutos.');
        enviarNotificacionExterna('TuTaxi — Conductor cerca', msg);
        if ('vibrate' in navigator) navigator.vibrate([200, 100, 200, 100, 200]);
        notificadoCerca = true;
    }
    // Si la distancia es muy pequeña (en puerta)
    if (metros < 80 && !notificadoPuerta) {
        const msg = '📍 ¡El conductor llegó a la puerta!';
        showToast(msg, 'success');
        hablar('El taxi ha llegado a la puerta. Por favor, preparate para subir.');
        enviarNotificacionExterna('TuTaxi — Conductor en puerta', msg);
        if ('vibrate' in navigator) navigator.vibrate([500, 200, 500]);
        notificadoPuerta = true;
    }
}

function enviarNotificacionExterna(titulo, mensaje) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        new Notification(titulo, {
            body: mensaje,
            icon: '/images/favicon.png', // Ajustar ruta si existe
            silent: false
        });
    }
}

// ── HELPERS ───────────────────────────────────────────────────
function esNocheAhora() { const h = new Date().getHours(); return h >= 21 || h < 7; }

function obtenerPrecioActual() {
    const el = document.getElementById('precio-final');
    if (!el) return 0;
    const txt = el.textContent.replace(/[^\d,]/g, '').replace(',', '.');
    return parseFloat(txt) || 0;
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}