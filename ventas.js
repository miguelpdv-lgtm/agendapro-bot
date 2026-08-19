// ─────────────────────────────────────────────────────────────────────────────
// ventas.js — AgendaPro Playwright
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { notificarError } = require("./notificar");
const { lanzarNavegador, escribir } = require("./navegador");

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

// ── Helper: siempre obtiene el frame fresco del DOM ───────────────────────────
async function getFrame(page) {
  await page.waitForSelector('iframe[title="APIframe"]', { state: "attached" });
  const handle = await page
    .locator('iframe[title="APIframe"]')
    .first()
    .elementHandle();
  return handle.contentFrame();
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
    console.error("❌ Error descuentos:", error.message);
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

  const browser = await lanzarNavegador({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    // ───────────────────────────────────────────────────────────────────────
    // LOGIN
    // ───────────────────────────────────────────────────────────────────────
    console.log("🔐 Login...");

    await page.goto("https://app.agendapro.com/login", {
      waitUntil: "networkidle",
    });

    await page.waitForSelector('input[placeholder="user@example.com"]', {
      state: "attached",
    });

    await escribir(
      page,
      'input[placeholder="user@example.com"]',
      process.env.AGENDAPRO_EMAIL
    );

    await escribir(
      page,
      'input[placeholder="Enter your password"]',
      process.env.AGENDAPRO_PASSWORD
    );

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.locator("button").first().click(),
    ]);

    console.log("✅ Login OK");

    // ───────────────────────────────────────────────────────────────────────
    // PAGOS
    // ───────────────────────────────────────────────────────────────────────
    await page.goto("https://app.agendapro.com/payments", {
      waitUntil: "networkidle",
    });

    // ───────────────────────────────────────────────────────────────────────
    // NUEVA VENTA
    // ───────────────────────────────────────────────────────────────────────
    console.log("🆕 Nueva venta...");

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

    // ───────────────────────────────────────────────────────────────────────
    // CÓDIGO
    // ───────────────────────────────────────────────────────────────────────
    await page.waitForSelector('input[placeholder="Código"]', {
      state: "attached",
    });

    await escribir(page, 'input[placeholder="Código"]', "0305", { delay: 80 });

    await page.keyboard.press("Enter");

    console.log("✅ Código ingresado");

    await delay(1200);

    // ───────────────────────────────────────────────────────────────────────
    // IFRAME
    // ───────────────────────────────────────────────────────────────────────
    await page.waitForSelector('iframe[title="APIframe"]', {
      state: "attached",
    });

    console.log("✅ Iframe listo");

    // ───────────────────────────────────────────────────────────────────────
    // AGREGAR AL CARRO
    // ───────────────────────────────────────────────────────────────────────
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

    await delay(1500);

    // ───────────────────────────────────────────────────────────────────────
    // PRODUCTOS
    // ───────────────────────────────────────────────────────────────────────
    for (const prod of productos) {
      console.log(`🛍️ ${prod.nombre} x${prod.cantidad}`);

      // ── Siempre re-obtener el frame por si se recreó ──────────────────────
      frame = await getFrame(page);

      await frame.waitForSelector('input[type="text"]', { state: "attached" });

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

      await escribir(frame, 'input[type="text"]', prod.nombre, { delay: 60 });

      console.log(`🔍 Buscando ${prod.nombre}`);

      // ── FIX: normalizar testid — quitar espacios antes/después del guión ──
      await frame.waitForFunction(
        (nombre) =>
          Array.from(document.querySelectorAll("[data-testid]")).some(
            (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `${nombre}-show-counter`
          ),
        prod.nombre,
        { timeout: 10000 }
      );

      await frame.evaluate((nombre) => {
        const el = Array.from(document.querySelectorAll("[data-testid]")).find(
          (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `${nombre}-show-counter`
        );
        el?.click();
      }, prod.nombre);

      // ─────────────────────────────────────────────────────────────────────
      // VENDEDOR
      // ─────────────────────────────────────────────────────────────────────
      await frame.waitForSelector(
        '[data-testid="associate-item-seller-select"]',
        { state: "attached" }
      );

      await frame.evaluate(() => {
        document
          .querySelector('[data-testid="associate-item-seller-select"]')
          ?.click();
      });

      await frame.waitForFunction(() =>
        Array.from(document.querySelectorAll('[role="option"]')).some((el) =>
          el.innerText?.toLowerCase().includes("ema")
        )
      );

      await frame.evaluate(() => {
        Array.from(document.querySelectorAll('[role="option"]'))
          .find((el) => el.innerText?.toLowerCase().includes("ema"))
          ?.click();
      });

      await delay(500);

      // ─────────────────────────────────────────────────────────────────────
      // CANTIDAD
      // ─────────────────────────────────────────────────────────────────────
      if (prod.cantidad > 1) {
        for (let i = 1; i < prod.cantidad; i++) {
          // ── FIX: normalizar testid ────────────────────────────────────────
          await frame.evaluate((nombre) => {
            const el = Array.from(document.querySelectorAll("[data-testid]")).find(
              (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `${nombre}-show-counter`
            );
            el?.click();
          }, prod.nombre);

          await frame.waitForFunction(
            (nombre) =>
              Array.from(document.querySelectorAll("[data-testid]")).some(
                (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `${nombre}-add`
              ),
            prod.nombre,
            { timeout: 10000 }
          );

          await frame.evaluate((nombre) => {
            const el = Array.from(document.querySelectorAll("[data-testid]")).find(
              (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `${nombre}-add`
            );
            el?.click();
          }, prod.nombre);

          await delay(300);
        }
      }

      console.log(`✅ ${prod.nombre} agregado`);
    }

    // ───────────────────────────────────────────────────────────────────────
    // IR AL CARRITO
    // ───────────────────────────────────────────────────────────────────────
    console.log("🛒 Ir al carrito...");

    frame = await getFrame(page);

    await frame.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.innerText?.toLowerCase().includes("ir al carro")
      )
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

    console.log("✅ Dentro del carrito");

    // ───────────────────────────────────────────────────────────────────────
    // DESCUENTOS
    // ───────────────────────────────────────────────────────────────────────
    const productosConDescuento = productos.filter(
      (p) => p.tiene_descuento && p.discount_pct > 0
    );

    if (productosConDescuento.length > 0) {
      console.log("🏷️ Aplicando descuentos...");

      frame = await getFrame(page);

      for (const prod of productosConDescuento) {
        console.log(`🔍 Buscando card carrito: ${prod.nombre}`);

        // Esperar que el carrito termine de renderizar
        await delay(1500);

        // ── FIX: normalizar testid — quitar espacios antes/después del guión ──
        await frame.waitForFunction(
          (nombre) =>
            Array.from(document.querySelectorAll("[data-testid]")).some(
              (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `edit-product-${nombre}`
            ),
          prod.nombre,
          { timeout: 20000 }
        );

        await frame.evaluate((nombre) => {
          const btn = Array.from(document.querySelectorAll("[data-testid]")).find(
            (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `edit-product-${nombre}`
          );
          if (!btn) return;
          btn.scrollIntoView({ block: "center", behavior: "smooth" });
        }, prod.nombre);

        await delay(500);

        await frame.evaluate((nombre) => {
          const btn = Array.from(document.querySelectorAll("[data-testid]")).find(
            (el) => el.dataset.testid.replace(/\s*-\s*/g, "-").trim() === `edit-product-${nombre}`
          );
          if (!btn) return;
          btn.focus();
          btn.click();
        }, prod.nombre);

        console.log("✅ Card clickeada");

        console.log("⏳ Esperando input de descuento...");

        await frame.waitForFunction(
          () =>
            !!document.querySelector('input[data-testid$="unitDiscount"]'),
          undefined,
          { timeout: 15000 }
        );

        console.log("✅ Input descuento encontrado");

        console.log(`✏️ Aplicando ${prod.discount_pct}%`);

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

          el.dispatchEvent(new Event("input",  { bubbles: true }));
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

        console.log(`🔍 Valor descuento aplicado: ${valorFinal}`);

        if (!valorFinal || valorFinal === "0" || valorFinal === "0.0") {
          throw new Error(
            `❌ Descuento no aplicado en "${prod.nombre}"`
          );
        }

        console.log("✅ Descuento confirmado");

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

      console.log("✅ Todos los descuentos aplicados");
    }

    // ───────────────────────────────────────────────────────────────────────
    // CONTINUAR
    // ───────────────────────────────────────────────────────────────────────
    console.log("➡️ Continuar...");

    frame = await getFrame(page);

    await frame.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.innerText?.toLowerCase().includes("continuar")
      )
    );

    await frame.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText?.toLowerCase().includes("continuar")
      );
      if (!btn) return;
      btn.scrollIntoView({ block: "center" });
      btn.click();
    });

    console.log("✅ Continuar OK");

    // ───────────────────────────────────────────────────────────────────────
    // MÉTODO PAGO
    // ───────────────────────────────────────────────────────────────────────
    await delay(3000);

    frame = await getFrame(page);

    await frame.waitForSelector('[data-testid="select-payment-method"]', {
      state: "attached",
    });

    await frame.waitForFunction(() => {
      const btn = document.querySelector(
        '[data-testid="select-payment-method-Transferencia Bancaria"]'
      );
      return btn && !btn.disabled;
    });

    await frame.evaluate(() => {
      document
        .querySelector(
          '[data-testid="select-payment-method-Transferencia Bancaria"]'
        )
        ?.click();
    });

    console.log("✅ Transferencia Bancaria seleccionada");

    await delay(3000);

  } catch (err) {
    // ── Notificar por correo cualquier error dentro de la venta ─────────────
    const nombresProductos = productos.map((p) => `${p.nombre} x${p.cantidad}`).join(", ");
    await notificarError({
      asunto: "❌ Venta fallida — AgendaPro Bot",
      script: "ventas.js",
      error: err.message,
      contexto: `Productos: ${nombresProductos}`,
    });
    throw err; // re-lanzar para que cola.js también lo registre
  } finally {
    await browser.close();
  }
}

module.exports = {
  ejecutarVenta,
};
