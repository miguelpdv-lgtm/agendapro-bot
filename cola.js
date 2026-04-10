// ─────────────────────────────────────────────────────────────────────────────
//  cola.js — Cola FIFO, un worker a la vez
// ─────────────────────────────────────────────────────────────────────────────
const { EventEmitter } = require('events');

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
    } finally {
      this._ocupado = false;
      setImmediate(() => this._procesar());
    }
  }
}

module.exports = new Cola();
