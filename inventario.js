// ─────────────────────────────────────────────────────────────────────────────
//  inventario.js — Scraping de inventario + sync Supabase
//  Se ejecuta automáticamente cada 15 minutos desde index.js
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const puppeteer = require('puppeteer');
const fs        = require('fs');
const { createClient } = require('@supabase/supabase-js');

const EMAIL                     = process.env.AGENDAPRO_EMAIL;
const PASSWORD                  = process.env.AGENDAPRO_PASSWORD;
const SUPABASE_URL               = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const URL_INVENTARIO            = 'https://app.agendapro.com/products/inventory';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const delay    = ms => new Promise(r => setTimeout(r, ms));

async function extraerFilas(ctx) {
  return await ctx.evaluate(() => {
    const filas = [...document.querySelectorAll('tbody[role="rowgroup"] tr[role="row"]')];
    return filas.map(fila => {
      const celdas  = [...fila.querySelectorAll('td[role="cell"]')];
      const btnAdd  = fila.querySelector('[data-testid^="add-stock-btn-"]');
      const id      = btnAdd
        ? btnAdd.getAttribute('data-testid').replace('add-stock-btn-', '')
        : null;
      const stockEl = fila.querySelector('td[role="cell"] p.text-sm');
      const stock   = stockEl ? stockEl.textContent.trim() : null;
      return {
        id,
        codigo:    celdas[0]?.textContent.trim() || '',
        nombre:    celdas[1]?.textContent.trim() || '',
        categoria: celdas[2]?.textContent.trim() || '',
        marca:     celdas[3]?.textContent.trim() || '',
        formato:   celdas[4]?.textContent.trim() || '',
        precio:    celdas[5]?.textContent.trim() || '',
        stock,
      };
    });
  });
}

