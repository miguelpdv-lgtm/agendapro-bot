// ─────────────────────────────────────────────────────────────────────────────
// ventas.js — AgendaPro Puppeteer [VERSIÓN MEJORADA]
// Cambios: Validación de elementos, logs mejorados, manejo de timeouts
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { notificarError } = require("./notificar");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws,
    },
  }
);

const delay = (ms) =>
  new Promise((res) => setTimeout(res, ms));

// ── Configuración de timeouts por contexto ─────────────────────────────────
const TIMEOUTS = {
  busquedaProducto: 15000,  // Buscar en search frame
  cardCarrito: 25000,       // Buscar card editable
  inputDescuento: 12000,    // Input aparecer
  btnGeneral: 10000,        // Botones genéricos
};

// ── Normalizar nombres para data-testid ────────────────────────────────────
function normalizarTestId(nombre) {
  return nombre
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[áéíóúñ]/g, (a) =>
      ({ á: "a", é: "e", í: "i", ó: "o", ú: "u", ñ: "n" }[a])
    );
}

// ── Helper: siempre obtiene el frame fresco del DOM ───────────────────────────
async function getFrame(page) {
  await page.waitForSelector('iframe[title="APIframe"]');
  const handle = await page.$('iframe[title="APIframe"]');
  return handle.contentFrame();
}

