// ─────────────────────────────────────────────────────────────────────────────
// inventario.js — Scraping de inventario + sync Supabase (con reintentos)
// VERSIÓN CORREGIDA: guardas anti-precio-cero
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const puppeteer = require('puppeteer');
const fs        = require('fs');

const { createClient }                = require('@supabase/supabase-js');
const ws                              = require('ws');
const { notificarError, notificarOk } = require('./notificar');

const EMAIL    = process.env.AGENDAPRO_EMAIL;
const PASSWORD = process.env.AGENDAPRO_PASSWORD;

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const URL_INVENTARIO            = 'https://app.agendapro.com/products/inventory';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws },
});

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// waitForSelectorSafe — nunca lanza, devuelve el elemento o null
// ─────────────────────────────────────────────────────────────
async function waitForSelectorSafe(ctx, selector, timeout = 15000) {
  try {
    const el = await ctx.waitForSelector(selector, { timeout });
    return el;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// matarChromeSiHay — cierra procesos chrome huérfanos en Linux
// ─────────────────────────────────────────────────────────────
async function matarChromeSiHay() {
  try {
    const { execSync } = require('child_process');
    execSync('pkill -f "chrome" || true', { stdio: 'ignore' });
    await delay(1500);
    console.log('🧹 Procesos chrome anteriores limpiados');
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// cerrarBrowser — cierra de forma segura sin lanzar
// ─────────────────────────────────────────────────────────────
async function cerrarBrowser(browser) {
  if (!browser) return;
  try {
    const pages = await browser.pages().catch(() => []);
    await Promise.all(pages.map(p => p.close().catch(() => {})));
    await browser.close().catch(() => {});
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// conReintentos — ejecuta fn hasta maxIntentos veces
// ─────────────────────────────────────────────────────────────
async function conReintentos(fn, { maxIntentos = 3, etiqueta = 'operación' } = {}) {
  let ultimoError;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      return await fn(intento);
    } catch (e) {
      ultimoError = e;
      const espera = intento * 5000;
      console.warn(`⚠️  [${etiqueta}] Intento ${intento}/${maxIntentos} falló: ${e.message}`);
      if (intento < maxIntentos) {
        console.log(`   ↻ Limpiando recursos y reintentando en ${espera / 1000}s...`);
        await matarChromeSiHay();
        await delay(espera);
      }
    }
  }

  throw ultimoError;
}

// ─────────────────────────────────────────────────────────────
// Login resiliente
// ─────────────────────────────────────────────────────────────
async function clickLoginButton(page) {
  const clicked = await page.evaluate(() => {
    const btns     = [...document.querySelectorAll('button')];
    const loginBtn = btns.find(b => {
      const txt = b.textContent.trim().toLowerCase();
      return (
        txt.includes('ingresar') ||
        txt.includes('login')    ||
        txt.includes('iniciar')  ||
        txt.includes('entrar')   ||
        txt.includes('sign in')  ||
        txt.includes('acceder')
      );
    });
    if (loginBtn) { loginBtn.click(); return true; }
    return false;
  });

  if (clicked) {
    console.log('✅ Botón login clickeado');
    return;
  }

  console.log('⚠️  Login usando Enter');
  await page.keyboard.press('Enter');
}

// ─────────────────────────────────────────────────────────────
// Extraer filas
// ─────────────────────────────────────────────────────────────
async function extraerFilas(ctx) {
  return ctx.evaluate(() => {
    const filas = [...document.querySelectorAll('tbody[role="rowgroup"] tr[role="row"]')];

    return filas.map(fila => {
      const celdas  = [...fila.querySelectorAll('td[role="cell"]')];
      const btnAdd  = fila.querySelector('[data-testid^="add-stock-btn-"]');
      const id      = btnAdd ? btnAdd.getAttribute('data-testid').replace('add-stock-btn-', '') : null;
      const stockEl = fila.querySelector('td[role="cell"] p.text-sm');

      return {
        id,
        sku:       celdas[0]?.textContent.trim() || '',
        nombre:    celdas[1]?.textContent.trim() || '',
        categoria: celdas[2]?.textContent.trim() || '',
        marca:     celdas[3]?.textContent.trim() || '',
        formato:   celdas[4]?.textContent.trim() || '',
        precio:    celdas[5]?.textContent.trim() || '',
        stock:     stockEl ? stockEl.textContent.trim() : null,
      };
    });
  });
}

// ─────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────
function toCSV(productos) {
  const headers = ['id','sku','nombre','categoria','marca','formato','precio','stock'];
  const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows    = productos.map(p => headers.map(h => escape(p[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

// ─────────────────────────────────────────────────────────────
// Limpieza de datos
// ─────────────────────────────────────────────────────────────
function limpiarStock(valor) {
  if (valor == null) return 0;
  const limpio = String(valor).replace(/[^\d-]/g, '');
  return limpio === '' ? 0 : Number(limpio);
}

function limpiarPrecio(valor) {
  if (valor == null || valor === '') return 0;
  const limpio = String(valor)
    .replace(/[^0-9,.-]/g, '')
    .replace(/\.(?=\d{3})/g, '')
    .replace(',', '.');
  const num = parseFloat(limpio);
  return isNaN(num) ? 0 : Math.round(num);
}

function limpiarCategoria(valor) {
  if (!valor) return '';
  return valor.replace(/uso del salon/gi, '').replace(/\s+/g, ' ').trim();
}

function limpiarMarca(valor) {
  if (!valor) return '';
  const marca = valor.trim();
  if (/universo capilar/i.test(marca)) return '';
  return marca;
}

// ─────────────────────────────────────────────────────────────
// Sync Supabase — CON GUARDAS ANTI-PRECIO-CERO
// ─────────────────────────────────────────────────────────────
async function actualizarStockEnSupabase(productos) {
  console.log('\n☁️  Sincronizando inventario con Supabase...\n');

  // ─── GUARDA 1: circuit breaker global ──────────────────────
  // Si el scraping trajo demasiados precios en 0, algo salió mal
  // (render a medio cargar, selector cambiado, etc). Abortamos
  // sin tocar Supabase para no pisar datos buenos.
  const conPrecio    = productos.filter(p => limpiarPrecio(p.precio) > 0).length;
  const ratioValidos = productos.length ? conPrecio / productos.length : 0;

  if (productos.length > 0 && ratioValidos < 0.8) {
    const msg = `Sync abortado: solo ${(ratioValidos * 100).toFixed(1)}% de productos tienen precio > 0 (esperado >80%). Total: ${productos.length}, con precio válido: ${conPrecio}`;
    console.error('🚨 ' + msg);
    await notificarError({
      asunto:   '🚨 Inventario: precios sospechosos, sync abortado',
      script:   'inventario.js',
      error:    msg,
      contexto: 'Se detectaron demasiados precios en 0 antes de escribir a Supabase. No se modificó ningún registro.',
      intento:  0,
    });
    return { creados: 0, actualizados: 0, omitidos: 0, errores: 0, abortado: true };
  }

  const { data: stockActual, error: errorLectura } =
    await supabase.from('products').select('*');

  if (errorLectura) {
    console.error('❌ Error leyendo products:', errorLectura.message);
    return;
  }

  const mapaProductos = {};
  for (const row of stockActual) {
    mapaProductos[String(row.id)] = row;
  }

  const idsIgnorados = new Set([
    '1156817','1156822','801850','1153438',
    '1153445','914694','1156819','821517',
  ]);

  let creados = 0, actualizados = 0, omitidos = 0, errores = 0, preciosSospechosos = 0;

  for (const prod of productos) {
    const id = String(prod.id || '').trim();
    if (!id) continue;
    if (idsIgnorados.has(id)) continue;

    if (/uso del salon/i.test(prod.categoria || '')) {
      console.log(`⏭️  Omitido uso del salon | ${id} | ${prod.nombre}`);
      omitidos++;
      continue;
    }

    const dataProducto = {
      id:           Number(id),
      sku:          (prod.sku     || '').trim(),
      nombre:       (prod.nombre  || '').trim(),
      display_name: (prod.nombre  || '').trim(),
      categoria:    limpiarCategoria(prod.categoria),
      marca:        limpiarMarca(prod.marca),
      formato:      (prod.formato || '').trim(),
      precio:       limpiarPrecio(prod.precio),
      stock:        limpiarStock(prod.stock),
    };

    if (!(id in mapaProductos)) {
      const { error: insertError } = await supabase.from('products').insert(dataProducto);
      if (insertError) {
        console.error(`❌ Error creando ${id}:`, insertError.message);
        errores++;
        continue;
      }
      console.log(`🆕 Creado | ${id} | ${dataProducto.nombre}`);
      creados++;
      continue;
    }

    const actual = mapaProductos[id];

    // ─── GUARDA 2: por producto ─────────────────────────────
    // Nunca dejar que un precio existente > 0 se pise con un 0
    // nuevo. Se mantiene el precio anterior y se avisa.
    if (dataProducto.precio === 0 && Number(actual.precio || 0) > 0) {
      console.warn(`⚠️  Precio sospechoso (0) para ${id} | ${dataProducto.nombre} — se mantiene el anterior (${actual.precio})`);
      dataProducto.precio = Number(actual.precio);
      preciosSospechosos++;
    }

    const huboCambios =
      (actual.sku          || '') !== dataProducto.sku          ||
      (actual.nombre       || '') !== dataProducto.nombre        ||
      (actual.display_name || '') !== dataProducto.display_name  ||
      (actual.categoria    || '') !== dataProducto.categoria     ||
      (actual.marca        || '') !== dataProducto.marca         ||
      (actual.formato      || '') !== dataProducto.formato       ||
      Number(actual.precio || 0) !== Number(dataProducto.precio) ||
      Number(actual.stock  || 0) !== Number(dataProducto.stock);

    if (!huboCambios) continue;

    const { error: updateError } = await supabase
      .from('products')
      .update(dataProducto)
      .eq('id', Number(id));

    if (updateError) {
      console.error(`❌ Error actualizando ${id}:`, updateError.message);
      errores++;
      continue;
    }

    console.log(`✅ Actualizado | ${id} | ${dataProducto.nombre}`);
    actualizados++;
  }

  console.log('\n═══════════════════════════════════');
  console.log(`🆕 Creados              : ${creados}`);
  console.log(`✅ Actualizados         : ${actualizados}`);
  console.log(`⏭️  Omitidos             : ${omitidos}`);
  console.log(`⚠️  Precios sospechosos  : ${preciosSospechosos} (se mantuvo el valor anterior)`);
  console.log(`❌ Errores              : ${errores}`);
  console.log('═══════════════════════════════════\n');

  if (preciosSospechosos > 0) {
    await notificarError({
      asunto:   `⚠️ Inventario: ${preciosSospechosos} precios sospechosos evitados`,
      script:   'inventario.js',
      error:    `${preciosSospechosos} productos trajeron precio 0 desde AgendaPro pero tenían precio > 0 en Supabase. Se conservó el valor anterior en cada caso.`,
      contexto: 'Revisar el scraping/selector de precio si esto se repite seguido.',
      intento:  0,
    });
  }

  return { creados, actualizados, omitidos, errores, preciosSospechosos };
}

// ─────────────────────────────────────────────────────────────
// Función principal — con reintentos + notificación por correo
// ─────────────────────────────────────────────────────────────
async function sincronizarInventario() {
  const ahora    = new Date();
  const ahoraCOL = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const hora     = ahoraCOL.getHours();
  const minutos  = ahoraCOL.getMinutes();

  if (hora > 18 || (hora === 18 && minutos > 30)) {
    console.log(`\n⏳ Inventario omitido (${hora}:${String(minutos).padStart(2, '0')} COL)`);
    return;
  }

  console.log(`\n🔄 Iniciando sync inventario: ${ahoraCOL.toLocaleString('es-CO')}`);

  await matarChromeSiHay();

  let resultado;

  try {
    resultado = await conReintentos(
      async (intento) => {
        console.log(`\n📌 Intento ${intento}...`);
        return await _ejecutarScraping();
      },
      { maxIntentos: 3, etiqueta: 'inventario' }
    );
  } catch (e) {
    console.error('❌ Inventario falló tras 3 intentos:', e.message);

    await notificarError({
      asunto:   '❌ Error en sync de Inventario AgendaPro',
      script:   'inventario.js',
      error:    e.message,
      contexto: 'El scraping falló en todos los reintentos.',
      intento:  3,
    });

    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// Lógica de scraping separada (para que conReintentos la llame)
// ─────────────────────────────────────────────────────────────
async function _ejecutarScraping() {
  let browser = null;

  try {
    browser = await puppeteer.launch({
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
        '--renderer-process-limit=1',
        '--max-old-space-size=256',
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

    console.log('🔐 Login AgendaPro...');

    await page.goto('https://app.agendapro.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    const campoEmail = await waitForSelectorSafe(
      page,
      'input[placeholder="user@example.com"]',
      15000
    );

    if (!campoEmail) {
      throw new Error('No apareció el campo de email en el login');
    }

    await page.type('input[placeholder="user@example.com"]', EMAIL,    { delay: 40 });
    await page.type('input[placeholder="Enter your password"]', PASSWORD, { delay: 40 });

    await clickLoginButton(page);

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('✅ Login OK');

    await page.goto(URL_INVENTARIO, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(2500);

    let ctx = page;
    for (const frame of [page, ...page.frames()]) {
      try {
        const found = await frame.$('tr[role="row"]');
        if (found) { ctx = frame; break; }
      } catch (_) {}
    }

    const tablaOk = await waitForSelectorSafe(ctx, 'tr[role="row"]', 15000);
    if (!tablaOk) {
      throw new Error('La tabla de inventario no apareció en 15s');
    }

    console.log('✅ Tabla encontrada');

    const totalPaginas = await ctx.evaluate(() => {
      const input = document.querySelector(
        '[data-testid="Table-pagination"] input[type="number"]'
      );
      return input ? parseInt(input.getAttribute('max')) || 1 : 1;
    });

    console.log(`📄 Total páginas: ${totalPaginas}`);

    const todosLosProductos = [];

    for (let pagina = 1; pagina <= totalPaginas; pagina++) {
      console.log(`⏳ Página ${pagina}/${totalPaginas}`);

      const filasOk = await waitForSelectorSafe(
        ctx,
        'tbody[role="rowgroup"] tr[role="row"]',
        10000
      );

      if (!filasOk) {
        console.warn(`⚠️  Página ${pagina}: filas no aparecieron, saltando...`);
        continue;
      }

      // ─── FIX: más margen + esperar a que el precio no esté vacío ───
      await delay(1500);
      await ctx.waitForFunction(() => {
        const primeraCelda = document.querySelector(
          'tbody[role="rowgroup"] tr[role="row"] td[role="cell"]:nth-child(6)'
        );
        return primeraCelda && primeraCelda.textContent.trim() !== '';
      }, { timeout: 8000 }).catch(() => {
        console.warn(`⚠️  Página ${pagina}: precio de la primera fila no se pobló a tiempo`);
      });

      const filas = await extraerFilas(ctx);
      console.log(`   ${filas.length} productos`);
      todosLosProductos.push(...filas);

      if (pagina < totalPaginas) {
        const btnSiguiente = await ctx.$('[data-testid="Table-pagination"] button:last-child');

        if (!btnSiguiente) {
          console.warn('⚠️  Botón siguiente no encontrado, terminando paginación.');
          break;
        }

        await btnSiguiente.click();
        await delay(1500);
      }
    }

    fs.writeFileSync('productos.json', JSON.stringify(todosLosProductos, null, 2), 'utf8');
    fs.writeFileSync('productos.csv',  toCSV(todosLosProductos), 'utf8');

    console.log(`💾 ${todosLosProductos.length} productos guardados`);

    const stats = await actualizarStockEnSupabase(todosLosProductos);
    console.log('✅ Inventario sincronizado');

    return stats;

  } catch (e) {
    try {
      if (browser) {
        const pages = await browser.pages().catch(() => []);
        if (pages.length > 0) {
          await pages[0].screenshot({ path: `error_inventario_${Date.now()}.png` });
          console.log('📸 Screenshot guardado');
        }
      }
    } catch (_) {}

    throw e;

  } finally {
    await cerrarBrowser(browser);
  }
}

module.exports = { sincronizarInventario };
