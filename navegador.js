// ─────────────────────────────────────────────────────────────────────────────
// navegador.js — Helpers compartidos de Playwright
// Cubre las piezas de Puppeteer que no tienen equivalente 1:1 en Playwright,
// para que el resto de los scripts quede idéntico al original.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const { chromium } = require('playwright');

/**
 * Ruta al ejecutable de Chrome/Chromium.
 *  - PLAYWRIGHT_EXECUTABLE_PATH tiene prioridad.
 *  - PUPPETEER_EXECUTABLE_PATH se respeta solo si el binario existe, para no
 *    romper despliegues viejos que todavía la tengan configurada.
 *  - undefined → Playwright usa el Chromium que descarga por su cuenta.
 */
function rutaEjecutable() {
  const explicita = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (explicita) return explicita;

  const heredada = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (heredada && fs.existsSync(heredada)) return heredada;

  return undefined;
}

/**
 * Equivalente a puppeteer.launch({ headless: true, args, executablePath }).
 */
function lanzarNavegador({ args = [] } = {}) {
  return chromium.launch({
    headless: true,
    args,
    executablePath: rutaEjecutable(),
    timeout: 30000,
  });
}

/**
 * Mutex global para serializar el lanzamiento de Chromium.
 * ventas.js, inventario.js y corregir-precios.js compiten por la misma RAM
 * si lanzan Chromium en paralelo (spawn EAGAIN), así que cada flujo debe
 * adquirir este mutex antes de lanzarNavegador() y liberarlo al terminar.
 */
function crearMutex() {
  let colaEspera = Promise.resolve();

  function adquirir() {
    let liberar;
    const listo = new Promise((resolve) => {
      liberar = resolve;
    });

    const turno = colaEspera.then(() => liberar);
    colaEspera = colaEspera.then(() => listo);

    return turno;
  }

  return { adquirir };
}

const bloqueoNavegador = crearMutex();

/**
 * Equivalente a browser.pages() de Puppeteer.
 * En Playwright las páginas cuelgan de los BrowserContext.
 */
function paginasDe(browser) {
  if (!browser) return [];
  try {
    return browser.contexts().flatMap((ctx) => ctx.pages());
  } catch (_) {
    return [];
  }
}

/**
 * Equivalente a page.type() / frame.type() de Puppeteer:
 * enfoca el elemento y escribe con el teclado de la página.
 *
 * @param {import('playwright').Page|import('playwright').Frame} ctx
 * @param {string} selector
 * @param {string} texto
 * @param {{ delay?: number }} [opciones]
 */
async function escribir(ctx, selector, texto, opciones = {}) {
  await ctx.locator(selector).first().focus();
  const page = typeof ctx.page === 'function' ? ctx.page() : ctx;
  await page.keyboard.type(texto ?? '', opciones);
}

module.exports = {
  chromium,
  lanzarNavegador,
  rutaEjecutable,
  paginasDe,
  escribir,
  bloqueoNavegador,
};
