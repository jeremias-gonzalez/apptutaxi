const fs = require('fs');

// Vercel inyecta automáticamente las variables de entorno configuradas
// en el panel (Settings -> Environment Variables) dentro de process.env.
const token = process.env.MAPBOX_TOKEN || '';

if (!token) {
    console.warn("⚠️ ADVERTENCIA: MAPBOX_TOKEN no se encontró en las variables de entorno (process.env.MAPBOX_TOKEN está vacío).");
}

const content = `const ENV = { MAPBOX_TOKEN: "${token}" };\n`;

try {
    fs.writeFileSync('env.js', content, 'utf8');
    console.log('✅ env.js generado correctamente para la subida a Vercel.');
} catch (error) {
    console.error('❌ Error guardando env.js:', error);
    process.exit(1);
}
