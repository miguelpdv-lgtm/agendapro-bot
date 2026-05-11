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
async function clickProductoCarrito(frame, nombreProducto) {
  console.log(`🔍 Buscando "${nombreProducto}" en el carrito...`);

  await frame.waitForSelector('[data-testid="cart-items"]', { timeout: 10000 });
  await delay(500);

  const elInfo = await frame.evaluate((nombre) => {
    const cartItems = document.querySelector('[data-testid="cart-items"]');
    if (!cartItems) return { error: "No hay cart-items" };

    let el = document.querySelector(`[data-cy="${nombre}"]`);
    let metodo = "data-cy";

    if (!el) {
      const todos = [...cartItems.querySelectorAll("[data-testid]")];
      el = todos.find((x) =>
        x.getAttribute("data-testid").toLowerCase().includes(nombre.toLowerCase())
      );
      metodo = "data-testid";
    }

    if (!el) {
      const todos = [...cartItems.querySelectorAll("*")];
      el = todos.find((x) => x.innerText?.trim() === nombre);
      metodo = "texto";
    }

    if (!el) {
      const ids = [...cartItems.querySelectorAll("[data-testid]")].map((x) =>
        x.getAttribute("data-testid")
      );
      return { error: "No encontrado", disponibles: ids };
    }

    return {
      metodo,
      tag: el.tagName,
      class: el.className,
      dataTestid: el.getAttribute("data-testid"),
      dataCy: el.getAttribute("data-cy"),
      rect: el.getBoundingClientRect
        ? {
            top: el.getBoundingClientRect().top,
            left: el.getBoundingClientRect().left,
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
          }
        : null,
      parentTag: el.parentElement?.tagName,
      parentClass: el.parentElement?.className,
      html: el.outerHTML.substring(0, 300),
    };
  }, nombreProducto);

  if (elInfo.error) {
    console.log("📋 Productos disponibles en carrito:", elInfo.disponibles);
    throw new Error(`❌ ${nombreProducto} no encontrado en carrito: ${elInfo.error}`);
  }

  console.log("📦 Elemento encontrado:", JSON.stringify(elInfo, null, 2));

  let selector;
  if (elInfo.dataCy) {
    selector = `[data-cy="${nombreProducto}"]`;
  } else if (elInfo.dataTestid) {
    selector = `[data-testid="${elInfo.dataTestid}"]`;
  } else {
    selector = `text=${nombreProducto}`;
  }

  await frame.waitForSelector(selector, { timeout: 5000 });
  const el = await frame.$(selector);
  if (!el) throw new Error("❌ ElementHandle es null");

  await el.evaluate((node) =>
    node.scrollIntoView({ block: "center", behavior: "instant" })
  );
  await delay(600);

  // Estrategia 1: hover + click nativo
  console.log(`🖱️ Estrategia 1: hover + click nativo en ${selector}`);
  try {
    await el.hover();
    await delay(300);
    await el.click({ delay: 80 });
  } catch (e) {
    console.log(`⚠️ Estrategia 1 error: ${e.message}`);
  }
  await delay(1200);

  if (await drawerEstaAbierto(frame)) {
    console.log("✅ Drawer abierto con Estrategia 1");
    return;
  }

  // Estrategia 2: click en el PADRE
  console.log(`🖱️ Estrategia 2: click en el elemento padre`);
  try {
    const parentClicked = await el.evaluate((node) => {
      if (node.parentElement) {
        node.parentElement.scrollIntoView({ block: "center", behavior: "instant" });
        node.parentElement.click();
        return true;
      }
      return false;
    });
    if (!parentClicked) console.log("⚠️ No hay padre para clickear");
  } catch (e) {
    console.log(`⚠️ Estrategia 2 error: ${e.message}`);
  }
  await delay(1200);

  if (await drawerEstaAbierto(frame)) {
    console.log("✅ Drawer abierto con Estrategia 2");
    return;
  }

  // Estrategia 3: click en primer elemento interactivo interno
  console.log(`🖱️ Estrategia 3: click en primer elemento interactivo interno`);
  try {
    await frame.evaluate((nombre) => {
      const el = document.querySelector(`[data-cy="${nombre}"]`);
      if (!el) return;
      const clickable =
        el.querySelector('button, [role="button"], a, svg, [class*="cursor-pointer"]') ||
        el;
      clickable.scrollIntoView({ block: "center", behavior: "instant" });
      clickable.click();
    }, nombreProducto);
  } catch (e) {
    console.log(`⚠️ Estrategia 3 error: ${e.message}`);
  }
  await delay(1200);

  if (await drawerEstaAbierto(frame)) {
    console.log("✅ Drawer abierto con Estrategia 3");
    return;
  }

  // Estrategia 4: secuencia completa pointer + mouse JS
  console.log(`🖱️ Estrategia 4: eventos JS pointer + mouse con coordenadas`);
  try {
    await frame.evaluate((nombre) => {
      const el = document.querySelector(`[data-cy="${nombre}"]`);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const opts = (type) => ({
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        screenX: cx,
        screenY: cy,
        pointerType: "mouse",
        button: 0,
        isPrimary: true,
      });

      el.dispatchEvent(new PointerEvent("pointerover", opts()));
      el.dispatchEvent(new MouseEvent("mouseover", opts()));
      el.dispatchEvent(new PointerEvent("pointerenter", opts()));
      el.dispatchEvent(new MouseEvent("mouseenter", opts()));
      el.dispatchEvent(new PointerEvent("pointerdown", opts()));
      el.dispatchEvent(new MouseEvent("mousedown", opts()));
      el.dispatchEvent(new PointerEvent("pointerup", opts()));
      el.dispatchEvent(new MouseEvent("mouseup", opts()));
      el.dispatchEvent(new MouseEvent("click", opts()));
    }, nombreProducto);
  } catch (e) {
    console.log(`⚠️ Estrategia 4 error: ${e.message}`);
  }
  await delay(1500);

  if (await drawerEstaAbierto(frame)) {
    console.log("✅ Drawer abierto con Estrategia 4");
    return;
  }

  throw new Error(
    `❌ No se pudo abrir el drawer de "${nombreProducto}" después de 4 estrategias.`
  );
}

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

    console.log("🛒 Carrito abierto");
    await delay(3500);

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

        // ── Esperar input de descuento dentro del drawer ─────────────────────
        await frame.waitForFunction(
          () => {
            const drawer = document.querySelector('[data-testid="edit-item"]');
            if (!drawer) return false;
            const inputs = [...drawer.querySelectorAll("input")];
            return inputs.some(
              (inp) =>
                inp.value === "0.0" ||
                inp.value === "0" ||
                inp
                  .closest("div")
                  ?.innerText?.toLowerCase()
                  .includes("descuento")
            );
          },
          { timeout: 10000 }
        );

        console.log(`✏️ Input de descuento encontrado para: ${prod.nombre}`);

        // ═══════════════════════════════════════════════════════════════════
        // ESCRITURA DE DESCUENTO — versión corregida para input type="number"
        // ═════════════════════════════════════════════════════════════════==

        // 1) Asignar id temporal al input de descuento para poder seleccionarlo
        const inputSelector = await frame.evaluate(() => {
          const drawer = document.querySelector('[data-testid="edit-item"]');
          const inputs = [...drawer.querySelectorAll("input")];
          const discountInput =
            inputs.find((inp) => {
              const ctx = inp.closest("div")?.innerText?.toLowerCase() ?? "";
              return ctx.includes("descuento");
            }) ??
            inputs.find((inp) => inp.value === "0.0" || inp.value === "0");

          if (!discountInput) return null;

          discountInput.id = "temp-discount-input";
          return "#temp-discount-input";
        });

        if (!inputSelector) {
          throw new Error(`❌ No se encontró input de descuento para ${prod.nombre}`);
        }

        // 2) Click para focus, seleccionar todo y borrar
        await frame.click(inputSelector);
        await delay(200);

        await page.keyboard.down("Control");
        await page.keyboard.press("KeyA");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");
        await delay(200);

        // 3) Escribir el valor
        await frame.type(inputSelector, String(prod.discount_pct), { delay: 80 });
        await delay(500);

        // 4) Verificar que se escribió correctamente ANTES de Enter
        const valorAntesEnter = await frame.evaluate(() => {
          const el = document.querySelector("#temp-discount-input");
          return el ? el.value : null;
        });

        console.log(`🔍 Valor descuento ANTES de Enter: ${valorAntesEnter}`);

        if (valorAntesEnter !== String(prod.discount_pct)) {
          console.log(`⚠️ frame.type no funcionó, usando setter nativo...`);
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
        }

        // 5) Enviar Enter DIRECTAMENTE al input vía JS
        await frame.evaluate(() => {
          const el = document.querySelector("#temp-discount-input");
          if (!el) return;
          el.focus();
          ["keydown", "keypress", "keyup"].forEach((type) => {
            el.dispatchEvent(
              new KeyboardEvent(type, {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
              })
            );
          });
          el.blur();
        });
        await delay(1000);

        // 6) Limpiar id temporal
        await frame.evaluate(() => {
          const el = document.querySelector("#temp-discount-input");
          if (el) el.removeAttribute("id");
        });

        // 7) Verificar valor final
        const valorFinal = await frame.evaluate(() => {
          const drawer = document.querySelector('[data-testid="edit-item"]');
          const inputs = [
            ...(drawer
              ? drawer.querySelectorAll("input")
              : document.querySelectorAll("input")),
          ];
          const discountInput =
            inputs.find((inp) => {
              const ctx =
                inp.closest("div")?.innerText?.toLowerCase() ?? "";
              return ctx.includes("descuento");
            }) ?? inputs.find((inp) => inp.type === "number");
          return discountInput ? discountInput.value : null;
        });

        console.log(`🔍 Valor descuento DESPUÉS de Enter: ${valorFinal}`);

        if (
          valorFinal === "0" ||
          valorFinal === "0.0" ||
          valorFinal === null
        ) {
          throw new Error(
            `❌ Descuento no aplicado en "${prod.nombre}". Valor: ${valorFinal}. Abortando.`
          );
        }

        console.log(
          `✅ Descuento ${prod.discount_pct}% confirmado: ${prod.nombre}`
        );

        // ── Cerrar drawer con Escape ────────────────────────────────────────
        await page.keyboard.press("Escape");
        await delay(1000);
      }

      console.log("\n✅ Todos los descuentos aplicados");
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
