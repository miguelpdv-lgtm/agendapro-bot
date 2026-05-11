// ── APLICAR DESCUENTOS EN EL CARRO ──────────────────────────────────────────
const productosConDescuento = productos.filter(
  (p) => p.tiene_descuento && p.discount_pct > 0
);

if (productosConDescuento.length > 0) {
  console.log("🏷️ Aplicando descuentos en el carro...");

  for (const prod of productosConDescuento) {
    console.log(`💸 Abriendo panel de: ${prod.nombre}`);

    // Selector exacto visto en el DevTools: data-cy="{nombre}"
    const existe = await frame.evaluate((nombre) => {
      const btn = document.querySelector(`[data-cy="${nombre}"]`);
      if (btn) { btn.click(); return true; }
      return false;
    }, prod.nombre);

    if (!existe) {
      throw new Error(
        `❌ No se encontró el producto "${prod.nombre}" en el carro. Abortando venta.`
      );
    }

    console.log(`🖱️ Click en producto del carro OK`);

    // Esperar que abra el drawer de edición: data-testid="edit-item"
    await frame.waitForSelector('[data-testid="edit-item"]', { timeout: 8000 });
    console.log(`✏️ Panel edit-item abierto para: ${prod.nombre}`);

    // Esperar el input de descuento dentro del drawer
    await frame.waitForFunction(
      () => {
        const inputs = [...document.querySelectorAll('[data-testid="edit-item"] input')];
        return inputs.some(
          (inp) =>
            inp.value === "0.0" ||
            inp.value === "0" ||
            inp.closest("div")?.innerText?.toLowerCase().includes("descuento")
        );
      },
      { timeout: 8000 }
    );

    // Limpiar y escribir con setter nativo React
    await frame.evaluate((pct) => {
      const drawer = document.querySelector('[data-testid="edit-item"]');
      const inputs = [...(drawer ? drawer.querySelectorAll("input") : document.querySelectorAll("input"))];

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
      const inputs = [...(drawer ? drawer.querySelectorAll("input") : document.querySelectorAll("input"))];
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

    // Cerrar drawer — botón de cierre dentro de edit-item
    await frame.evaluate(() => {
      const drawer = document.querySelector('[data-testid="edit-item"]');
      if (!drawer) return;
      // Buscar botón de cierre (X o flecha atrás) dentro del drawer
      const closeBtn = drawer.querySelector('button[class*="am-rounded-xs"]');
      if (closeBtn) { closeBtn.click(); return; }
      // Fallback: primer botón con SVG dentro del drawer
      const svgBtn = [...drawer.querySelectorAll("button")].find(
        (b) => b.querySelector("svg") && b.innerText?.trim() === ""
      );
      svgBtn?.click();
    });

    await delay(800);
  }

  console.log("✅ Todos los descuentos aplicados");
}