function toCSV(productos) {
  const headers = ['id','codigo','nombre','categoria','marca','formato','precio','stock'];
  const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows    = productos.map(p => headers.map(h => escape(p[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function limpiarStock(valor) {
  if (valor == null) return 0;
  const limpio = String(valor).replace(/[^\d-]/g, '');
  return limpio === '' ? 0 : Number(limpio);
}

async function actualizarStockEnSupabase(productos) {
  console.log('\n☁️  Sincronizando stock con Supabase...\n');

  const { data: stockActual, error: errorLectura } = await supabase
    .from('products')
    .select('id, stock');

  if (errorLectura) {
    console.error('❌ No se pudo leer products:', errorLectura.message);
    return;
  }

  const mapaStock = {};
  for (const row of stockActual) mapaStock[String(row.id)] = row.stock;

  // Lista de IDs a ignorar (no generarán advertencia ni se actualizarán)
  const idsIgnorados = new Set([
    '1156817', '1156822', '801850', '1153438',
    '1153445', '914694', '1156819', '821517'
  ]);

  let actualizados  = 0;
  let sinCambios    = 0;
  let noEncontrados = 0;
  let errores       = 0;

  for (const prod of productos) {
    const id    = String(prod.id || '').trim();
    const stock = limpiarStock(prod.stock);
    if (!id) continue;

    // Si el ID está en la lista negra, lo saltamos silenciosamente
    if (idsIgnorados.has(id)) continue;

    if (!(id in mapaStock)) {
      console.warn(`⚠️  ID ${id} (${prod.nombre}) no está en Supabase`);
      noEncontrados++;
      continue;
    }

    if (mapaStock[id] === stock) { sinCambios++; continue; }

    const { error } = await supabase
      .from('products')
      .update({ stock })
      .eq('id', Number(id));

    if (error) {
      console.error(`❌ Error ID ${id} (${prod.nombre}):`, error.message);
      errores++;
      continue;
    }

    console.log(`✅ ID ${id} | ${prod.nombre} → ${mapaStock[id]} → ${stock}`);
    actualizados++;
  }

  console.log('\n══════════════════════════════════════');
  console.log(`✅ Actualizados  : ${actualizados}`);
  console.log(`⏭️  Sin cambios   : ${sinCambios}`);
  console.log(`⚠️  No encontrados: ${noEncontrados}`);
  console.log(`❌ Errores       : ${errores}`);
  console.log('══════════════════════════════════════\n');
}

// Función principal exportada — la llama el scheduler en index.js
async function sincronizarInventario() {
  console.log(`\n🔄 [Inventario] Iniciando sincronización: ${new Date().toLocaleString()}`);

  const browser = await puppeteer.launch({
    headless: true,                           // FIX: 'new' → true, más liviano y estable
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',              // FIX: crítico en VPS/Railway con /dev/shm pequeño
      '--disable-gpu',
      '--no-zygote',                          // FIX: evita proceso zygote hijo
      '--single-process',                     // FIX: todo en un proceso → menos PIDs consumidos
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  // FIX: bloquear recursos innecesarios → Chrome vive menos tiempo, consume menos RAM
  await page.setRequestInterception(true);
  page.on('request', req => {
    const tipo = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(tipo)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    console.log('🔐 Login inventario...');
    // FIX: domcontentloaded es más rápido y confiable que networkidle2
    await page.goto('https://app.agendapro.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[placeholder="user@example.com"]');
    await page.type('input[placeholder="user@example.com"]', EMAIL, { delay: 40 });
    await page.type('input[placeholder="Enter your password"]', PASSWORD, { delay: 40 });
    // FIX: selector específico en vez de 'button' genérico para no clickear el botón equivocado
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    console.log('✅ Login OK');

    await page.goto(URL_INVENTARIO, { waitUntil: 'domcontentloaded' });
    await delay(2500);

    let ctx = page;
    for (const frame of [page, ...page.frames()]) {
      try {
        const found = await frame.$('tr[role="row"]');
        if (found) { ctx = frame; break; }
      } catch (_) {}
    }

    await ctx.waitForSelector('tr[role="row"]', { timeout: 15000 });
    console.log('✅ Tabla encontrada');

    const totalPaginas = await ctx.evaluate(() => {
      const input = document.querySelector('[data-testid="Table-pagination"] input[type="number"]');
      return input ? parseInt(input.getAttribute('max')) || 1 : 1;
    });
    console.log(`📄 Total páginas: ${totalPaginas}`);

    const todosLosProductos = [];

    for (let pagina = 1; pagina <= totalPaginas; pagina++) {
      console.log(`⏳ Página ${pagina} de ${totalPaginas}...`);
      await ctx.waitForSelector('tbody[role="rowgroup"] tr[role="row"]', { timeout: 10000 });
      await delay(600);

      const filas = await extraerFilas(ctx);
      console.log(`   ${filas.length} productos extraídos`);
      todosLosProductos.push(...filas);

      if (pagina < totalPaginas) {
        const btnSiguiente = await ctx.$('[data-testid="Table-pagination"] button:last-child');
        if (!btnSiguiente) { console.warn('⚠️ No se encontró botón Siguiente'); break; }
        await btnSiguiente.click();
        await delay(1500);
      }
    }

    // Guardar archivos locales (opcionales en Railway, útiles para debug)
    fs.writeFileSync('productos.json', JSON.stringify(todosLosProductos, null, 2), 'utf8');
    fs.writeFileSync('productos.csv',  toCSV(todosLosProductos), 'utf8');
    console.log(`💾 ${todosLosProductos.length} productos guardados`);

    await actualizarStockEnSupabase(todosLosProductos);
    console.log(`✅ [Inventario] Sincronización completa: ${new Date().toLocaleString()}`);

  } catch (e) {
    console.error('❌ [Inventario] Error general:', e.message);
    throw e; // FIX: re-lanza el error para que el scheduler en index.js lo capture correctamente
  } finally {
    // FIX: cerrar página primero, luego el browser — ambos con .catch() para evitar errores en finally
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { sincronizarInventario };
