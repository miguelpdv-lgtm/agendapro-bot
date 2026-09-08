// ─────────────────────────────────────────────────────────────────────────────
// ventas.js — AgendaPro Playwright
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { notificarError } = require("./notificar");
const { lanzarNavegador, escribir, bloqueoNavegador } = require("./navegador");

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
// BÚSQUEDA TOLERANTE DE PRODUCTOS
//
// AgendaPro pinta cada producto del carro con data-testid="<nombre>-show-counter"
// (y "<nombre>-add", "edit-product-<nombre>"), donde <nombre> es el nombre crudo
// del catálogo. Ese nombre puede traer espacios dobles, espacios sobrantes al
// final o tildes: hoy en el catálogo hay un caso real, "Crema  Rizadas Juba"
// (con dos espacios después de "Crema").
//
// Eso rompía la venta por dos lados:
//
//   1. El buscador del carro no devuelve el producto cuando se le escribe el
//      nombre completo tal cual. Buscando "Juba" sí aparecen varias opciones,
//      pero con el nombre exacto no aparece ninguna.
//   2. La comparación contra el data-testid era por igualdad exacta, así que
//      cualquier diferencia de espacios o tildes entre el nombre guardado y el
//      que muestra AgendaPro daba "producto no encontrado".
//
// La solución: buscar con términos cada vez más cortos (nombre completo con los
// espacios colapsados → dos primeras palabras → palabra más larga → última
// palabra) y comparar los nombres normalizados en vez de exigir igualdad exacta.
// Además el listado llega paginado de a 30, así que si el producto no está en la
// primera tanda se hace scroll para cargar las siguientes.
// ─────────────────────────────────────────────────────────────────────────────

// Términos a probar, del más específico al más general.
// El buscador de AgendaPro ignora los términos de menos de 3 caracteres.
function terminosDeBusqueda(nombre) {
  const limpio = String(nombre ?? "").replace(/\s+/g, " ").trim();
  const palabras = limpio.split(" ").filter((p) => p.length >= 3);
  const porLargo = [...palabras].sort((a, b) => b.length - a.length);

  return [
    ...new Set([
      limpio,                          // nombre completo, ya sin espacios dobles
      palabras.slice(0, 2).join(" "),  // dos primeras palabras
      porLargo[0],                     // palabra más larga (la más distintiva)
      palabras[palabras.length - 1],   // última palabra (suele ser la marca)
    ]),
  ].filter((t) => t && t.length >= 3);
}

// Corre DENTRO de la página: ubica el producto comparando nombres normalizados.
// `plantilla` dice cómo está armado el data-testid del elemento buscado.
function localizarProducto({ nombre, plantilla, accion }) {
  const normalizar = (txt) =>
    String(txt ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // tildes
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ") // signos y espacios raros
      .replace(/\s+/g, " ")
      .trim();

  const objetivo = normalizar(nombre);
  if (!objetivo) return null;

  const plantillas = {
    "show-counter": (testid) =>
      testid.endsWith("-show-counter")
        ? testid.slice(0, -"-show-counter".length)
        : null,
    add: (testid) =>
      testid.endsWith("-add") ? testid.slice(0, -"-add".length) : null,
    "edit-product": (testid) =>
      testid.startsWith("edit-product-")
        ? testid.slice("edit-product-".length)
        : null,
  };

  const extraer = plantillas[plantilla];
  if (!extraer) return null;

  const candidatos = [];
  for (const el of document.querySelectorAll("[data-testid]")) {
    const testid = el.dataset.testid;
    const crudo = extraer(testid);
    if (crudo === null) continue;
    candidatos.push({ el, testid, nombre: normalizar(crudo) });
  }

  // Sólo coincidencia exacta una vez normalizado. A propósito no se acepta
  // coincidencia parcial: "Mascarilla Nutritiva Phytomanga" es prefijo de
  // "Mascarilla Nutritiva Phytomanga 500ml", y registrar el producto equivocado
  // es peor que fallar.
  const elegido = candidatos.find((c) => c.nombre === objetivo);
  if (!elegido) return null;

  if (accion === "click") {
    elegido.el.scrollIntoView({ block: "center" });
    // El drawer de descuento sólo abre si la tarjeta tiene el foco.
    elegido.el.focus?.();
    elegido.el.click();
  }

  return elegido.testid;
}

// Nombres que el buscador dejó a la vista. Sirve para que, cuando falla, la
// alerta por correo diga contra qué se comparó en vez de sólo "no encontrado".
async function productosVisibles(frame) {
  try {
    return await frame.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid$="-show-counter"]'))
        .map((el) => el.dataset.testid.slice(0, -"-show-counter".length))
        .slice(0, 15)
    );
  } catch (_) {
    return [];
  }
}

// Devuelve el data-testid real del producto, o null si todavía no está en el DOM.
async function ubicarProducto(frame, nombre, plantilla) {
  try {
    return await frame.evaluate(localizarProducto, {
      nombre,
      plantilla,
      accion: "ver",
    });
  } catch (_) {
    // El frame puede haberse recreado entre reintentos.
    return null;
  }
}

