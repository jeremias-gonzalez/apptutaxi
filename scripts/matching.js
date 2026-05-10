// ── Estado de Matching ──
let conductoresConsultados = []; // IDs de choferes que ya rechazaron o ignoraron
let matchingInterval       = null;

// ── SOLICITAR VIAJE (llama al algoritmo) ─────────────────────
async function solicitarViaje() {
    if (!db) { showToast('Sin conexión', 'error'); return; }

    const btnSolicitar = document.getElementById('btn-solicitar');
    btnSolicitar.disabled = true;
    btnSolicitar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Buscando conductor...';

    // 1. Insertar viaje como "pendiente"
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

    if (error || !viaje) {
        btnSolicitar.disabled = false;
        btnSolicitar.innerHTML = '<i class="fas fa-taxi"></i> SOLICITAR TAXI AHORA';
        showToast('Error al solicitar el viaje. Intentá de nuevo.', 'error');
        return;
    }

    viajeActivoId = viaje.id;
    conductoresConsultados = []; // Resetear lista de intentos
    
    // 3. Mostrar panel de espera
    mostrarPanelSeguimiento();
    escucharEstadoViaje(viaje.id);
    
    // Iniciar el ciclo de búsqueda inteligente
    buscarSiguienteConductor(viaje);
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

async function cancelarSeguimiento() {
    if (!viajeActivoId) return;

    if (!confirm('¿Estás seguro de que deseas cancelar el viaje?')) return;

    // Actualizar DB a cancelado para que el conductor vea que desapareció
    await db.from('viajes').update({ estado: 'cancelado' }).eq('id', viajeActivoId);

    document.getElementById('panel-seguimiento').classList.remove('visible');
    if (typeof realtimeViaje !== 'undefined' && realtimeViaje) {
        db?.removeChannel(realtimeViaje); realtimeViaje = null;
    }
    clearInterval(trackingInterval);
    if (taxiMarker) { taxiMarker.remove(); taxiMarker = null; }

    // Limpiar ruta del taxi del mapa
    if (map && map.getLayer('ruta-taxi-linea'))  map.removeLayer('ruta-taxi-linea');
    if (map && map.getLayer('ruta-taxi-sombra')) map.removeLayer('ruta-taxi-sombra');
    if (map && map.getSource('ruta-taxi'))       map.removeSource('ruta-taxi');

    viajeActivoId = null;
    showToast('Viaje cancelado correctamente', 'info');
    
    // Resetear UI principal si es necesario
    volverAlFormulario();
}


// ── ESCUCHAR ESTADO DEL VIAJE ─────────────────────────────────
function escucharEstadoViaje(viajeId) {
    if (!db) return;
    if (typeof realtimeViaje !== 'undefined' && realtimeViaje) db.removeChannel(realtimeViaje);

    realtimeViaje = db
        .channel('viaje-pasajero-' + viajeId)
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'viajes', filter: `id=eq.${viajeId}` },
            async (payload) => {
                const v = payload.new;
                const txtEstado = document.getElementById('seg-estado-texto');
                const dot = document.querySelector('.seg-dot');

                if (v.estado === 'notificado') {
                    // Algoritmo asignó conductor, esperando aceptación
                    txtEstado.textContent = 'Un chofer está viendo tu solicitud...';
                    if (dot) dot.className = 'seg-dot notificado'; 
                } else if (v.estado === 'en_curso') {
                    if (matchingInterval) clearTimeout(matchingInterval);
                    viajeAceptado(v);
                } else if (v.estado === 'completado') {
                    viajeCompletado();
                } else if (v.estado === 'cancelado') {
                    if (matchingInterval) clearTimeout(matchingInterval);
                    showToast('Buscando otro conductor disponible...', 'info');
                    txtEstado.textContent = 'Reintentando búsqueda...';
                    if (dot) dot.className = 'seg-dot buscando';
                    
                    // Si fue cancelado/rechazado, buscar al siguiente inmediatamente
                    const { data: vFull } = await db.from('viajes').select('*').eq('id', viajeId).single();
                    buscarSiguienteConductor(vFull);
                } else if (v.estado === 'pendiente') {
                    // Si volvió a pendiente (por timeout o rechazo manual), buscar siguiente
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
    document.getElementById('modal-exito').classList.remove('visible');
    cancelarSeguimiento(); // Esto limpia el mapa y vuelve a los inputs
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

function moverTaxiEnMapa(lng, lat) {
    if (!taxiMarker) {
        const el = document.createElement('div');
        el.className = 'taxi-marker';
        el.innerHTML = '🚖';
        taxiMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([lng, lat]).addTo(map);
    } else {
        taxiMarker.setLngLat([lng, lat]);
    }
    map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });
}

async function trazarRutaTaxi(taxiLng, taxiLat) {
    const origenLat = ultimasCoordenadas?.origen?.lat;
    const origenLng = ultimasCoordenadas?.origen?.lng;
    const destLat   = ultimasCoordenadas?.destino?.lat;
    const destLng   = ultimasCoordenadas?.destino?.lng;
    if (!origenLat || !destLat) return;

    const coords = `${taxiLng},${taxiLat};${origenLng},${origenLat};${destLng},${destLat}`;
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
        if (dur) document.getElementById('seg-eta').textContent = Math.max(1, Math.round(dur/60)) + ' min';
    } catch(e) { /* silencioso */ }
}

async function actualizarETA(taxiLat, taxiLng) {
    const origenLat = ultimasCoordenadas?.origen?.lat;
    const origenLng = ultimasCoordenadas?.origen?.lng;
    if (!origenLat) return;
    const distKm = haversineKm(taxiLat, taxiLng, origenLat, origenLng);
    document.getElementById('seg-eta').textContent = Math.max(1, Math.round(distKm / 0.5)) + ' min';
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
