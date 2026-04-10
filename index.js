require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const EMAIL = process.env.AGENDAPRO_EMAIL;
const PASSWORD = process.env.AGENDAPRO_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const URL_INVENTARIO = 'https://app.agendapro.com/products/inventory';

if (!EMAIL || !PASSWORD) {
  console.error('Faltan AGENDAPRO_EMAIL o AGENDAPRO_PASSWORD en .env');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const delay = ms => new Promise(r => setTimeout(r, ms));

async function extraerFilas(ctx) {
  return await ctx.evaluate(() => {
    const filas = [...document.querySelectorAll('tbody[role="rowgroup"] tr[role="row"]')];
    return filas.map(fila => {
      const celdas = [...fila.querySelectorAll('td[role="cell"]')];
      const btnAdd = fila.querySelector('[data-testid^="add-stock-btn-"]');
      const id = btnAdd
        ? btnAdd.getAttribute('data-testid').replace('add-stock-btn-', '')
        : null;
      const stockEl = fila.querySelector('td[role="cell"] p.text-sm');
      const stock = stockEl ? stockEl.textContent.trim() : null;

      return {
        id,
        codigo: celdas[0]?.textContent.trim() || '',
        nombre: celdas[1]?.textContent.trim() || '',
        categoria: celdas[2]?.textContent.trim() || '',
        marca: celdas[3]?.textContent.trim() || '',
        formato: celdas[4]?.textContent.trim() || '',
        precio: celdas[5]?.textContent.trim() || '',
        stock,
      };
    });
  });
}

function toCSV(productos) {
  const headers = ['id', 'codigo', 'nombre', 'categoria', 'marca', 'formato', 'precio', 'stock'];
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = productos.map(p => headers.map(h => escape(p[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function limpiarStock(valor) {
  if (valor == null) return 0;
  const limpio = String(valor).replace(/[^\d-]/g, '');
  return limpio === '' ? 0 : Number(limpio);
}

async function actualizarStockEnSupabase(productos) {
  console.log('\n☁️ Sincronizando stock con Supabase...\n');

  const { data: stockActual, error: errorLectura } = await supabase
    .from('products')
    .select('id, stock');

  if (errorLectura) {
    console.error('❌ No se pudo leer la tabla products:', errorLectura.message);
    return;
  }

  const mapaStock = {};
  for (const row of stockActual) mapaStock[String(row.id)] = row.stock;

  let actualizados = 0;
  let sinCambios = 0;
  let noEncontrados = 0;
  let errores = 0;

  for (const prod of productos) {
    const id = String(prod.id || '').trim();
    const stock = limpiarStock(prod.stock);

    if (!id) continue;

    if (!(id in mapaStock)) {
      console.warn(`⚠️ ID ${id} (${prod.nombre}) no está en Supabase, se omite`);
      noEncontrados++;
      continue;
    }

    if (mapaStock[id] === stock) {
      sinCambios++;
      continue;
    }

    const { error: errorUpdate } = await supabase
      .from('products')
      .update({ stock })
      .eq('id', Number(id));

    if (errorUpdate) {
      console.error(`❌ Error actualizando ID ${id} (${prod.nombre}):`, errorUpdate.message);
      errores++;
      continue;
    }

    console.log(`✅ ID ${id} | ${prod.nombre} => stock: ${mapaStock[id]} -> ${stock}`);
    actualizados++;
  }

  console.log('\n==========================================');
  console.log(`✅ Actualizados  : ${actualizados}`);
  console.log(`⏭️ Sin cambios   : ${sinCambios}`);
  console.log(`⚠️ No encontrados: ${noEncontrados}`);
  console.log(`❌ Errores       : ${errores}`);
  console.log('==========================================\n');
}

async function sincronizarInventario() {
  console.log(`\n🔄 [Inventario] Iniciando sincronización: ${new Date().toLocaleString()}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    console.log('🔐 Login inventario...');

    await page.goto('https://app.agendapro.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.waitForSelector('input[placeholder="user@example.com"]', { timeout: 60000 });
    await page.type('input[placeholder="user@example.com"]', EMAIL);
    await page.type('input[placeholder="Enter your password"]', PASSWORD);
    await page.click('button');

    await page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    console.log('✅ Login OK');

    await page.goto(URL_INVENTARIO, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await delay(3000);

    let ctx = page;
    for (const frame of [page, ...page.frames()]) {
      try {
        const found = await frame.$('tr[role="row"]');
        if (found) {
          ctx = frame;
          break;
        }
      } catch (_) {}
    }

    await ctx.waitForSelector('tr[role="row"]', { timeout: 20000 });
    console.log('✅ Tabla encontrada');

    const totalPaginas = await ctx.evaluate(() => {
      const input = document.querySelector('[data-testid="Table-pagination"] input[type="number"]');
      return input ? parseInt(input.getAttribute('max')) || 1 : 1;
    });

    console.log(`📄 Total de páginas: ${totalPaginas}`);

    const todosLosProductos = [];

    for (let pagina = 1; pagina <= totalPaginas; pagina++) {
      console.log(`⏳ Extrayendo página ${pagina} de ${totalPaginas}...`);

      await ctx.waitForSelector('tbody[role="rowgroup"] tr[role="row"]', { timeout: 20000 });
      await delay(800);

      const filas = await extraerFilas(ctx);
      console.log(`✅ ${filas.length} productos extraídos`);
      todosLosProductos.push(...filas);

      if (pagina < totalPaginas) {
        const btnSiguiente = await ctx.$('[data-testid="Table-pagination"] button:last-child');

        if (!btnSiguiente) {
          console.warn('⚠️ No se encontró botón "Siguiente"');
          break;
        }

        await btnSiguiente.click();
        await delay(2000);
      }
    }

    fs.writeFileSync('productos.json', JSON.stringify(todosLosProductos, null, 2), 'utf8');
    fs.writeFileSync('productos.csv', toCSV(todosLosProductos), 'utf8');

    console.log(`\n💾 Guardados ${todosLosProductos.length} productos en productos.json y productos.csv`);

    await actualizarStockEnSupabase(todosLosProductos);

    console.log(`✅ [Inventario] Sincronización completa: ${new Date().toLocaleString()}`);
  } catch (e) {
    console.error('❌ [Inventario] Error general:', e.message);
    try {
      await page.screenshot({ path: 'error-inventario.png', fullPage: true });
    } catch (_) {}
  } finally {
    await browser.close();
  }
}

module.exports = { sincronizarInventario };