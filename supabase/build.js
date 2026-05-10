const fs = require('fs');

// Vercel inyecta automáticamente las variables de entorno configuradas
// en Settings → Environment Variables dentro de process.env.
const mapboxToken    = process.env.MAPBOX_TOKEN    || '';
const supabaseUrl    = process.env.SUPABASE_URL    || '';
const supabaseKey    = process.env.SUPABASE_ANON_KEY || '';

if (!mapboxToken)  console.warn("⚠️  ADVERTENCIA: MAPBOX_TOKEN no encontrado en process.env.");
if (!supabaseUrl)  console.warn("⚠️  ADVERTENCIA: SUPABASE_URL no encontrado en process.env.");
if (!supabaseKey)  console.warn("⚠️  ADVERTENCIA: SUPABASE_ANON_KEY no encontrado en process.env.");

const content = `const ENV = {
  MAPBOX_TOKEN:      "${mapboxToken}",
  SUPABASE_URL:      "${supabaseUrl}",
  SUPABASE_ANON_KEY: "${supabaseKey}"
};\n`;

try {
    fs.writeFileSync('supabase/env.js', content, 'utf8');
    console.log('✅ env.js generado correctamente.');
} catch (error) {
    console.error('❌ Error guardando env.js:', error);
    process.exit(1);
}