// Igual que ubicarProducto, pero además hace click.
async function clickProducto(frame, nombre, plantilla) {
  return frame.evaluate(localizarProducto, {
    nombre,
    plantilla,
    accion: "click",
  });
}

// Espera a que el producto aparezca en el DOM. No lanza: devuelve null.
async function esperarProducto(frame, nombre, plantilla, timeout = 10000) {
  const limite = Date.now() + timeout;
  for (;;) {
    const testid = await ubicarProducto(frame, nombre, plantilla);
    if (testid) return testid;
    if (Date.now() >= limite) return null;
    await delay(400);
  }
}

// El listado de productos llega paginado de a 30 y carga la siguiente tanda al
// llegar al fondo. Devuelve true si logró desplazar algo.
async function cargarMasResultados(frame) {
  try {
    return await frame.evaluate(() => {
      const ancla = document.querySelector('[data-testid$="-show-counter"]');
      let nodo = ancla ? ancla.parentElement : null;

      while (nodo && nodo !== document.body) {
        const estilo = getComputedStyle(nodo);
        const desplazable =
          /(auto|scroll)/.test(estilo.overflowY) &&
          nodo.scrollHeight > nodo.clientHeight + 8;

        if (desplazable) {
          const antes = nodo.scrollTop;
          nodo.scrollTop = nodo.scrollHeight;
          return nodo.scrollTop > antes;
        }
        nodo = nodo.parentElement;
      }

      const antes = window.scrollY;
      window.scrollTo(0, document.body.scrollHeight);
      return window.scrollY > antes;
    });
  } catch (_) {
    return false;
  }
}

// Escribe un término en el buscador del carro, dejando el campo limpio antes.
async function escribirBusqueda(frame, page, termino) {
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

  await escribir(frame, 'input[type="text"]', termino, { delay: 60 });
}

// Busca el producto probando términos cada vez más cortos y paginando el
// listado. Devuelve el data-testid real; lanza si no aparece con ningún término.
async function buscarProductoEnCarro(frame, page, prod) {
  const terminos = prod.busqueda
    ? [prod.busqueda]
    : terminosDeBusqueda(prod.nombre);

  for (const termino of terminos) {
    await escribirBusqueda(frame, page, termino);
    console.log(`🔍 Buscando "${termino}" (producto: ${prod.nombre})`);

    for (let tanda = 0; tanda < 6; tanda++) {
      const testid = await esperarProducto(
        frame,
        prod.nombre,
        "show-counter",
        tanda === 0 ? 8000 : 4000
      );

      if (testid) {
        console.log(`✅ Encontrado en AgendaPro como "${testid}"`);
        return testid;
      }

      if (!(await cargarMasResultados(frame))) break;
      console.log("↕️  Cargando más resultados...");
      await delay(900);
    }

    console.warn(
      `⚠️  "${termino}" no devolvió el producto, probando un término más corto`
    );
  }

  const visibles = await productosVisibles(frame);

  throw new Error(
    `No se encontró "${prod.nombre}" en el buscador de AgendaPro. ` +
      `Términos probados: ${terminos.join(" | ")}. ` +
      (visibles.length
        ? `En pantalla había: ${visibles.join(", ")}`
        : "El buscador no devolvió ningún producto.")
  );
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

  const liberar = await bloqueoNavegador.adquirir();
  let browser;
  let productoActual = null;

  try {
    browser = await lanzarNavegador({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
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
      productoActual = prod;
      console.log(`🛍️ ${prod.nombre} x${prod.cantidad}`);

      // ── Siempre re-obtener el frame por si se recreó ──────────────────────
      frame = await getFrame(page);

      await buscarProductoEnCarro(frame, page, prod);

      await clickProducto(frame, prod.nombre, "show-counter");

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
          await clickProducto(frame, prod.nombre, "show-counter");

          const botonAgregar = await esperarProducto(
            frame,
            prod.nombre,
            "add",
            10000
          );

          if (!botonAgregar) {
            throw new Error(
              `No apareció el botón para sumar unidades de "${prod.nombre}"`
            );
          }

          await clickProducto(frame, prod.nombre, "add");

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

        const tarjeta = await esperarProducto(
          frame,
          prod.nombre,
          "edit-product",
          20000
        );

        if (!tarjeta) {
          throw new Error(
            `No se encontró la tarjeta de "${prod.nombre}" en el carrito`
          );
        }

        await delay(500);

        await clickProducto(frame, prod.nombre, "edit-product");

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
    const contextoFalla = productoActual
      ? `Falló en: ${productoActual.nombre} x${productoActual.cantidad}. `
      : "";
    await notificarError({
      asunto: "❌ Venta fallida — AgendaPro Bot",
      script: "ventas.js",
      error: err.message,
      contexto: `${contextoFalla}Productos: ${nombresProductos}`,
    });
    throw err; // re-lanzar para que cola.js también lo registre
  } finally {
    if (browser) await browser.close();
    liberar();
  }
}

module.exports = {
  ejecutarVenta,
};
