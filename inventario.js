// ─────────────────────────────────────────────────────────────────────────────
// inventario.js — Scraping de inventario + sync Supabase
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const puppeteer = require('puppeteer');
const fs = require('fs');

const { createClient } = require('@supabase/supabase-js');

const ws = require('ws');

const EMAIL = process.env.AGENDAPRO_EMAIL;
const PASSWORD = process.env.AGENDAPRO_PASSWORD;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const URL_INVENTARIO =
  'https://app.agendapro.com/products/inventory';

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws,
    },
  }
);

const delay = ms =>
  new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// Login resiliente
// ─────────────────────────────────────────────────────────────
async function clickLoginButton(page) {

  const clicked = await page.evaluate(() => {

    const btns = [...document.querySelectorAll('button')];

    const loginBtn = btns.find(b => {

      const txt = b.textContent
        .trim()
        .toLowerCase();

      return (
        txt.includes('ingresar') ||
        txt.includes('login') ||
        txt.includes('iniciar') ||
        txt.includes('entrar') ||
        txt.includes('sign in') ||
        txt.includes('acceder')
      );
    });

    if (loginBtn) {
      loginBtn.click();
      return true;
    }

    return false;
  });

  if (clicked) {
    console.log('✅ Botón login clickeado');
    return;
  }

  console.log('⚠️ Login usando Enter');

  await page.keyboard.press('Enter');
}

// ─────────────────────────────────────────────────────────────
// Extraer filas
// ─────────────────────────────────────────────────────────────
async function extraerFilas(ctx) {

  return await ctx.evaluate(() => {

    const filas = [
      ...document.querySelectorAll(
        'tbody[role="rowgroup"] tr[role="row"]'
      ),
    ];

    return filas.map(fila => {

      const celdas = [
        ...fila.querySelectorAll('td[role="cell"]'),
      ];

      const btnAdd = fila.querySelector(
        '[data-testid^="add-stock-btn-"]'
      );

      const id = btnAdd
        ? btnAdd
            .getAttribute('data-testid')
            .replace('add-stock-btn-', '')
        : null;

      const stockEl = fila.querySelector(
        'td[role="cell"] p.text-sm'
      );

      const stock = stockEl
        ? stockEl.textContent.trim()
        : null;

      return {
        id,

        // TU TABLA USA sku, NO codigo
        sku: celdas[0]?.textContent.trim() || '',

        nombre:
          celdas[1]?.textContent.trim() || '',

        categoria:
          celdas[2]?.textContent.trim() || '',

        marca:
          celdas[3]?.textContent.trim() || '',

        formato:
          celdas[4]?.textContent.trim() || '',

        precio:
          celdas[5]?.textContent.trim() || '',

        stock,
      };
    });
  });
}