// ── Helper: Loguear con timestamp ──────────────────────────────────────────
function log(tipo, mensaje) {
  const timestamp = new Date().toISOString();
  const prefijos = {
    debug: "🔍",
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "❌",
    wait: "⏳",
  };
  console.log(`${prefijos[tipo] || "•"} [${timestamp}] ${mensaje}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DESCUENTOS
// ─────────────────────────────────────────────────────────────────────────────
async function obtenerDescuentos(productos) {
  const nombres = productos.map((p) => p.nombre);

  const { data, error } = await supabase
    .from("products")
    .select("nombre, precio, discount_pct, discount_active")
    .in("nombre", nombres);

  if (error) {
    log("error", `Error descuentos: ${error.message}`);
    return productos;
  }

  return productos.map((prod) => {
    const found = data.find((d) => d.nombre === prod.nombre);

    const tieneDescuento =
      found?.discount_active && found?.discount_pct > 0;

    return {
      ...prod,
      precio_original: found?.precio ?? null,
      discount_pct: tieneDescuento ? found.discount_pct : 0,
      tiene_descuento: tieneDescuento,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// VENTA
// ─────────────────────────────────────────────────────────────────────────────
async function ejecutarVenta(productos) {
  productos = await obtenerDescuentos(productos);

  const browser = await puppeteer.launch({
    headless: process.env.DEBUG_HEADLESS === "false" ? false : true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  
  // Usar timeout personalizado si existe en .env
  const timeoutGlobal = parseInt(process.env.PUPPETEER_TIMEOUT) || 60000;
  page.setDefaultTimeout(timeoutGlobal);
  
  log("info", `Timeout global: ${timeoutGlobal}ms`);

  try {
    // ───────────────────────────────────────────────────────────────────────
    // LOGIN
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Iniciando login...");

    await page.goto("https://app.agendapro.com/login", {
      waitUntil: "networkidle2",
    });

    await page.waitForSelector('input[placeholder="user@example.com"]');

    await page.type(
      'input[placeholder="user@example.com"]',
      process.env.AGENDAPRO_EMAIL
    );

    await page.type(
      'input[placeholder="Enter your password"]',
      process.env.AGENDAPRO_PASSWORD
    );

    await page.click("button");

    await page.waitForNavigation({ waitUntil: "networkidle2" });

    log("success", "Login completado");

    // ───────────────────────────────────────────────────────────────────────
    // PAGOS
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Navegando a pagos...");
    
    await page.goto("https://app.agendapro.com/payments", {
      waitUntil: "networkidle2",
    });

    // ───────────────────────────────────────────────────────────────────────
    // NUEVA VENTA
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Buscando botón 'Nueva venta'...");

    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.innerText?.trim() === "+ Nueva venta"
      )
    );

    await page.evaluate(() => {
      Array.from(document.querySelectorAll("button"))
        .find((b) => b.innerText?.trim() === "+ Nueva venta")
        ?.click();
    });

    log("success", "Botón 'Nueva venta' clickeado");

    // ───────────────────────────────────────────────────────────────────────
    // CÓDIGO
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Ingresando código...");
    
    await page.waitForSelector('input[placeholder="Código"]');

    await page.type('input[placeholder="Código"]', "0305", { delay: 80 });

    await page.keyboard.press("Enter");

    log("success", "Código 0305 ingresado");

    await delay(1200);

    // ───────────────────────────────────────────────────────────────────────
    // IFRAME
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Esperando iframe...");
    
    await page.waitForSelector('iframe[title="APIframe"]');

    log("success", "Iframe disponible");

    // ───────────────────────────────────────────────────────────────────────
    // AGREGAR AL CARRO
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Buscando botón 'Agregar al carro'...");
    
    let frame = await getFrame(page);

    await frame.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.innerText?.toLowerCase().includes("agregar al carro")
      )
    );

    await frame.evaluate(() => {
      Array.from(document.querySelectorAll("button"))
        .find((b) =>
          b.innerText?.toLowerCase().includes("agregar al carro")
        )
        ?.click();
    });

    log("success", "Carrito abierto");

    await delay(1500);

    // ───────────────────────────────────────────────────────────────────────
    // PRODUCTOS
    // ───────────────────────────────────────────────────────────────────────
    for (const prod of productos) {
      log("info", `Procesando: ${prod.nombre} x${prod.cantidad}`);

      // ── Siempre re-obtener el frame por si se recreó ──────────────────────
      frame = await getFrame(page);

      await frame.waitForSelector('input[type="text"]');

      await frame.evaluate(() => {
        const input = document.querySelector('input[type="text"]');
        if (!input) return;
        input.focus();
        input.select();
      });

      await delay(300);

      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");

      await delay(200);

      await frame.type('input[type="text"]', prod.nombre, { delay: 60 });

      log("wait", `Buscando "${prod.nombre}" en AgendaPro...`);

      // ── VALIDACIÓN: Verificar que el elemento existe ANTES de esperar ────
      const nombreNormalizado = normalizarTestId(prod.nombre);
      
      const elementoExiste = await frame.evaluate((normalizado) => {
        return Array.from(document.querySelectorAll("[data-testid]")).some(
          (el) =>
            el.dataset.testid.replace(/\s*-\s*/g, "-").trim().toLowerCase() ===
            `${normalizado}-show-counter`
        );
      }, nombreNormalizado);

      if (!elementoExiste) {
        // Loguear todos los elementos disponibles para debug
        const disponibles = await frame.evaluate(() => {
          return Array.from(document.querySelectorAll("[data-testid]"))
            .map((el) => el.dataset.testid)
            .filter((id) => id.includes("show-counter"))
            .slice(0, 10);
        });

        log("error", `"${prod.nombre}" no encontrado en AgendaPro`);
        log("debug", `Productos disponibles: ${disponibles.join(", ")}`);
        
        throw new Error(`Producto "${prod.nombre}" no existe en AgendaPro`);
      }

      // ── FIX: normalizar testid — quitar espacios antes/después del guión ──
      await frame.waitForFunction(
        (normalizado) =>
          Array.from(document.querySelectorAll("[data-testid]")).some(
            (el) =>
              el.dataset.testid
                .replace(/\s*-\s*/g, "-")
                .trim()
                .toLowerCase() === `${normalizado}-show-counter`
          ),
        { timeout: TIMEOUTS.busquedaProducto },
        nombreNormalizado
      );

      await frame.evaluate((normalizado) => {
        const el = Array.from(document.querySelectorAll("[data-testid]")).find(
          (el) =>
            el.dataset.testid
              .replace(/\s*-\s*/g, "-")
              .trim()
              .toLowerCase() === `${normalizado}-show-counter`
        );
        el?.click();
      }, nombreNormalizado);

      log("success", `${prod.nombre} encontrado en búsqueda`);

      // ─────────────────────────────────────────────────────────────────────
      // VENDEDOR
      // ─────────────────────────────────────────────────────────────────────
      log("wait", "Seleccionando vendedor...");
      
      await frame.waitForSelector(
        '[data-testid="associate-item-seller-select"]'
      );

      await frame.evaluate(() => {
        document
          .querySelector('[data-testid="associate-item-seller-select"]')
          ?.click();
      });

      await frame.waitForFunction(() =>
        Array.from(document.querySelectorAll('[role="option"]')).some((el) =>
          el.innerText?.toLowerCase().includes("ema")
        ),
        { timeout: TIMEOUTS.btnGeneral }
      );

      await frame.evaluate(() => {
        Array.from(document.querySelectorAll('[role="option"]'))
          .find((el) => el.innerText?.toLowerCase().includes("ema"))
          ?.click();
      });

      log("success", "Vendedor (EMA) seleccionado");

      await delay(500);

      // ─────────────────────────────────────────────────────────────────────
      // CANTIDAD
      // ─────────────────────────────────────────────────────────────────────
      if (prod.cantidad > 1) {
        log("info", `Ajustando cantidad a ${prod.cantidad}...`);
        
        for (let i = 1; i < prod.cantidad; i++) {
          // ── FIX: normalizar testid ────────────────────────────────────────
          await frame.evaluate((normalizado) => {
            const el = Array.from(document.querySelectorAll("[data-testid]")).find(
              (el) =>
                el.dataset.testid
                  .replace(/\s*-\s*/g, "-")
                  .trim()
                  .toLowerCase() === `${normalizado}-show-counter`
            );
            el?.click();
          }, nombreNormalizado);

          await frame.waitForFunction(
            (normalizado) =>
              Array.from(document.querySelectorAll("[data-testid]")).some(
                (el) =>
                  el.dataset.testid
                    .replace(/\s*-\s*/g, "-")
                    .trim()
                    .toLowerCase() === `${normalizado}-add`
              ),
            { timeout: TIMEOUTS.btnGeneral },
            nombreNormalizado
          );

          await frame.evaluate((normalizado) => {
            const el = Array.from(document.querySelectorAll("[data-testid]")).find(
              (el) =>
                el.dataset.testid
                  .replace(/\s*-\s*/g, "-")
                  .trim()
                  .toLowerCase() === `${normalizado}-add`
            );
            el?.click();
          }, nombreNormalizado);

          await delay(300);
        }
      }

      log("success", `${prod.nombre} x${prod.cantidad} agregado`);
    }

    // ───────────────────────────────────────────────────────────────────────
    // IR AL CARRITO
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Navegando al carrito...");

    frame = await getFrame(page);

    await frame.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.innerText?.toLowerCase().includes("ir al carro")
        ),
      { timeout: TIMEOUTS.btnGeneral }
    );

    await frame.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText?.toLowerCase().includes("ir al carro")
      );
      if (btn) {
        btn.scrollIntoView({ block: "center" });
        btn.click();
      }
    });

    await delay(2500);

    log("success", "Carrito abierto");

    // ───────────────────────────────────────────────────────────────────────
    // DESCUENTOS
    // ───────────────────────────────────────────────────────────────────────
    const productosConDescuento = productos.filter(
      (p) => p.tiene_descuento && p.discount_pct > 0
    );

    if (productosConDescuento.length > 0) {
      log("info", `Aplicando ${productosConDescuento.length} descuentos...`);

      frame = await getFrame(page);

      for (const prod of productosConDescuento) {
        log("info", `Descuento: ${prod.nombre} → ${prod.discount_pct}%`);

        // Esperar que el carrito termine de renderizar
        await delay(1500);

        const nombreNormalizado = normalizarTestId(prod.nombre);
        const testId = `edit-product-${nombreNormalizado}`;

        // ── VALIDACIÓN: Verificar que el botón de edición existe ────────────
        const btnEditExiste = await frame.evaluate((testId) => {
          return Array.from(document.querySelectorAll("[data-testid]")).some(
            (el) =>
              el.dataset.testid
                .replace(/\s*-\s*/g, "-")
                .trim()
                .toLowerCase() === testId
          );
        }, testId.toLowerCase());

        if (!btnEditExiste) {
          const disponibles = await frame.evaluate(() => {
            return Array.from(document.querySelectorAll("[data-testid]"))
              .map((el) => el.dataset.testid)
              .filter((id) => id.includes("edit-product"))
              .slice(0, 10);
          });

          log("error", `Botón editar no encontrado para "${prod.nombre}"`);
          log("debug", `Botones disponibles: ${disponibles.join(", ")}`);
          
          throw new Error(`No se puede editar "${prod.nombre}" en carrito`);
        }

        // ── FIX: normalizar testid — quitar espacios antes/después del guión ──
        await frame.waitForFunction(
          (testId) =>
            Array.from(document.querySelectorAll("[data-testid]")).some(
              (el) =>
                el.dataset.testid
                  .replace(/\s*-\s*/g, "-")
                  .trim()
                  .toLowerCase() === testId
            ),
          { timeout: TIMEOUTS.cardCarrito },
          testId.toLowerCase()
        );

        await frame.evaluate((testId) => {
          const btn = Array.from(document.querySelectorAll("[data-testid]")).find(
            (el) =>
              el.dataset.testid
                .replace(/\s*-\s*/g, "-")
                .trim()
                .toLowerCase() === testId
          );
          if (!btn) return;
          btn.scrollIntoView({ block: "center", behavior: "smooth" });
        }, testId.toLowerCase());

        await delay(500);

        await frame.evaluate((testId) => {
          const btn = Array.from(document.querySelectorAll("[data-testid]")).find(
            (el) =>
              el.dataset.testid
                .replace(/\s*-\s*/g, "-")
                .trim()
                .toLowerCase() === testId
          );
          if (!btn) return;
          btn.focus();
          btn.click();
        }, testId.toLowerCase());

        log("success", "Card de producto abierta");

        log("wait", "Esperando input de descuento...");

        await frame.waitForFunction(
          () =>
            !!document.querySelector('input[data-testid$="unitDiscount"]'),
          { timeout: TIMEOUTS.inputDescuento }
        );

        log("success", "Input de descuento encontrado");

        log("info", `Aplicando descuento: ${prod.discount_pct}%`);

        await frame.evaluate((pct) => {
          const el = document.querySelector(
            'input[data-testid$="unitDiscount"]'
          );
          if (!el) return;

          el.focus();
          el.select();

          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          ).set;

          setter.call(el, String(pct));

          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, prod.discount_pct);

        await delay(500);

        await frame.evaluate(() => {
          const el = document.querySelector(
            'input[data-testid$="unitDiscount"]'
          );
          if (!el) return;
          el.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
          );
          el.dispatchEvent(
            new KeyboardEvent("keyup", { key: "Enter", bubbles: true })
          );
        });

        await delay(800);

        const valorFinal = await frame.evaluate(() => {
          const el = document.querySelector(
            'input[data-testid$="unitDiscount"]'
          );
          return el ? el.value : null;
        });

        log("debug", `Valor descuento aplicado: ${valorFinal}`);

        if (!valorFinal || valorFinal === "0" || valorFinal === "0.0") {
          throw new Error(
            `Descuento no aplicado en "${prod.nombre}"`
          );
        }

        log("success", `Descuento ${prod.discount_pct}% confirmado`);

        const cerrado = await frame.evaluate(() => {
          const guardar = Array.from(
            document.querySelectorAll("button")
          ).find((b) =>
            b.innerText?.toLowerCase().includes("guardar")
          );
          if (guardar) {
            guardar.click();
            return "guardar";
          }
          return null;
        });

        if (!cerrado) {
          await page.keyboard.press("Escape");
        }

        await delay(1000);
      }

      log("success", "Todos los descuentos aplicados");
    }

    // ───────────────────────────────────────────────────────────────────────
    // CONTINUAR
    // ───────────────────────────────────────────────────────────────────────
    log("info", "Continuando al checkout...");

    frame = await getFrame(page);

    await frame.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.innerText?.toLowerCase().includes("continuar")
        ),
      { timeout: TIMEOUTS.btnGeneral }
    );

    await frame.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText?.toLowerCase().includes("continuar")
      );
      if (!btn) return;
      btn.scrollIntoView({ block: "center" });
      btn.click();
    });

    log("success", "Continuando con checkout");

    // ───────────────────────────────────────────────────────────────────────
    // MÉTODO PAGO
    // ───────────────────────────────────────────────────────────────────────
    await delay(3000);

    frame = await getFrame(page);

    log("info", "Seleccionando método de pago...");

    await frame.waitForSelector('[data-testid="select-payment-method"]');

    await frame.waitForFunction(() => {
      const btn = document.querySelector(
        '[data-testid="select-payment-method-Transferencia Bancaria"]'
      );
      return btn && !btn.disabled;
    }, { timeout: TIMEOUTS.btnGeneral });

    await frame.evaluate(() => {
      document
        .querySelector(
          '[data-testid="select-payment-method-Transferencia Bancaria"]'
        )
        ?.click();
    });

    log("success", "✨ Transferencia Bancaria seleccionada");

    await delay(3000);

  } catch (err) {
    // ── Capturar screenshot si está disponible ─────────────────────────────
    try {
      await page.screenshot({
        path: `/tmp/error-ventas-${Date.now()}.png`,
        fullPage: true,
      });
      log("info", "Screenshot de error guardado");
    } catch (screenshotErr) {
      log("warning", "No se pudo capturar screenshot");
    }

    // ── Notificar por correo cualquier error dentro de la venta ─────────────
    const nombresProductos = productos
      .map((p) => `${p.nombre} x${p.cantidad}`)
      .join(", ");
    
    await notificarError({
      asunto: "❌ Venta fallida — AgendaPro Bot",
      script: "ventas.js",
      error: err.message,
      contexto: `Productos: ${nombresProductos}`,
      detalles: `Timeout: ${page.getDefaultTimeout()}ms`,
    });
    
    throw err; // re-lanzar para que cola.js también lo registre
  } finally {
    await browser.close();
    log("info", "Navegador cerrado");
  }
}

module.exports = {
  ejecutarVenta,
};
