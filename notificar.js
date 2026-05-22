// ─────────────────────────────────────────────────────────────────────────────
// notificar.js — Alertas por correo usando Resend
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CORREO_DESTINO = 'mpdv008@gmail.com';
const CORREO_ORIGEN  = process.env.RESEND_FROM_EMAIL || 'alertas@tudominio.com';

/**
 * Envía un correo de alerta cuando algo falla.
 * @param {object} opts
 * @param {string} opts.asunto     - Asunto del correo
 * @param {string} opts.script     - Nombre del script que falló
 * @param {string} opts.error      - Mensaje de error
 * @param {string} [opts.contexto] - Info adicional (producto, página, etc.)
 * @param {number} [opts.intento]  - Número de intento si hubo reintentos
 */
async function notificarError({
  asunto,
  script,
  error,
  contexto = '',
  intento = null,
}) {
  if (!RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY no configurada, correo no enviado.');
    return;
  }

  const ahora = new Date().toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
  });

  const intentoTexto =
    intento != null ? `<p><b>Intento:</b> ${intento}</p>` : '';

  const contextoTexto =
    contexto ? `<p><b>Contexto:</b> ${contexto}</p>` : '';

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <div style="background:#dc2626;padding:16px 24px">
        <h2 style="color:#fff;margin:0">❌ Error en automatización</h2>
      </div>
      <div style="padding:24px;background:#fff">
        <p><b>Script:</b> ${script}</p>
        <p><b>Hora (COL):</b> ${ahora}</p>
        ${intentoTexto}
        ${contextoTexto}
        <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px 16px;border-radius:4px;margin-top:12px">
          <b>Error:</b><br/>
          <code style="font-size:13px;word-break:break-all">${error}</code>
        </div>
        <p style="color:#6b7280;font-size:12px;margin-top:24px">
          Este correo fue generado automáticamente. Revisa los logs para más detalle.
        </p>
      </div>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: CORREO_ORIGEN,
        to:   [CORREO_DESTINO],
        subject: asunto,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('❌ Resend error:', body);
    } else {
      console.log(`📧 Alerta enviada a ${CORREO_DESTINO}`);
    }
  } catch (e) {
    console.error('❌ No se pudo enviar el correo:', e.message);
  }
}

/**
 * Envía un correo informativo cuando todo salió bien.
 * Útil para confirmar ejecuciones programadas.
 */
async function notificarOk({ script, resumen }) {
  if (!RESEND_API_KEY) return;

  const ahora = new Date().toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
  });

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <div style="background:#16a34a;padding:16px 24px">
        <h2 style="color:#fff;margin:0">✅ Sync completado</h2>
      </div>
      <div style="padding:24px;background:#fff">
        <p><b>Script:</b> ${script}</p>
        <p><b>Hora (COL):</b> ${ahora}</p>
        <div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:12px 16px;border-radius:4px;margin-top:12px">
          ${resumen}
        </div>
      </div>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: CORREO_ORIGEN,
        to:   [CORREO_DESTINO],
        subject: `✅ ${script} — OK`,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('❌ Resend error:', body);
    }
  } catch (e) {
    console.error('❌ No se pudo enviar el correo OK:', e.message);
  }
}

module.exports = { notificarError, notificarOk };
