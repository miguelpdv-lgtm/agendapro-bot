# agendapro-bot — versión Playwright

Migración 1:1 del bot original (Puppeteer) a Playwright. **La funcionalidad es
la misma**: mismas rutas HTTP, misma cola, mismo cron, mismos selectores, mismos
`delay()`, mismas guardas anti-precio-cero y mismas alertas por correo.

## Puesta en marcha

```bash
cp .env.example .env   # y rellenar con las credenciales reales
```

```bash
npm install && npm run browsers && npm start
```

`npm run browsers` (= `playwright install chromium`) descarga el navegador. El
paquete `playwright` intenta hacerlo en su postinstall, pero si npm corre con
`ignore-scripts` no pasa nada y el bot falla con *"Executable doesn't exist"*;
por eso conviene dejar el paso explícito. En Docker no hace falta: la imagen ya
trae los navegadores.

> El `.env` ya no se versiona (antes sí lo estaba, con valores de ejemplo). Las
> credenciales van en `.env` local o como variables de entorno del hosting.

## Despliegue en Railway

El `railway.json` ya define builder Dockerfile, healthcheck en `/health` y
política de reinicio. Variables de entorno a configurar en Railway:

```
AGENDAPRO_EMAIL   AGENDAPRO_PASSWORD   SUPABASE_URL   SUPABASE_SERVICE_ROLE_KEY
API_KEY           RESEND_API_KEY       RESEND_FROM_EMAIL
```

`PORT` **no** se define a mano: Railway lo inyecta y el código ya lo lee.
Al quitar `--single-process` (ver nota 5) Chromium consume más RAM que con
Puppeteer; con 512 MB puede morir durante el scraping, con 1–2 GB va sobrado.

## Docker

```bash
docker build -t agendapro-bot-playwright .
```

La imagen base es `mcr.microsoft.com/playwright:v1.48.2-jammy` y **debe coincidir**
con la versión de `playwright` fijada en `package.json`. Si actualizas una, actualiza
la otra.

## Estructura

| Archivo               | Estado                                                        |
| --------------------- | ------------------------------------------------------------- |
| `index.js`            | Idéntico al original (no tocaba el navegador)                  |
| `cola.js`             | Idéntico al original                                           |
| `notificar.js`        | Idéntico al original                                           |
| `ventas.js`           | Migrado a Playwright                                           |
| `inventario.js`       | Migrado a Playwright                                           |
| `corregir-precios.js` | Migrado a Playwright                                           |
| `navegador.js`        | **Nuevo** — helpers para lo que Puppeteer tenía y Playwright no |

## Equivalencias aplicadas

| Puppeteer                                    | Playwright                                                       |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `puppeteer.launch({ headless: true, args })`  | `chromium.launch({ headless: true, args })` (`lanzarNavegador()`) |
| `waitUntil: 'networkidle2'`                   | `waitUntil: 'networkidle'`                                        |
| `page.waitForSelector(sel)`                   | `page.waitForSelector(sel, { state: 'attached' })` *(ver nota 1)* |
| `page.type(sel, txt, { delay })`              | `escribir(page, sel, txt, { delay })` = `focus()` + `keyboard.type()` |
| `page.click('button')`                        | `page.locator('button').first().click()`                          |
| `waitForFunction(fn, { timeout }, arg)`       | `waitForFunction(fn, arg, { timeout })` *(el orden cambia)*        |
| `page.$(sel)` + `handle.click()`              | `page.locator(sel).first()` + `.count()` / `.click()`             |
| `page.setRequestInterception(true)` + `on('request')` | `page.route('**/*', route => route.abort()/continue())`   |
| `browser.pages()`                             | `paginasDe(browser)` = `contexts().flatMap(c => c.pages())`       |
| `elementHandle.contentFrame()`                | igual (`locator(...).elementHandle()` → `.contentFrame()`)        |

`page.evaluate`, `frame.evaluate`, `page.keyboard.*`, `page.goto`,
`page.setDefaultTimeout` y `page.screenshot` funcionan igual en ambos, así que
se copiaron tal cual.

### Notas

1. **`state: 'attached'`** — el default de Puppeteer es "presente en el DOM";
   el de Playwright es "visible". Se fuerza `attached` para conservar el
   comportamiento exacto del original.

2. **Login** — el original hacía `click()` y *después* `waitForNavigation()`, lo
   que puede perderse la navegación si ocurre muy rápido. Aquí van en un
   `Promise.all([...])`, que es el patrón equivalente recomendado: mismo
   resultado, sin la carrera.

3. **`PUPPETEER_EXECUTABLE_PATH`** — se sigue respetando *solo si el binario
   existe*, para no romper despliegues viejos. La variable nueva es
   `PLAYWRIGHT_EXECUTABLE_PATH`. Si ninguna está puesta, se usa el Chromium que
   trae Playwright (lo normal con la imagen Docker de arriba).

4. **`matarChromeSiHay()`** — además de `pkill -f chrome` ahora también mata
   `headless_shell`, que es el binario que Playwright puede usar en headless.

5. **`--single-process` eliminado** (era el flag de `inventario.js` y
   `corregir-precios.js`). Playwright **no lo soporta**: el navegador arranca,
   carga la página y se cierra solo con
   `TargetClosedError: Target page, context or browser has been closed`.
   Verificado por bisección: con ese flag falla siempre, sin él funciona; el
   resto de flags (`--no-zygote`, `--renderer-process-limit=1`,
   `--max-old-space-size=256`) se conservan y no dan problema.
   Efecto secundario: el scraping usará algo más de RAM que con Puppeteer.

6. **El botón de login no matchea el filtro** de `clickLoginButton()`: el botón
   dice `"Log in"` y la lista busca `login` (sin espacio), `ingresar`, `entrar`,
   `sign in`, etc. Ninguno coincide, así que **siempre** cae al fallback
   `keyboard.press('Enter')`. Esto ya pasaba en el original y funciona (el
   formulario se envía igual), por eso se dejó idéntico — pero si algún día el
   Enter deja de enviar, ahí está la causa.
