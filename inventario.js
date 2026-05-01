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

// ── Helper: click al botón de login de forma resiliente ──────────────────────
async function clickLoginButton(page) {
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const loginBtn = btns.find(b => {
      const txt = b.textContent.trim().toLowerCase();
      return txt.includes('ingresar') || txt.includes('login') ||
             txt.includes('iniciar') || txt.includes('entrar') ||
             txt.includes('sign in') || txt.includes('acceder');
    });
    if (loginBtn) { loginBtn.click(); return true; }
    return false;
  });

  if (clicked) {
    console.log('✅ Botón de login clickeado por texto');
    return;
  }

  console.log('⚠️  Botón no encontrado por texto → usando Enter');
  await page.keyboard.press('Enter');
}

// ── Extrae las filas de la tabla de inventario ────────────────────────────────
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

// ── Genera CSV desde array de productos ──────────────────────────────────────
function toCSV(productos) {
  const headers = ['id','codigo','nombre','categoria','marca','formato','precio','stock'];
  const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows    = productos.map(p => headers.map(h => escape(p[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

// ── Limpia el valor de stock a número entero ──────────────────────────────────
function limpiarStock(valor) {
  if (valor == null) return 0;
  const limpio = String(valor).replace(/[^\d-]/g, '');
  return limpio === '' ? 0 : Number(limpio);
}

// ── Limpia el valor de precio a número flotante ───────────────────────────────
function limpiarPrecio(valor) {
  if (valor == null || valor === '') return null;
  // Elimina símbolo de moneda, espacios y separadores de miles; normaliza coma decimal
  const limpio = String(valor)
    .replace(/[^0-9,.-]/g, '')   // quita $, letras, espacios, etc.
    .replace(/\.(?=\d{3})/g, '') // quita puntos de miles (ej: 1.000 → 1000)
    .replace(',', '.');          // normaliza coma decimal → punto
  const num = parseFloat(limpio);
  return isNaN(num) ? null : num;
}

// ── Sincroniza stock Y precio con Supabase ────────────────────────────────────
async function actualizarStockEnSupabase(productos) {
  console.log('\n☁️  Sincronizando stock y precios con Supabase...\n');

  const { data: stockActual, error: errorLectura } = await supabase
    .from('products')
    .select('id, stock, precio');

  if (errorLectura) {
    console.error('❌ No se pudo leer products:', errorLectura.message);
    return;
  }

  const mapaProductos = {};
  for (const row of stockActual) {
    mapaProductos[String(row.id)] = {
      stock:  row.stock,
      precio: row.precio,
    };
  }

  const idsIgnorados = new Set([
    '1156817', '1156822', '801850', '1153438',
    '1153445', '914694', '1156819', '821517'
  ]);

  let actualizados  = 0;
  let sinCambios    = 0;
  let noEncontrados = 0;
  let errores       = 0;
  let cambiosStock  = 0;
  let cambiosPrecio = 0;

  for (const prod of productos) {
    const id     = String(prod.id || '').trim();
    const stock  = limpiarStock(prod.stock);
    const precio = limpiarPrecio(prod.precio);
    if (!id) continue;

    if (idsIgnorados.has(id)) continue;

    if (!(id in mapaProductos)) {
      console.warn(`⚠️  ID ${id} (${prod.nombre}) no está en Supabase`);
      noEncontrados++;
      continue;
    }

    const stockAnterior  = mapaProductos[id].stock;
    const precioAnterior = mapaProductos[id].precio;

    const stockCambio  = stockAnterior !== stock;
    const precioCambio = precio !== null && precioAnterior !== precio;

    if (!stockCambio && !precioCambio) { sinCambios++; continue; }

    // Construir objeto de actualización solo con los campos que cambiaron
    const updates = {};
    if (stockCambio)  updates.stock  = stock;
    if (precioCambio) updates.precio = precio;

    const { error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', Number(id));

    if (error) {
      console.error(`❌ Error ID ${id} (${prod.nombre}):`, error.message);
      errores++;
      continue;
    }

    if (stockCambio) {
      console.log(`📦 Stock  ID ${id} | ${prod.nombre} → ${stockAnterior} → ${stock}`);
      cambiosStock++;
    }
    if (precioCambio) {
      console.log(`💰 Precio ID ${id} | ${prod.nombre} → ${precioAnterior} → ${precio}`);
      cambiosPrecio++;
    }

    actualizados++;
  }

  console.log('\n══════════════════════════════════════');
  console.log(`✅ Actualizados   : ${actualizados}`);
  console.log(`📦 Cambios stock  : ${cambiosStock}`);
  console.log(`💰 Cambios precio : ${cambiosPrecio}`);
  console.log(`⏭️  Sin cambios    : ${sinCambios}`);
  console.log(`⚠️  No encontrados : ${noEncontrados}`);
  console.log(`❌ Errores        : ${errores}`);
  console.log('══════════════════════════════════════\n');
}

// ── Función principal exportada ───────────────────────────────────────────────
async function sincronizarInventario() {
  console.log(`\n🔄 [Inventario] Iniciando sincronización: ${new Date().toLocaleString()}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    console.log('🔐 Login inventario...');
    await page.goto('https://app.agendapro.com/login', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('input[placeholder="user@example.com"]');
    await page.type('input[placeholder="user@example.com"]', EMAIL, { delay: 40 });
    await page.type('input[placeholder="Enter your password"]', PASSWORD, { delay: 40 });

    await clickLoginButton(page);
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
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

    fs.writeFileSync('productos.json', JSON.stringify(todosLosProductos, null, 2), 'utf8');
    fs.writeFileSync('productos.csv',  toCSV(todosLosProductos), 'utf8');
    console.log(`💾 ${todosLosProductos.length} productos guardados`);

    await actualizarStockEnSupabase(todosLosProductos);
    console.log(`✅ [Inventario] Sincronización completa: ${new Date().toLocaleString()}`);

  } catch (e) {
    console.error('❌ [Inventario] Error general:', e.message);
    throw e;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { sincronizarInventario };
