// ─────────────────────────────────────────────────────────────────────────────
//  index.js — Servidor Express + Cola de ventas + Scheduler de inventario
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cron    = require('node-cron'); // Importamos node-cron
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

// ── POST /venta ───────────────────────────────────────────────────────────────
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
app.post('/inventario/sync', autenticar, (req, res) => {
  sincronizarInventario()
    .then(() => console.log('✅ Sync manual completado'))
    .catch(e  => console.error('❌ Sync manual falló:', e.message));

  res.json({ ok: true, mensaje: 'Sincronización de inventario iniciada' });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', hora: new Date().toISOString() }));

// ── LÓGICA DEL SCHEDULER ──────────────────────────────────────────────────────
let syncEnCurso = false;

async function tickInventario() {
  if (syncEnCurso) {
    console.log('⏭️  [Scheduler] Sync anterior aún en curso, se omite este tick');
    return;
  }
  syncEnCurso = true;
  try {
    await sincronizarInventario();
  } catch (error) {
    console.error('❌ [Scheduler] Error en tickInventario:', error.message);
  } finally {
    syncEnCurso = false;
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 AgendaPro Bot corriendo en puerto ${PORT}`);
  
  // Sincronización inicial al arrancar (solo si está en horario permitido)
  // O puedes dejarla siempre activa para validar conexión al encender el server:
  console.log('⏰ [Scheduler] Ejecutando sincronización inicial de arranque...');
  await tickInventario();

  // PROGRAMACIÓN CRON: Cada 15 min, de 6am a 5:59pm, Hora Colombia
  // Expresión: */15 (cada 15 min) | 6-17 (horas 6,7...17) | * * * (diario)
  cron.schedule('*/15 6-17 * * *', async () => {
    console.log('🔔 [Cron] Ejecutando sincronización programada (Horario 6AM-6PM)');
    await tickInventario();
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  console.log('⏰ [Scheduler] Cron configurado: 6:00 AM a 6:00 PM (Hora Colombia)');
});
