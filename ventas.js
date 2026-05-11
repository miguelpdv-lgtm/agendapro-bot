// ─────────────────────────────────────────────────────────────────────────────
// ventas.js — AgendaPro Puppeteer
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

const delay = (ms) =>
  new Promise((res) => setTimeout(res, ms));

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

  const browser = await puppeteer.launch({
    headless: true,
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
  page.setDefaultTimeout(30000);

  try {
    // ───────────────────────────────────────────────────────────────────────
    // LOGIN
    // ───────────────────────────────────────────────────────────────────────
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

    // ───────────────────────────────────────────────────────────────────────
    // PAGOS
    // ───────────────────────────────────────────────────────────────────────
    await page.goto("https://app.agendapro.com/payments", {
      waitUntil: "networkidle2",
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
    await page.waitForSelector('input[placeholder="Código"]');

    await page.type('input[placeholder="Código"]', "0305", { delay: 80 });

    await page.keyboard.press("Enter");

    console.log("✅ Código ingresado");

    await delay(1200);

    // ───────────────────────────────────────────────────────────────────────
    // IFRAME
    // ───────────────────────────────────────────────────────────────────────
    await page.waitForSelector('iframe[title="APIframe"]');

    const frame = await (
      await page.$('iframe[title="APIframe"]')
    ).contentFrame();

    console.log("✅ Iframe listo");

    // ───────────────────────────────────────────────────────────────────────
    // AGREGAR AL CARRO
    // ───────────────────────────────────────────────────────────────────────
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

      console.log(`🔍 Buscando ${prod.nombre}`);

      await frame.waitForFunction(
        (nombre) =>
          !!document.querySelector(`[data-testid="${nombre}-show-counter"]`),
        { timeout: 10000 },
        prod.nombre
      );

      await frame.evaluate((nombre) => {
        document
          .querySelector(`[data-testid="${nombre}-show-counter"]`)
          ?.click();
      }, prod.nombre);

      // ─────────────────────────────────────────────────────────────────────
      // VENDEDOR
      // ─────────────────────────────────────────────────────────────────────
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
          await frame.evaluate((nombre) => {
            document
              .querySelector(`[data-testid="${nombre}-show-counter"]`)
              ?.click();
          }, prod.nombre);

          await frame.waitForSelector(`[data-testid="${prod.nombre}-add"]`);

          await frame.evaluate((nombre) => {
            document
              .querySelector(`[data-testid="${nombre}-add"]`)
              ?.click();
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

      for (const prod of productosConDescuento) {
        console.log(`🔍 Buscando card carrito: ${prod.nombre}`);

        // ───────────────────────────────────────────────────────────────────
        // ABRIR PRODUCTO DEL CARRITO (click real via ElementHandle)
        // ───────────────────────────────────────────────────────────────────
        const cardHandle = await frame.evaluateHandle((nombre) => {
          return [...document.querySelectorAll('[data-testid^="product-"]')]
            .find((el) =>
              el.getAttribute("data-testid")?.includes(`product-${nombre}-`)
            );
        }, prod.nombre);

        const cardExiste = await cardHandle.evaluate((el) => !!el);

        if (!cardExiste) {
          throw new Error(
            `❌ No se encontró card de "${prod.nombre}" en el carrito`
          );
        }

        // Scroll y click real CDP — no dispatchEvent
        await cardHandle.evaluate((el) =>
          el.scrollIntoView({ block: "center" })
        );
        await delay(500);
        await cardHandle.click();

        console.log("✅ Card clickeada");


await delay(2000); // dar tiempo al drawer

// DEBUG: buscar el input en AMBOS contextos
const enFrame = await frame.evaluate(() =>
  !!document.querySelector('input[data-testid$="unitDiscount"]')
);
const enPage = await page.evaluate(() =>
  !!document.querySelector('input[data-testid$="unitDiscount"]')
);
const todosInputsFrame = await frame.evaluate(() =>
  [...document.querySelectorAll("input")].map((i) => ({
    testid: i.dataset.testid,
    name: i.name,
    type: i.type,
    value: i.value,
  }))
);
const todosInputsPage = await page.evaluate(() =>
  [...document.querySelectorAll("input")].map((i) => ({
    testid: i.dataset.testid,
    name: i.name,
    type: i.type,
    value: i.value,
  }))
);

console.log("🔍 Input en frame:", enFrame);
console.log("🔍 Input en page:", enPage);
console.log("🔍 Inputs frame:", JSON.stringify(todosInputsFrame, null, 2));
console.log("🔍 Inputs page:", JSON.stringify(todosInputsPage, null, 2));
        // ───────────────────────────────────────────────────────────────────
        // ESPERAR INPUT DE DESCUENTO
        // ───────────────────────────────────────────────────────────────────
        console.log("⏳ Esperando input de descuento...");

        await frame.waitForFunction(
          () =>
            !!document.querySelector('input[data-testid$="unitDiscount"]'),
          { timeout: 15000 }
        );

        console.log("✅ Input descuento encontrado");

        // ───────────────────────────────────────────────────────────────────
        // SETEAR DESCUENTO (React-compatible native setter)
        // ───────────────────────────────────────────────────────────────────
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
        await page.keyboard.press("Enter");
        await delay(800);

        // ───────────────────────────────────────────────────────────────────
        // VALIDAR
        // ───────────────────────────────────────────────────────────────────
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

        // ───────────────────────────────────────────────────────────────────
        // CERRAR DRAWER
        // ───────────────────────────────────────────────────────────────────
        await page.keyboard.press("Escape");
        await delay(1000);
      }

      console.log("✅ Todos los descuentos aplicados");
    }

    // ───────────────────────────────────────────────────────────────────────
    // CONTINUAR
    // ───────────────────────────────────────────────────────────────────────
    console.log("➡️ Continuar...");

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

    await frame.waitForSelector('[data-testid="select-payment-method"]');

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
  } finally {
    await browser.close();
  }
}

module.exports = {
  ejecutarVenta,
};
