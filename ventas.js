// ─────────────────────────────────────────────────────────────────────────────
//  ventas.js — Lógica de ventas Puppeteer (headless para Railway)
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws,
    },
  }
);

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ── Consultar descuentos desde Supabase ──────────────────────────────────────
async function obtenerDescuentos(productos) {
  const nombres = productos.map((p) => p.nombre);

  const { data, error } = await supabase
    .from("products")
    .select("nombre, precio, discount_pct, discount_active")
    .in("nombre", nombres);

  if (error) {
    console.error("❌ Error consultando descuentos:", error.message);
    return productos;
  }

  return productos.map((prod) => {
    const found = data.find((d) => d.nombre === prod.nombre);
    const tieneDescuento = found?.discount_active && found?.discount_pct > 0;
    const precioFinal = tieneDescuento
      ? Math.round(found.precio * (1 - found.discount_pct / 100))
      : found?.precio ?? null;

    return {
      ...prod,
      precio_original: found?.precio ?? null,
      discount_pct: tieneDescuento ? found.discount_pct : 0,
      precio_final: precioFinal,
      tiene_descuento: tieneDescuento,
    };
  });
}

async function ejecutarVenta(productos) {
  // ── Enriquecer con descuentos antes de abrir el browser ───────────────────
  productos = await obtenerDescuentos(productos);

  for (const p of productos) {
    if (p.tiene_descuento) {
      console.log(
        `🏷️ ${p.nombre}: ${p.discount_pct}% OFF → $${p.precio_final} (antes $${p.precio_original})`
      );
    }
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    // ── LOGIN ────────────────────────────────────────────────────────────────
    console.log("🔐 Login...");
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
    console.log("✅ Login OK");

    // ── IR A VENTAS ──────────────────────────────────────────────────────────
    await page.goto("https://app.agendapro.com/payments", {
      waitUntil: "networkidle2",
    });

    // ── NUEVA VENTA ──────────────────────────────────────────────────────────
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

    // ── CÓDIGO DE CAJERO ─────────────────────────────────────────────────────
    console.log("🔑 Esperando modal de código de cajero...");
    await page.waitForSelector('input[placeholder="Código"]', { timeout: 10000 });
    await page.type('input[placeholder="Código"]', "0305", { delay: 80 });
    await page.keyboard.press("Enter");
    console.log("✅ Código de cajero ingresado");

    await page
      .waitForFunction(
        () => !document.querySelector('input[placeholder="Código"]'),
        { timeout: 8000 }
      )
      .catch(() => {});
    await delay(800);

    // ── IFRAME ───────────────────────────────────────────────────────────────
    await page.waitForSelector('iframe[title="APIframe"]');
    const frame = await (
      await page.$('iframe[title="APIframe"]')
    ).contentFrame();
    console.log("✅ Iframe listo");

    // ── ABRIR CARRO ──────────────────────────────────────────────────────────
    await frame.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.innerText?.toLowerCase().includes("agregar al carro")
      )
    );
    await frame.evaluate(() => {
      Array.from(document.querySelectorAll("button"))
        .find((b) => b.innerText?.toLowerCase().includes("agregar al carro"))
        ?.click();
    });

    await delay(1500);

    // ── LOOP PRODUCTOS ───────────────────────────────────────────────────────
    for (const prod of productos) {
      console.log(
        `🛍️ Procesando: ${prod.nombre} x${prod.cantidad}` +
          (prod.tiene_descuento ? ` | ${prod.discount_pct}% OFF` : "")
      );

      await frame.waitForSelector('input[type="text"]', { timeout: 10000 });
      await delay(400);

      await frame.evaluate(() => {
        const input = document.querySelector('input[type="text"]');
        if (!input) return;
        input.focus();
        input.select();
        input.dispatchEvent(new Event("select", { bubbles: true }));
      });

      await delay(200);

      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await delay(100);

      await frame.type('input[type="text"]', prod.nombre, { delay: 60 });

      console.log(`🔍 Buscando: ${prod.nombre}`);

      await frame.waitForFunction(
        (nombre) =>
          !!document.querySelector(`[data-testid="${nombre}-show-counter"]`),
        { timeout: 8000 },
        prod.nombre
      );

      await frame.evaluate((nombre) => {
        document
          .querySelector(`[data-testid="${nombre}-show-counter"]`)
          ?.click();
      }, prod.nombre);

      // ── PROFESIONAL ────────────────────────────────────────────────────────
      await frame.waitForSelector(
        '[data-testid="associate-item-seller-select"]',
        { timeout: 8000 }
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

      await frame
        .waitForFunction(
          () => document.querySelectorAll('[role="option"]').length === 0,
          { timeout: 3000 }
        )
        .catch(() => {});
      await delay(300);

      // ── CANTIDAD ───────────────────────────────────────────────────────────
      if (prod.cantidad > 1) {
        console.log("🔢 Ajustando cantidad...");
        for (let i = 1; i < prod.cantidad; i++) {
          await frame.evaluate((nombre) => {
            document
              .querySelector(`[data-testid="${nombre}-show-counter"]`)
              ?.click();
          }, prod.nombre);

          await frame.waitForSelector(`[data-testid="${prod.nombre}-add"]`, {
            timeout: 5000,
          });

          await frame.evaluate((nombre) => {
            document.querySelector(`[data-testid="${nombre}-add"]`)?.click();
          }, prod.nombre);

          const esperado = i + 1;
          await frame.waitForFunction(
            (nombre, val) => {
              const btn = document.querySelector(
                `[data-testid="${nombre}-show-counter"]`
              );
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

    // ── IR AL CARRO ──────────────────────────────────────────────────────────
    await frame.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.innerText?.toLowerCase().includes("ir al carro")
      )
    );
    await frame.evaluate(() => {
      Array.from(document.querySelectorAll("button"))
        .find((b) => b.innerText?.toLowerCase().includes("ir al carro"))
        ?.click();
    });

    await delay(2000);

    // ── APLICAR DESCUENTOS EN EL CARRO ──────────────────────────────────────
    const productosConDescuento = productos.filter(
      (p) => p.tiene_descuento && p.discount_pct > 0
    );

    if (productosConDescuento.length > 0) {
      console.log("🏷️ Aplicando descuentos en el carro...");

      for (const prod of productosConDescuento) {
        console.log(`💸 Abriendo panel de: ${prod.nombre}`);

        // data-cy="{nombre}" — selector exacto del DevTools
        const existe = await frame.evaluate((nombre) => {
          const btn = document.querySelector(`[data-cy="${nombre}"]`);
          if (btn) { btn.click(); return true; }
          return false;
        }, prod.nombre);

        if (!existe) {
          throw new Error(
            `❌ No se encontró "${prod.nombre}" en el carro. Abortando venta.`
          );
        }

        console.log(`🖱️ Click en producto del carro OK`);

        // Esperar que abra el drawer: data-testid="edit-item"
        await frame.waitForSelector('[data-testid="edit-item"]', { timeout: 8000 });
        console.log(`✏️ Panel edit-item abierto para: ${prod.nombre}`);

        // Esperar input de descuento dentro del drawer
        await frame.waitForFunction(
          () => {
            const drawer = document.querySelector('[data-testid="edit-item"]');
            if (!drawer) return false;
            const inputs = [...drawer.querySelectorAll("input")];
            return inputs.some(
              (inp) =>
                inp.value === "0.0" ||
                inp.value === "0" ||
                inp.closest("div")?.innerText?.toLowerCase().includes("descuento")
            );
          },
          { timeout: 8000 }
        );

        console.log(`✏️ Input de descuento encontrado para: ${prod.nombre}`);

        // Limpiar y escribir con setter nativo React
        await frame.evaluate((pct) => {
          const drawer = document.querySelector('[data-testid="edit-item"]');
          const inputs = [...(drawer
            ? drawer.querySelectorAll("input")
            : document.querySelectorAll("input"))];

          const discountInput =
            inputs.find((inp) => {
              const ctx = inp.closest("div")?.innerText?.toLowerCase() ?? "";
              return ctx.includes("descuento");
            }) ??
            inputs.find((inp) => inp.value === "0.0" || inp.value === "0");

          if (!discountInput) return;

          discountInput.dispatchEvent(
            new MouseEvent("click", { bubbles: true, detail: 3 })
          );
          discountInput.select();

          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          ).set;
          setter.call(discountInput, String(pct));

          discountInput.dispatchEvent(new Event("input",  { bubbles: true }));
          discountInput.dispatchEvent(new Event("change", { bubbles: true }));
        }, prod.discount_pct);

        await delay(300);
        await frame.keyboard.press("Enter");
        await delay(800);

        // Verificar que el valor cambió
        const valorFinal = await frame.evaluate(() => {
          const drawer = document.querySelector('[data-testid="edit-item"]');
          const inputs = [...(drawer
            ? drawer.querySelectorAll("input")
            : document.querySelectorAll("input"))];
          const discountInput =
            inputs.find((inp) => {
              const ctx = inp.closest("div")?.innerText?.toLowerCase() ?? "";
              return ctx.includes("descuento");
            }) ??
            inputs.find((inp) => inp.type === "number");
          return discountInput ? discountInput.value : null;
        });

        console.log(`🔍 Valor descuento después de Enter: ${valorFinal}`);

        if (valorFinal === "0" || valorFinal === "0.0" || valorFinal === null) {
          throw new Error(
            `❌ Descuento no aplicado en "${prod.nombre}". Valor: ${valorFinal}. Abortando.`
          );
        }

        console.log(`✅ Descuento ${prod.discount_pct}% confirmado: ${prod.nombre}`);

        // Cerrar drawer
        await frame.evaluate(() => {
          const drawer = document.querySelector('[data-testid="edit-item"]');
          if (!drawer) return;
          const closeBtn = drawer.querySelector('button[class*="am-rounded-xs"]');
          if (closeBtn) { closeBtn.click(); return; }
          const svgBtn = [...drawer.querySelectorAll("button")].find(
            (b) => b.querySelector("svg") && b.innerText?.trim() === ""
          );
          svgBtn?.click();
        });

        await delay(800);
      }

      console.log("✅ Todos los descuentos aplicados");
    }

    // ── CONTINUAR ────────────────────────────────────────────────────────────
    await delay(1500);
    console.log("➡️ Click en Continuar...");

    await frame.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.innerText?.toLowerCase().includes("continuar")
      )
    );
    await frame.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText?.toLowerCase().includes("continuar")
      );
      if (btn) {
        btn.scrollIntoView({ block: "center" });
        btn.click();
      }
    });

    console.log("✅ Continuar clickeado");

    // ── MÉTODO DE PAGO ────────────────────────────────────────────────────────
    await delay(3000);
    console.log("➡️ Esperando panel de método de pago...");

    await frame.waitForSelector('[data-testid="select-payment-method"]', {
      timeout: 10000,
    });

    await frame.waitForFunction(
      () => {
        const btn = document.querySelector(
          '[data-testid="select-payment-method-Transferencia Bancaria"]'
        );
        return btn && !btn.disabled;
      },
      { timeout: 10000 }
    );

    await frame.evaluate(() => {
      document
        .querySelector(
          '[data-testid="select-payment-method-Transferencia Bancaria"]'
        )
        ?.click();
    });

    console.log("✅ Transferencia Bancaria seleccionada");
    await delay(3000);
  } finally {
    await browser.close();
  }
}

module.exports = { ejecutarVenta };
