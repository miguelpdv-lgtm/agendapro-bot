// ─────────────────────────────────────────────────────────────────────────────
//  cola.js — Cola FIFO, un worker a la vez
// ─────────────────────────────────────────────────────────────────────────────
const { EventEmitter } = require('events');
const { notificarError } = require('./notificar');

class Cola extends EventEmitter {
  constructor() {
    super();
    this._trabajos = [];
    this._ocupado  = false;
    this._contador = 0;
  }

  agregar(productos) {
    return new Promise((resolve, reject) => {
      const id = ++this._contador;
      this._trabajos.push({ id, productos, resolve, reject });
      console.log(`📥 [Cola] Trabajo #${id} encolado. En espera: ${this._trabajos.length}`);
      this._procesar();
    });
  }

  get largo()   { return this._trabajos.length; }
  get ocupado() { return this._ocupado; }

  async _procesar() {
    if (this._ocupado || this._trabajos.length === 0) return;
    this._ocupado = true;
    const trabajo = this._trabajos.shift();
    console.log(`▶️  [Cola] Iniciando trabajo #${trabajo.id}`);
    try {
      const { ejecutarVenta } = require('./ventas');
      const resultado = await ejecutarVenta(trabajo.productos);
      trabajo.resolve(resultado);
      console.log(`✅ [Cola] Trabajo #${trabajo.id} completado`);
    } catch (err) {
      trabajo.reject(err);
      console.error(`❌ [Cola] Trabajo #${trabajo.id} falló:`, err.message);

      // ── Notificar si ventas.js no lo hizo (ej: error antes del try/catch) ─
      // ventas.js ya notifica errores internos; aquí capturamos cualquier
      // error que se escape fuera de ejecutarVenta (ej: crash al arrancar browser)
      // El doble envío no ocurre porque ventas.js re-lanza después de notificar.
      // Si quieres evitar el doble envío completamente, agrega una propiedad:
      //   err._notificado = true  en ventas.js, y chequea acá.
      if (!err._notificado) {
        const nombresProductos = trabajo.productos
          .map((p) => `${p.nombre} x${p.cantidad}`)
          .join(', ');

        await notificarError({
          asunto: `❌ [Cola] Trabajo #${trabajo.id} fallido`,
          script: 'cola.js → ventas.js',
          error: err.message,
          contexto: `Productos: ${nombresProductos}`,
          intento: trabajo.id,
        }).catch((e) =>
          console.error('❌ No se pudo enviar alerta de cola:', e.message)
        );
      }
    } finally {
      this._ocupado = false;
      setImmediate(() => this._procesar());
    }
  }
}

module.exports = new Cola();