// ─────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────
function toCSV(productos) {

  const headers = [
    'id',
    'sku',
    'nombre',
    'categoria',
    'marca',
    'formato',
    'precio',
    'stock',
  ];

  const escape = v =>
    `"${String(v ?? '').replace(/"/g, '""')}"`;

  const rows = productos.map(p =>
    headers.map(h => escape(p[h])).join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

// ─────────────────────────────────────────────────────────────
// Limpiar stock
// ─────────────────────────────────────────────────────────────
function limpiarStock(valor) {

  if (valor == null) return 0;

  const limpio = String(valor)
    .replace(/[^\d-]/g, '');

  return limpio === ''
    ? 0
    : Number(limpio);
}

// ─────────────────────────────────────────────────────────────
// Limpiar precio
// ─────────────────────────────────────────────────────────────
function limpiarPrecio(valor) {

  if (valor == null || valor === '') {
    return 0;
  }

  const limpio = String(valor)
    .replace(/[^0-9,.-]/g, '')
    .replace(/\.(?=\d{3})/g, '')
    .replace(',', '.');

  const num = parseFloat(limpio);

  return isNaN(num)
    ? 0
    : Math.round(num);
}

// ─────────────────────────────────────────────────────────────
// Limpiar categoría
// ─────────────────────────────────────────────────────────────
function limpiarCategoria(valor) {

  if (!valor) return '';

  return valor
    .replace(/uso del salon/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────
// Limpiar marca
// ─────────────────────────────────────────────────────────────
function limpiarMarca(valor) {

  if (!valor) return '';

  const marca = valor.trim();

  // Vaciar Universo Capilar
  if (/universo capilar/i.test(marca)) {
    return '';
  }

  return marca;
}

// ─────────────────────────────────────────────────────────────
// Sync Supabase
// ─────────────────────────────────────────────────────────────
async function actualizarStockEnSupabase(productos) {

  console.log(
    '\n☁️ Sincronizando inventario con Supabase...\n'
  );

  const {
    data: stockActual,
    error: errorLectura,
  } = await supabase
    .from('products')
    .select('*');

  if (errorLectura) {

    console.error(
      '❌ Error leyendo products:',
      errorLectura.message
    );

    return;
  }

  const mapaProductos = {};

  for (const row of stockActual) {
    mapaProductos[String(row.id)] = row;
  }

  const idsIgnorados = new Set([
    '1156817',
    '1156822',
    '801850',
    '1153438',
    '1153445',
    '914694',
    '1156819',
    '821517',
  ]);

  let creados = 0;
  let actualizados = 0;
  let omitidos = 0;
  let errores = 0;

  for (const prod of productos) {

    const id = String(prod.id || '').trim();

    if (!id) continue;

    if (idsIgnorados.has(id)) {
      continue;
    }

    // ─────────────────────────────────────────
    // OMITIR "uso del salon"
    // ─────────────────────────────────────────
    if (
      /uso del salon/i.test(
        prod.categoria || ''
      )
    ) {

      console.log(
        `⏭️ Omitido uso del salon | ${id} | ${prod.nombre}`
      );

      omitidos++;

      continue;
    }

    const dataProducto = {

      id: Number(id),

      // TU DB USA sku
      sku: (prod.sku || '').trim(),

      nombre:
        (prod.nombre || '').trim(),

      // display_name = nombre
      display_name:
        (prod.nombre || '').trim(),

      categoria:
        limpiarCategoria(prod.categoria),

      marca:
        limpiarMarca(prod.marca),

      formato:
        (prod.formato || '').trim(),

      precio:
        limpiarPrecio(prod.precio),

      stock:
        limpiarStock(prod.stock),
    };

    // ─────────────────────────────────────────
    // CREAR
    // ─────────────────────────────────────────
    if (!(id in mapaProductos)) {

      const { error: insertError } =
        await supabase
          .from('products')
          .insert(dataProducto);

      if (insertError) {

        console.error(
          `❌ Error creando ${id}:`,
          insertError.message
        );

        errores++;

        continue;
      }

      console.log(
        `🆕 Producto creado | ${id} | ${dataProducto.nombre}`
      );

      creados++;

      continue;
    }

    const actual = mapaProductos[id];

    // ─────────────────────────────────────────
    // Detectar cambios
    // ─────────────────────────────────────────
    const huboCambios =

      (actual.sku || '') !==
        dataProducto.sku ||

      (actual.nombre || '') !==
        dataProducto.nombre ||

      (actual.display_name || '') !==
        dataProducto.display_name ||

      (actual.categoria || '') !==
        dataProducto.categoria ||

      (actual.marca || '') !==
        dataProducto.marca ||

      (actual.formato || '') !==
        dataProducto.formato ||

      Number(actual.precio || 0) !==
        Number(dataProducto.precio || 0) ||

      Number(actual.stock || 0) !==
        Number(dataProducto.stock || 0);

    if (!huboCambios) {
      continue;
    }

    // ─────────────────────────────────────────
    // UPDATE
    // ─────────────────────────────────────────
    const { error: updateError } =
      await supabase
        .from('products')
        .update(dataProducto)
        .eq('id', Number(id));

    if (updateError) {

      console.error(
        `❌ Error actualizando ID ${id}:`,
        updateError.message
      );

      errores++;

      continue;
    }

    console.log(
      `✅ Actualizado | ${id} | ${dataProducto.nombre}`
    );

    actualizados++;
  }

  console.log('\n═══════════════════════════════════');

  console.log(`🆕 Creados      : ${creados}`);
  console.log(`✅ Actualizados : ${actualizados}`);
  console.log(`⏭️ Omitidos     : ${omitidos}`);
  console.log(`❌ Errores      : ${errores}`);

  console.log('═══════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────────────────────
async function sincronizarInventario() {

  // Hora Colombia
  const ahora = new Date();

  const ahoraCOL = new Date(
    ahora.toLocaleString('en-US', {
      timeZone: 'America/Bogota',
    })
  );

  const hora = ahoraCOL.getHours();

  const minutos = ahoraCOL.getMinutes();

  if (
    hora > 18 ||
    (hora === 18 && minutos > 30)
  ) {

    console.log(
      `\n⏳ Inventario omitido (${hora}:${String(
        minutos
      ).padStart(2, '0')} COL)`
    );

    return;
  }

  console.log(
    `\n🔄 Iniciando sync inventario: ${ahoraCOL.toLocaleString(
      'es-CO'
    )}`
  );

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

    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      undefined,
  });

  const page = await browser.newPage();

  page.setDefaultTimeout(30000);

  await page.setRequestInterception(true);

  page.on('request', req => {

    if (
      ['image', 'stylesheet', 'font', 'media']
        .includes(req.resourceType())
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {

    console.log('🔐 Login AgendaPro...');

    await page.goto(
      'https://app.agendapro.com/login',
      {
        waitUntil: 'domcontentloaded',
      }
    );

    await page.waitForSelector(
      'input[placeholder="user@example.com"]'
    );

    await page.type(
      'input[placeholder="user@example.com"]',
      EMAIL,
      { delay: 40 }
    );

    await page.type(
      'input[placeholder="Enter your password"]',
      PASSWORD,
      { delay: 40 }
    );

    await clickLoginButton(page);

    await page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    console.log('✅ Login OK');

    await page.goto(
      URL_INVENTARIO,
      {
        waitUntil: 'domcontentloaded',
      }
    );

    await delay(2500);

    let ctx = page;

    for (const frame of [
      page,
      ...page.frames(),
    ]) {

      try {

        const found = await frame.$(
          'tr[role="row"]'
        );

        if (found) {
          ctx = frame;
          break;
        }

      } catch (_) {}
    }

    await ctx.waitForSelector(
      'tr[role="row"]',
      {
        timeout: 15000,
      }
    );

    console.log('✅ Tabla encontrada');

    const totalPaginas =
      await ctx.evaluate(() => {

        const input =
          document.querySelector(
            '[data-testid="Table-pagination"] input[type="number"]'
          );

        return input
          ? parseInt(
              input.getAttribute('max')
            ) || 1
          : 1;
      });

    console.log(
      `📄 Total páginas: ${totalPaginas}`
    );

    const todosLosProductos = [];

    for (
      let pagina = 1;
      pagina <= totalPaginas;
      pagina++
    ) {

      console.log(
        `⏳ Página ${pagina}/${totalPaginas}`
      );

      await ctx.waitForSelector(
        'tbody[role="rowgroup"] tr[role="row"]',
        {
          timeout: 10000,
        }
      );

      await delay(600);

      const filas =
        await extraerFilas(ctx);

      console.log(
        `   ${filas.length} productos`
      );

      todosLosProductos.push(...filas);

      if (pagina < totalPaginas) {

        const btnSiguiente =
          await ctx.$(
            '[data-testid="Table-pagination"] button:last-child'
          );

        if (!btnSiguiente) {

          console.warn(
            '⚠️ Botón siguiente no encontrado'
          );

          break;
        }

        await btnSiguiente.click();

        await delay(1500);
      }
    }

    fs.writeFileSync(
      'productos.json',
      JSON.stringify(
        todosLosProductos,
        null,
        2
      ),
      'utf8'
    );

    fs.writeFileSync(
      'productos.csv',
      toCSV(todosLosProductos),
      'utf8'
    );

    console.log(
      `💾 ${todosLosProductos.length} productos guardados`
    );

    await actualizarStockEnSupabase(
      todosLosProductos
    );

    console.log(
      '✅ Inventario sincronizado'
    );

  } catch (e) {

    console.error(
      '❌ Error general:',
      e.message
    );

    throw e;

  } finally {

    await page.close().catch(() => {});

    await browser.close().catch(() => {});
  }
}

module.exports = {
  sincronizarInventario,
};
