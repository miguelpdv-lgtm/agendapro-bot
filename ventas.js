require("dotenv").config();
const puppeteer = require("puppeteer");

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitAndClick(frame, selector, timeout = 15000) {
  const el = await frame.waitForSelector(selector, { visible: true, timeout });
  if (!el) throw new Error(`No apareció el elemento: ${selector}`);
  await el.evaluate((node) => node.scrollIntoView({ block: "center", inline: "center" }));
  await delay(200);
  await el.click();
  return el;
}

async function waitAndType(frame, selector, text, timeout = 15000) {
  const el = await frame.waitForSelector(selector, { visible: true, timeout });
  if (!el) throw new Error(`No apareció el input: ${selector}`);
  await el.click({ clickCount: 3 });
  await el.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await el.type(text, { delay: 50 });
  return el;
}

async function waitByTextClick(frame, tagName, textPart, timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const handles = await frame.$$(tagName);

    for (const handle of handles) {
      try {
        const text = await frame.evaluate((el) => (el.innerText || "").trim().toLowerCase(), handle);
        const box = await handle.boundingBox();

        if (text.includes(textPart.toLowerCase()) && box && box.width > 0 && box.height > 0) {
          await handle.evaluate((node) => node.scrollIntoView({ block: "center", inline: "center" }));
          await delay(200);
          await handle.click();
          return handle;
        }
      } catch (_) {}
    }

    await delay(250);
  }

  throw new Error(`No se pudo clicar el elemento con texto: ${textPart}`);
}

async function esperarVisible(frame, selector, timeout = 15000) {
  return await frame.waitForSelector(selector, { visible: true, timeout });
}

async function ejecutarVenta(productos) {
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

    await page.waitForSelector('input[placeholder="user@example.com"]', { visible: true });
    await page.type('input[placeholder="user@example.com"]', process.env.AGENDAPRO_EMAIL);
    await page.type('input[placeholder="Enter your password"]', process.env.AGENDAPRO_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click("button"),
    ]);

    console.log("✅ Login OK");

    // ── IR A VENTAS ──────────────────────────────────────────────────────────
    await page.goto("https://app.agendapro.com/payments", {
      waitUntil: "networkidle2",
    });

    // ── NUEVA VENTA ──────────────────────────────────────────────────────────
    console.log("🆕 Nueva venta...");
    await waitByTextClick(page, "button", "+ Nueva venta", 15000);

    // ── IFRAME ───────────────────────────────────────────────────────────────
    await page.waitForSelector('iframe[title="APIframe"]', { visible: true, timeout: 15000 });
    const iframeHandle = await page.$('iframe[title="APIframe"]');
    if (!iframeHandle) throw new Error("No se encontró el iframe APIframe");

    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error("No se pudo obtener el contentFrame del iframe");

    console.log("✅ Iframe listo");

    // ── ABRIR CARRO ──────────────────────────────────────────────────────────
    await waitByTextClick(frame, "button", "agregar al carro", 15000);

    // ── LOOP PRODUCTOS ───────────────────────────────────────────────────────
    for (const prod of productos) {
      console.log(`🛍️ Procesando: ${prod.nombre} x${prod.cantidad}`);

      // Buscar producto
      const input = await esperarVisible(frame, 'input[type="text"]', 15000);
      await input.click({ clickCount: 3 });
      await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await input.type(prod.nombre, { delay: 60 });

      const showCounterSelector = `[data-testid="${prod.nombre}-show-counter"]`;
      await esperarVisible(frame, showCounterSelector, 15000);
      await waitAndClick(frame, showCounterSelector, 15000);

      // Asociar profesional
      const sellerSelector = '[data-testid="associate-item-seller-select"]';
      await esperarVisible(frame, sellerSelector, 15000);
      await waitAndClick(frame, sellerSelector, 15000);

      await frame.waitForFunction(() =>
        Array.from(document.querySelectorAll('[role="option"]')).some((el) =>
          (el.innerText || "").toLowerCase().includes("ema")
        ),
        { timeout: 10000 }
      );

      const options = await frame.$$('[role="option"]');
      let found = false;

      for (const opt of options) {
        try {
          const txt = await frame.evaluate((el) => (el.innerText || "").toLowerCase(), opt);
          const box = await opt.boundingBox();

          if (txt.includes("ema") && box && box.width > 0 && box.height > 0) {
            await opt.evaluate((node) => node.scrollIntoView({ block: "center", inline: "center" }));
            await delay(200);
            await opt.click();
            found = true;
            break;
          }
        } catch (_) {}
      }

      if (!found) throw new Error("No se encontró la opción de profesional EMA");

      await delay(500);

      // Ajustar cantidad
      if (prod.cantidad > 1) {
        console.log("🔢 Ajustando cantidad...");

        for (let i = 1; i < prod.cantidad; i++) {
          await waitAndClick(frame, showCounterSelector, 15000);

          const addSelector = `[data-testid="${prod.nombre}-add"]`;
          await esperarVisible(frame, addSelector, 10000);
          await waitAndClick(frame, addSelector, 10000);

          const esperado = i + 1;
          await frame.waitForFunction(
            (nombre, val) => {
              const btn = document.querySelector(`[data-testid="${nombre}-show-counter"]`);
              return btn?.innerText?.trim() === String(val);
            },
            { timeout: 5000 },
            prod.nombre,
            esperado
          );
        }
      }

      console.log(`✅ ${prod.nombre} agregado`);
    }

    // ── IR AL CARRO ─────────────────────────────────────────────────────────
    await waitByTextClick(frame, "button", "ir al carro", 15000);

    // ── CONTINUAR ──────────────────────────────────────────────────────────
    await delay(2000);
    console.log("➡️ Click en Continuar...");
    await waitByTextClick(frame, "button", "continuar", 15000);
    console.log("✅ Continuar clickeado");

    // ── MÉTODO DE PAGO ──────────────────────────────────────────────────────
    await delay(2000);
    console.log("➡️ Esperando panel de método de pago...");

    const paymentPanelSelector = '[data-testid="select-payment-method"]';
    await esperarVisible(frame, paymentPanelSelector, 15000);

    const transferSelector = '[data-testid="select-payment-method-Transferencia Bancaria"]';
    await esperarVisible(frame, transferSelector, 15000);

    const transferBtn = await frame.$(transferSelector);
    if (!transferBtn) throw new Error("No se encontró el botón de Transferencia Bancaria");

    await transferBtn.evaluate((node) => node.scrollIntoView({ block: "center", inline: "center" }));
    await delay(300);
    await transferBtn.click();

    console.log("✅ Transferencia Bancaria seleccionada");
    await delay(3000);
  } catch (err) {
    console.error("❌ Venta fallida:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { ejecutarVenta };
