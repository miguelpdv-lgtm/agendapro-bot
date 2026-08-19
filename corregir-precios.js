// ─────────────────────────────────────────────────────────────────────────────
// corregir-precios.js — Re-scrapea AgendaPro y corrige precios en Supabase
// Version "funcion exportable" para disparar desde una ruta HTTP temporal.
// Migrado a Playwright
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const ws        = require('ws');
const { lanzarNavegador, escribir } = require('./navegador');

const EMAIL    = process.env.AGENDAPRO_EMAIL;
const PASSWORD = process.env.AGENDAPRO_PASSWORD;

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const URL_INVENTARIO            = 'https://app.agendapro.com/products/inventory';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws },
});

const delay = ms => new Promise(r => setTimeout(r, ms));

async function waitForSelectorSafe(ctx, selector, timeout = 15000) {
  try {
    return await ctx.waitForSelector(selector, { state: 'attached', timeout });
  } catch (_) {
    return null;
  }
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

async function extraerFilas(ctx) {
  return ctx.evaluate(() => {
    const filas = [...document.querySelectorAll('tbody[role="rowgroup"] tr[role="row"]')];
    return filas.map(fila => {
      const celdas      = [...fila.querySelectorAll('td[role="cell"]')];
      const btnAdd      = fila.querySelector('[data-testid^="add-stock-btn-"]');
      const id          = btnAdd ? btnAdd.getAttribute('data-testid').replace('add-stock-btn-', '') : null;
      const stockEl     = fila.querySelector('td[role="cell"] p.text-sm');
      const celdaPrecio = celdas[5];
      return {
        id,
        sku:         celdas[0]?.textContent.trim() || '',
        nombre:      celdas[1]?.textContent.trim() || '',
        precio:      celdaPrecio?.textContent.trim() || '',
        precio_html: celdaPrecio ? celdaPrecio.innerHTML.trim() : '(sin celda)',
        stock:       stockEl ? stockEl.textContent.trim() : null,
      };
    });
  });
}

async function corregirPrecios(modo = 'dry-run') {
  let browser = null;
  const log = [];
  const pushLog = (msg) => { console.log(msg); log.push(msg); };

  try {
    pushLog(`Modo: ${modo.toUpperCase()}`);

    browser = await lanzarNavegador({
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        // '--single-process' NO va con Playwright: mata el navegador al cargar.
        '--disable-gpu', '--no-zygote', '--disable-extensions',
        '--disable-background-networking', '--disable-default-apps', '--mute-audio',
      ],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    pushLog('Login AgendaPro...');
    await page.goto('https://app.agendapro.com/login', { waitUntil: 'domcontentloaded', timeout: 20000 });

    const campoEmail = await waitForSelectorSafe(page, 'input[placeholder="user@example.com"]', 15000);
    if (!campoEmail) throw new Error('No aparecio el campo de email en el login');

    await escribir(page, 'input[placeholder="user@example.com"]', EMAIL, { delay: 40 });
    await escribir(page, 'input[placeholder="Enter your password"]', PASSWORD, { delay: 40 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      (async () => {
        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(b =>
            /ingresar|login|iniciar|entrar|sign in|acceder/i.test(b.textContent)
          );
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!clicked) await page.keyboard.press('Enter');
      })(),
    ]);

    pushLog('Login OK');

    await page.goto(URL_INVENTARIO, { waitUntil: 'networkidle', timeout: 30000 });
    await delay(3000);

    let ctx = page;
    for (const frame of [page, ...page.frames()]) {
      try {
        if (await frame.locator('tr[role="row"]').count()) { ctx = frame; break; }
      } catch (_) {}
    }

    const tablaOk = await waitForSelectorSafe(ctx, 'tr[role="row"]', 15000);
    if (!tablaOk) throw new Error('La tabla de inventario no aparecio');
    pushLog('Tabla encontrada');

    const totalPaginas = await ctx.evaluate(() => {
      const input = document.querySelector('[data-testid="Table-pagination"] input[type="number"]');
      return input ? parseInt(input.getAttribute('max')) || 1 : 1;
    });
    pushLog(`Total paginas: ${totalPaginas}`);

    const todosLosProductos = [];

    for (let pagina = 1; pagina <= totalPaginas; pagina++) {
      const filasOk = await waitForSelectorSafe(ctx, 'tbody[role="rowgroup"] tr[role="row"]', 10000);
      if (!filasOk) { pushLog(`Pagina ${pagina}: filas no aparecieron, saltando...`); continue; }

      let precioListo = false;
      for (let i = 0; i < 6; i++) {
        precioListo = await ctx.evaluate(() => {
          const celda = document.querySelector('tbody[role="rowgroup"] tr[role="row"] td[role="cell"]:nth-child(6)');
          return !!(celda && celda.textContent.trim() !== '');
        });
        if (precioListo) break;
        await delay(500);
      }

      const filas = await extraerFilas(ctx);
      const vacios = filas.filter(f => limpiarPrecio(f.precio) === 0).length;
      pushLog(`Pagina ${pagina}/${totalPaginas} - ${filas.length} productos, ${vacios} con precio vacio`);
      todosLosProductos.push(...filas);

      if (pagina < totalPaginas) {
        const btnSiguiente = ctx
          .locator('[data-testid="Table-pagination"] button:last-child')
          .first();
        if (await btnSiguiente.count() === 0) { pushLog('Boton siguiente no encontrado.'); break; }
        await btnSiguiente.click();
        await delay(1800);
      }
    }

    try { fs.writeFileSync('/tmp/precios-reporte.json', JSON.stringify(todosLosProductos, null, 2), 'utf8'); } catch (_) {}

    const totalVacios = todosLosProductos.filter(p => limpiarPrecio(p.precio) === 0).length;
    const ratioOk = 1 - (totalVacios / (todosLosProductos.length || 1));

    pushLog(`Total: ${todosLosProductos.length} | vacios: ${totalVacios} | % valido: ${(ratioOk * 100).toFixed(1)}%`);

    const ejemplosVacios = todosLosProductos
      .filter(p => limpiarPrecio(p.precio) === 0)
      .slice(0, 5)
      .map(p => ({ id: p.id, nombre: p.nombre, precio_html: p.precio_html }));

    if (modo === 'dry-run') {
      return {
        ok: true, modo, total: todosLosProductos.length, vacios: totalVacios,
        ratioValido: ratioOk, ejemplosVacios, log,
      };
    }

    if (ratioOk < 0.8) {
      pushLog('Menos del 80% valido. NO se escribe en Supabase.');
      return { ok: false, modo, motivo: 'ratio_bajo', ratioValido: ratioOk, ejemplosVacios, log };
    }

    pushLog('Escribiendo precios en Supabase...');
    let actualizados = 0, saltados = 0, errores = 0;

    for (const prod of todosLosProductos) {
      const id = String(prod.id || '').trim();
      if (!id) continue;
      const precio = limpiarPrecio(prod.precio);
      if (precio === 0) { saltados++; continue; }

      const { error } = await supabase.from('products').update({ precio }).eq('id', Number(id));
      if (error) { pushLog(`Error ${id}: ${error.message}`); errores++; continue; }
      actualizados++;
    }

    pushLog(`Actualizados: ${actualizados} | Saltados: ${saltados} | Errores: ${errores}`);
    return { ok: true, modo, actualizados, saltados, errores, log };

  } catch (e) {
    pushLog(`Error fatal: ${e.message}`);
    return { ok: false, error: e.message, log };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { corregirPrecios };
