// ============================================================
//  TUTAXI — Integración Supabase
//  Archivo: supabase.js
//  Incluir DESPUÉS de env.js y ANTES de script.js en index.html
// ============================================================

const { createClient } = supabase;

const SUPABASE_URL  = ENV.SUPABASE_URL  || 'https://otzmwnqkwgxowjxqmtlw.supabase.co';
const SUPABASE_KEY  = ENV.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90em13bnFrd2d4b3dqeHFtdGx3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyMDA4NTIsImV4cCI6MjA5Mzc3Njg1Mn0.wU6ARJx4epIpB3RZvpysIm82RedPTxPe4odBWrINAI0';

// Si no hay credenciales (ej: desarrollo local sin env.js completo),
// db será null y cada función fallará silenciosamente sin romper la app.
let db = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    db = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('✅ Supabase conectado');
} else {
    console.warn('⚠️  Supabase: credenciales no encontradas. Modo offline — la app sigue funcionando.');
}

// ─── TARIFAS ────────────────────────────────────────────────
// Reemplaza la carga desde tarifas.json
// Llama a esta función en window.load en lugar de cargarTarifas()
async function cargarTarifasDB() {
    if (!db) throw new Error('Sin conexión Supabase');
    try {
        const { data, error } = await db.from('tarifas').select('*');
        if (error) throw error;

        data.forEach(t => {
            TARIFAS_TAXI[t.tipo] = {
                bajada: Number(t.bajada),
                ficha:  Number(t.ficha)
            };
        });

        console.log('✅ Tarifas cargadas desde Supabase:', TARIFAS_TAXI);
    } catch (err) {
        console.warn('⚠️ No se pudieron cargar tarifas de Supabase, usando defaults:', err.message);
    }
}

// ─── VIAJES ─────────────────────────────────────────────────
// Guarda un viaje calculado. Llamar al final de calcularRutaDirecta()
async function guardarViaje({ origenTexto, destinoTexto, origenLat, origenLng,
                               destinoLat, destinoLng, distanciaKm,
                               precioEstimado, tarifaTipo }) {
    if (!db) return; // silencioso en modo offline
    try {
        const { error } = await db.from('viajes').insert({
            origen_texto:    origenTexto,
            destino_texto:   destinoTexto,
            origen_lat:      origenLat,
            origen_lng:      origenLng,
            destino_lat:     destinoLat,
            destino_lng:     destinoLng,
            distancia_km:    distanciaKm,
            precio_estimado: precioEstimado,
            tarifa_tipo:     tarifaTipo,
            estado:          'pendiente'
        });
        if (error) throw error;
        console.log('✅ Viaje guardado en Supabase');
    } catch (err) {
        // Silencioso — no interrumpir la UX si falla el guardado
        console.warn('⚠️ No se pudo guardar el viaje:', err.message);
    }
}

// ─── REALTIME — Escucha nuevos viajes (panel conductor futuro) ───
// Devuelve el canal para poder desuscribirse si hace falta
function escucharNuevosViajes(callback) {
    if (!db) return null;
    const canal = db
        .channel('viajes-realtime')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'viajes' },
            (payload) => {
                console.log('🚖 Nuevo viaje recibido:', payload.new);
                if (typeof callback === 'function') callback(payload.new);
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('✅ Realtime suscripto a tabla viajes');
            }
        });

    return canal;
}

// ─── CONDUCTORES — Actualizar posición en tiempo real ───────
async function actualizarPosicionConductor(conductorId, lat, lng) {
    if (!db) return;
    try {
        const { error } = await db
            .from('conductores')
            .upsert({ id: conductorId, lat, lng, updated_at: new Date().toISOString() });
        if (error) throw error;
    } catch (err) {
        console.warn('⚠️ Error actualizando posición:', err.message);
    }
}

// ─── LUGARES VIP — Cargar desde Supabase (opcional) ─────────
// Si preferís gestionar los lugares desde Supabase en vez de lugares.json
async function cargarLugaresVIPDB() {
    if (!db) throw new Error('Sin conexión Supabase');
    try {
        const { data, error } = await db.from('lugares_vip').select('*');
        if (error) throw error;
        if (data && data.length > 0) {
            LUGARES_VIP = data.map(l => ({
                nombre:    l.nombre,
                direccion: l.direccion,
                lat:       l.lat,
                lon:       l.lon,
                alias:     l.alias || []
            }));
            console.log(`✅ ${LUGARES_VIP.length} lugares VIP cargados desde Supabase`);
        }
    } catch (err) {
        console.warn('⚠️ Fallback a lugares.json:', err.message);
        // La función cargarLugaresVIP() del script.js tomará el control
    }
}