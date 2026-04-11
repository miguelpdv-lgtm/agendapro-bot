// ─────────────────────────────────────────────────────────────────────────────
//  index.js — Servidor Express + Cola de ventas + Scheduler de inventario
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cola    = require('./cola');
const { sincronizarInventario } = require('./inventario');

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Autenticación por API Key ─────────────────────────────────────────────────
const autenticar = (req, res, next) => {
  const token = req.headers['x-api-key'];
  if (!token || token !== process.env.API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
};

// ... el resto igual

// ── POST /venta ───────────────────────────────────────────────────────────────
// Encola la venta y responde inmediato con la posición en cola.
// Body: { "productos": [{ "nombre": "Gel Azul", "cantidad": 2 }] }
app.post('/venta', autenticar, (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: 'Debes enviar un array de productos' });
  }

  const posicion = cola.largo + (cola.ocupado ? 1 : 0) + 1;

  cola.agregar(productos)
    .then(r  => console.log('✅ Venta finalizada:', r))
    .catch(e => console.error('❌ Venta fallida:', e.message));

  res.json({
    ok: true,
    mensaje: `Venta encolada. Posición: ${posicion}`,
    posicion,
    enEspera: cola.largo,
  });
});

// ── POST /venta/sync ──────────────────────────────────────────────────────────
// Encola y ESPERA el resultado antes de responder.
// ⚠️ El cliente debe tener timeout > 120s.
app.post('/venta/sync', autenticar, async (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: 'Debes enviar un array de productos' });
  }

  try {
    const resultado = await cola.agregar(productos);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /cola ─────────────────────────────────────────────────────────────────
app.get('/cola', autenticar, (req, res) => {
  res.json({ ocupado: cola.ocupado, enEspera: cola.largo });
});

// ── POST /inventario/sync ─────────────────────────────────────────────────────
// Dispara una sincronización manual de inventario sin esperar el resultado.
app.post('/inventario/sync', autenticar, (req, res) => {
  sincronizarInventario()
    .then(() => console.log('✅ Sync manual completado'))
    .catch(e  => console.error('❌ Sync manual falló:', e.message));

  res.json({ ok: true, mensaje: 'Sincronización de inventario iniciada' });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', hora: new Date().toISOString() }));

// ── SCHEDULER — inventario cada 15 minutos ────────────────────────────────────
const INTERVALO_MS = 15 * 60 * 1000; // 15 minutos

let syncEnCurso = false;

async function tickInventario() {
  if (syncEnCurso) {
    console.log('⏭️  [Scheduler] Sync anterior aún en curso, se omite este tick');
    return;
  }
  syncEnCurso = true;
  try {
    await sincronizarInventario();
  } finally {
    syncEnCurso = false;
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 AgendaPro Bot corriendo en puerto ${PORT}`);
  console.log('   POST /venta            → encola venta (respuesta inmediata)');
  console.log('   POST /venta/sync       → encola venta (espera resultado)');
  console.log('   GET  /cola             → estado de la cola');
  console.log('   POST /inventario/sync  → sync manual de inventario');
  console.log('   GET  /health           → healthcheck\n');

  // Primera sincronización al arrancar
  console.log('⏰ [Scheduler] Ejecutando sincronización inicial...');
  await tickInventario();

  // Luego cada 15 minutos
  setInterval(tickInventario, INTERVALO_MS);
  console.log(`⏰ [Scheduler] Próxima sincronización automática en 15 minutos`);
});
