// ─────────────────────────────────────────────────────────────────────────────
//  ventas.js — Lógica de ventas Puppeteer (headless para Railway)
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const puppeteer = require('puppeteer');

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Espera que el input sea visible Y clickeable (no cubierto por otro elemento)
async function esperarInputListo(frame, selector, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const el = await frame.$(selector);
      if (el) {
        const box = await el.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          const visible = await frame.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const top  = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top  + rect.height / 2
            );
            return el === top || el.contains(top);
          }, selector);
          if (visible) return el;
        }
      }
    } catch (_) {}
    await delay(200);
  }
  throw new Error(`Input no estuvo listo: ${selector}`);
}

async function ejecutarVenta(productos) {
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
  page.setDefaultTimeout(30000);

  try {
    // ── LOGIN ────────────────────────────────────────────────────────────────
    console.log('🔐 Login...');
    await page.goto('https://app.agendapro.com/login', { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[placeholder="user@example.com"]');
    await page.type('input[placeholder="user@example.com"]', process.env.AGENDAPRO_EMAIL);
    await page.type('input[placeholder="Enter your password"]', process.env.AGENDAPRO_PASSWORD);
    await page.click('button');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('✅ Login OK');

    // ── IR A VENTAS ──────────────────────────────────────────────────────────
    await page.goto('https://app.agendapro.com/payments', { waitUntil: 'networkidle2' });

    // ── NUEVA VENTA ──────────────────────────────────────────────────────────
    console.log('🆕 Nueva venta...');
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('button'))
        .some((b) => b.innerText?.trim() === '+ Nueva venta')
    );
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.innerText?.trim() === '+ Nueva venta')?.click();
    });

    // ── IFRAME ───────────────────────────────────────────────────────────────
    await page.waitForSelector('iframe[title="APIframe"]');
    const frame = await (await page.$('iframe[title="APIframe"]')).contentFrame();
    console.log('✅ Iframe listo');

    // ── ABRIR CARRO ──────────────────────────────────────────────────────────
    await frame.waitForFunction(() =>
      Array.from(document.querySelectorAll('button'))
        .some((b) => b.innerText?.toLowerCase().includes('agregar al carro'))
    );
    await frame.evaluate(() => {
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.innerText?.toLowerCase().includes('agregar al carro'))?.click();
    });

    // ── LOOP PRODUCTOS ───────────────────────────────────────────────────────
    for (const prod of productos) {
      console.log(`🛍️ Procesando: ${prod.nombre} x${prod.cantidad}`);

      // Buscador — esperar que esté visible Y clickeable
      const input = await esperarInputListo(frame, 'input[type="text"]');
      await input.click({ clickCount: 3 });
      await delay(200);
      await input.type(prod.nombre, { delay: 60 });

      // Esperar que aparezca el botón del producto
      await frame.waitForFunction(
        (nombre) => !!document.querySelector(`[data-testid="${nombre}-show-counter"]`),
        { timeout: 8000 },
        prod.nombre
      );

      // Primer click — agregar producto
      await frame.evaluate((nombre) => {
        document.querySelector(`[data-testid="${nombre}-show-counter"]`)?.click();
      }, prod.nombre);

      // ── PROFESIONAL ──────────────────────────────────────────────────────
      await frame.waitForSelector('[data-testid="associate-item-seller-select"]', { timeout: 8000 });
      await frame.evaluate(() => {
        document.querySelector('[data-testid="associate-item-seller-select"]')?.click();
      });

      await frame.waitForFunction(() =>
        Array.from(document.querySelectorAll('[role="option"]'))
          .some((el) => el.innerText?.toLowerCase().includes('uso del salon'))
      );
      await frame.evaluate(() => {
        Array.from(document.querySelectorAll('[role="option"]'))
          .find((el) => el.innerText?.toLowerCase().includes('uso del salon'))?.click();
      });

      // Esperar que el dropdown cierre
      await frame.waitForFunction(() =>
        document.querySelectorAll('[role="option"]').length === 0
      , { timeout: 3000 }).catch(() => {});
      await delay(300);

      // ── CANTIDAD ─────────────────────────────────────────────────────────
      if (prod.cantidad > 1) {
        console.log('🔢 Ajustando cantidad...');
        for (let i = 1; i < prod.cantidad; i++) {
          await frame.evaluate((nombre) => {
            document.querySelector(`[data-testid="${nombre}-show-counter"]`)?.click();
          }, prod.nombre);

          await frame.waitForSelector(`[data-testid="${prod.nombre}-add"]`, { timeout: 5000 });

          await frame.evaluate((nombre) => {
            document.querySelector(`[data-testid="${nombre}-add"]`)?.click();
          }, prod.nombre);

          const esperado = i + 1;
          await frame.waitForFunction(
            (nombre, val) => {
              const btn = document.querySelector(`[data-testid="${nombre}-show-counter"]`);
              return btn?.innerText?.trim() === String(val);
            },
            { timeout: 4000 },
            prod.nombre,
            esperado
          );
        }
      }

      console.log(`✅ ${prod.nombre} agregado`);
    }

// ── IR AL CARRO ──────────────────────────────────────────────────────────────
await frame.waitForFunction(() =>
  Array.from(document.querySelectorAll('button'))
    .some((b) => b.innerText?.toLowerCase().includes('ir al carro'))
);
await frame.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((b) => b.innerText?.toLowerCase().includes('ir al carro'))?.click();
});

// ── CONTINUAR (por data-testid) ───────────────────────────────────────────────
await frame.waitForSelector('[data-testid="cart-continue-button"]', { timeout: 15000 });
await delay(500);
await frame.evaluate(() => {
  document.querySelector('[data-testid="cart-continue-button"]')?.click();
});
console.log('✅ Continuar clickeado');

// ── MÉTODO DE PAGO ───────────────────────────────────────────────────────────
await frame.waitForSelector('[data-testid^="select-payment-method"]', { timeout: 30000 });
await frame.evaluate(() => {
  document.querySelector(
    '[data-testid="select-payment-method-Transferencia Bancaria"]'
  )?.click();
});

    console.log('✅ Venta completada');
    return { mensaje: 'Venta completada exitosamente', productos: productos.length };

  } finally {
    await browser.close();
  }
}

module.exports = { ejecutarVenta };
