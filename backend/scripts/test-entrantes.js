// Pagos que entran solos (Mercado Pago): sincronizar sin duplicar, sugerir cliente y deuda,
// revisar (oficina) → confirmar (Marcelo) → eliminar (vuelve a la lista). Corre sobre una
// COPIA de la base y con Mercado Pago simulado (no sale a internet).
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-entrantes-'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'database', 'nova.db'), path.join(tmp, 'nova.db'));
process.env.DB_PATH = path.join(tmp, 'nova.db');
process.env.ADJUNTOS_DIR = path.join(tmp, 'adjuntos');
process.env.MP_ACCESS_TOKEN = 'TEST-token-simulado';
const assert = require('assert');
const { initDb, getDb } = require('../src/db');
const cc = require('../src/models/cuenta-corriente.model');
const R = require('../src/models/recibos.model');
const E = require('../src/models/entrantes.model');
const mp = require('../src/services/mercadopago.service');

(async () => {
  await initDb();
  const db = getDb();
  // Un cliente con deuda abierta en SF; le ponemos un CUIT conocido en su razón social.
  const d = await db.prepare("SELECT * FROM cc_comprobantes WHERE libro='SF' AND tipo IN ('LQ','FA') AND saldo > 50 AND anulado_at IS NULL ORDER BY saldo DESC LIMIT 1").get();
  assert.ok(d, 'hace falta una deuda abierta en la base de prueba');
  const CUIT = '30712345679';
  const rs = await db.prepare('SELECT id FROM clientes_razones_sociales WHERE cliente_id = ? LIMIT 1').get(d.cliente_id);
  if (rs) await db.prepare('UPDATE clientes_razones_sociales SET cuit = ?, activa = 1 WHERE id = ?').run('30-71234567-9', rs.id);
  else await db.prepare('UPDATE clientes SET cuit = ? WHERE id = ?').run('30-71234567-9', d.cliente_id);
  await db.prepare("INSERT OR REPLACE INTO cc_tipo_cambio (fecha, venta, promedio, fuente) VALUES ('2026-09-24', 1400, 1390, 'test')").run();

  const importeARS = Math.round(d.saldo * 1400 * 100) / 100; // en pesos, justo la deuda a TC 1400
  const pagos = [
    { id: 111, status: 'approved', collector_id: 999, transaction_amount: importeARS, currency_id: 'ARS', date_approved: '2026-09-24T10:00:00.000-03:00', operation_type: 'money_transfer', payer: { first_name: 'Cliente', last_name: 'Conocido', identification: { type: 'CUIT', number: CUIT } } },
    { id: 222, status: 'approved', collector_id: 999, transaction_amount: 5000, currency_id: 'ARS', date_approved: '2026-09-24T11:00:00.000-03:00', payer: { first_name: 'Juan', last_name: 'Nadie', identification: { type: 'DNI', number: '12345678' } } },
    { id: 333, status: 'approved', collector_id: 555, transaction_amount: 900, currency_id: 'ARS', date_approved: '2026-09-24T12:00:00.000-03:00', payer: {} }, // Nova paga a otro
    { id: 444, status: 'rejected', collector_id: 999, transaction_amount: 700, currency_id: 'ARS', date_approved: null, date_created: '2026-09-24T12:00:00.000-03:00', payer: {} },
  ];
  global.fetch = async (url) => {
    const body = url.includes('/users/me') ? { id: 999 } : { results: pagos, paging: { total: pagos.length } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  let r = await mp.sincronizar({ dias: 3 });
  assert.equal(r.nuevos, 2, 'entran solo los 2 cobros aprobados de Nova');
  r = await mp.sincronizar({ dias: 3 });
  assert.equal(r.nuevos, 0, 'no duplica');

  let lista = await E.listar();
  const conocido = lista.find((x) => x.id_externo === '111');
  const desconocido = lista.find((x) => x.id_externo === '222');
  assert.equal(conocido.cliente_sugerido.id, d.cliente_id, 'reconoce al cliente por CUIT');
  assert.equal(conocido.sugerencia.libro, 'SF');
  assert.equal(conocido.sugerencia.imputaciones[0].comprobante_id, d.id, 'sugiere la deuda que coincide');
  assert.ok(/^El importe coincide/.test(conocido.sugerencia.motivo));
  assert.equal(desconocido.cliente_sugerido, null, 'no adivina un DNI desconocido');
  console.log('sugerencia:', conocido.sugerencia.motivo, conocido.sugerencia.imputaciones);

  // Descartar y reabrir
  await assert.rejects(E.descartar(desconocido.id, '', { usuario: 'x' }), /por qué/);
  await E.descartar(desconocido.id, 'reintegro, no es cliente', { usuario: 'leandro' });
  assert.equal((await E.listar()).length, 1);
  await E.reabrir(desconocido.id);
  await E.asignarCliente(desconocido.id, d.cliente_id);
  assert.equal((await E.sugerencia(desconocido.id)).cliente_sugerido.id, d.cliente_id);

  // La oficina revisa y pasa: queda informado, NO baja la deuda.
  const lean = { id: 4, usuario: 'leandro', confirmar_pagos: 0 };
  const marcelo = { id: 2, usuario: 'marcelo', confirmar_pagos: 1 };
  const s = conocido.sugerencia;
  const reciboId = await R.cargarPago({ cliente_id: d.cliente_id, libro: s.libro, tc_pago: s.tc, entrante_id: conocido.id,
    imputaciones: s.imputaciones.map((i) => ({ comprobante_id: i.comprobante_id, importe: i.importe })) }, {}, lean);
  let rec = await R.obtenerRecibo(reciboId);
  assert.equal(rec.estado, 'informado');
  assert.equal(rec.valores[0].medio, 'mercadopago');
  assert.equal(rec.entrante.id_externo, '111');
  assert.equal((await cc.obtenerComprobante(d.id)).saldo, d.saldo, 'informado no baja la deuda');
  assert.equal((await E.obtener(conocido.id)).estado, 'revisado');
  assert.ok(await db.prepare('SELECT 1 FROM cliente_cuentas WHERE cuit = ?').get(CUIT), 'aprende el CUIT');
  await assert.rejects(R.cargarPago({ cliente_id: d.cliente_id, libro: 'SF', tc_pago: s.tc, entrante_id: conocido.id }, {}, lean), /ya se revisó/);

  // Marcelo aprueba: baja la deuda.
  await R.confirmarPago(reciboId, marcelo);
  const saldoDespues = (await cc.obtenerComprobante(d.id)).saldo;
  assert.ok(saldoDespues < 0.02, `la deuda queda cancelada (${saldoDespues})`);

  // Se elimina el recibo: la deuda vuelve y el movimiento vuelve a la lista.
  await R.eliminarPago(reciboId, 'prueba', marcelo);
  assert.equal((await cc.obtenerComprobante(d.id)).saldo, d.saldo);
  assert.equal((await E.obtener(conocido.id)).estado, 'nuevo');

  // Transferencia a mano sigue pidiendo comprobante; la que viene de MP no.
  await assert.rejects(R.cargarPago({ cliente_id: d.cliente_id, libro: 'SF', fecha: '2026-09-24', valores: [{ medio: 'mercadopago', moneda: 'USD', importe: 10 }] }, {}, lean), /comprobante/);
  console.log('TODO OK');
  process.exit(0);
})().catch((e) => { console.error('FALLO', e); process.exit(1); });
