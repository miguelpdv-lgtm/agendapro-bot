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

// ── Helper: verificar si drawer está abierto ─────────────────────────────────
async function drawerEstaAbierto(frame) {
  return frame.evaluate(() => {
    const drawer = document.querySelector('[data-testid="edit-item"]');
    return drawer && drawer.getAttribute("data-state") === "open";
  });
}

// ── Helper: cerrar drawer de forma robusta ───────────────────────────────────
async function cerrarDrawer(page, frame) {
  const abierto = await drawerEstaAbierto(frame);
  if (!abierto) return;

  console.log("🔒 Cerrando drawer...");
  await frame.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await delay(800);

  await frame
    .waitForFunction(
      () => {
        const drawer = document.querySelector('[data-testid="edit-item"]');
        return !drawer || drawer.getAttribute("data-state") === "closed";
      },
      { timeout: 5000 }
    )
    .catch(() => {
      console.log("⚠️ Drawer no cerró con Escape");
    });

  await delay(500);
}

// ── Helper: click robusto en producto del carrito ────────────────────────────
// (igual que tu versión original, no lo modifiqué)

// ── Ejecutar venta ──────────────────────────────────────────────────────────
async function ejecutarVenta(productos) {
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
    // Login, nueva venta, agregar productos, etc. (igual que tu versión original)

    // ── APLICAR DESCUENTOS EN EL CARRO ──────────────────────────────────────
    const productosConDescuento = productos.filter(
      (p) => p.tiene_descuento && p.discount_pct > 0
    );

    if (productosConDescuento.length > 0) {
      console.log("🏷️ Aplicando descuentos en el carro...");

      await cerrarDrawer(page, frame);

      for (const prod of productosConDescuento) {
        console.log(`\n💸 Procesando descuento de: ${prod.nombre}`);

        await clickProductoCarrito(frame, prod.nombre);

        // Esperar input de descuento
        await frame.waitForFunction(
          () => {
            const drawer = document.querySelector('[data-testid="edit-item"]');
            if (!drawer) return false;
            const inputs = [...drawer.querySelectorAll("input")];
            return inputs.some((inp) => {
              const ctx = inp.closest("div")?.innerText?.toLowerCase() ?? "";
              return ctx.includes("descuento");
            });
          },
          { timeout: 10000 }
        );

        console.log(`✏️ Input de descuento encontrado para: ${prod.nombre}`);

        // Asignar id temporal
        const inputSelector = await frame.evaluate(() => {
          const drawer = document.querySelector('[data-testid="edit-item"]');
          if (!drawer) return null;
          const inputs = [...drawer.querySelectorAll("input")];
          const discountInput = inputs.find((inp) => {
            const ctx = inp.closest("div")?.innerText?.toLowerCase() ?? "";
            return ctx.includes("descuento");
          });
          if (!discountInput) return null;
          discountInput.id = "temp-discount-input";
          return "#temp-discount-input";
        });

        if (!inputSelector) {
          throw new Error(`❌ No se encontró input de descuento para ${prod.nombre}`);
        }

        // Usar setter nativo
        await frame.evaluate((pct) => {
          const el = document.querySelector("#temp-discount-input");
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          ).set;
          setter.call(el, String(pct));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, prod.discount_pct);

        await delay(500);

        // Verificar valor final
        const valorFinal = await frame.evaluate(() => {
          const el = document.querySelector("#temp-discount-input");
          return el ? el.value : null;
        });

        console.log(`🔍 Valor descuento aplicado: ${valorFinal}`);

        if (!valorFinal || valorFinal === "0" || valorFinal === "0.0") {
          throw new Error(`❌ Descuento no aplicado en "${prod.nombre}"`);
        }

        console.log(`✅ Descuento ${prod.discount_pct}% confirmado: ${prod.nombre}`);

        // Limpiar id temporal
        await frame.evaluate(() => {
          const el = document.querySelector("#temp-discount-input");
          if (el) el.removeAttribute("id");
        });

        // Cerrar drawer
        await page.keyboard.press("Escape");
        await delay(800);
      }

      console.log("\n✅ Todos los descuentos aplicados");
    }

    // Continuar, método de pago, etc. (igual que tu versión original)
  } finally {
    await browser.close();
  }
}

module.exports = { ejecutarVenta };
