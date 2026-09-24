// Pagos de Cobranzas (entrega 3): cargar, confirmar, eliminar. Corre sobre una COPIA de la
// base (nunca la real) y deja los comprobantes de prueba en una carpeta temporal.
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-pagos-'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'database', 'nova.db'), path.join(tmp, 'nova.db'));
process.env.DB_PATH = path.join(tmp, 'nova.db');
process.env.ADJUNTOS_DIR = path.join(tmp, 'adjuntos');
const assert = require('assert');
const { initDb, getDb } = require('../src/db');
const cc = require('../src/models/cuenta-corriente.model');
const R = require('../src/models/recibos.model');
(async () => {
  await initDb();
  const db = getDb();
  const u = await db.prepare("SELECT usuario, confirmar_pagos FROM usuarios").all();
  console.log('usuarios', u.map(x=>x.usuario+':'+x.confirmar_pagos).join(' '));
  const marcelo = { id: 2, usuario: 'marcelo', confirmar_pagos: 1 };
  const lean = { id: 4, usuario: 'leandro', confirmar_pagos: 0 };
  const deb = await db.prepare("SELECT * FROM cc_comprobantes WHERE libro='SF' AND tipo IN ('LQ','FA') AND saldo > 100 AND anulado_at IS NULL ORDER BY saldo DESC LIMIT 2").all();
  if (deb.length < 1) { console.log('sin debitos para probar'); process.exit(0); }
  const d = deb[0]; const cli = d.cliente_id;
  const tot0 = await cc.saldosPorCliente({});
  const s0 = tot0.find(x=>x.cliente_id===cli);
  console.log('cliente', cli, 'debito', d.id, d.numero, d.saldo, 'saldo_sf', s0.saldo_sf);
  const png = { fieldname: 'adj0', mimetype: 'image/png', buffer: Buffer.from('x') };

  // 1) transferencia sin comprobante → error
  await assert.rejects(R.cargarPago({ cliente_id: cli, libro: 'SF', fecha: '2026-09-24', valores: [{ medio: 'transferencia', moneda: 'USD', importe: 50 }] }, {}, lean), /comprobante/);
  // 2) sobre-imputación → error
  await assert.rejects(R.cargarPago({ cliente_id: cli, libro: 'SF', fecha: '2026-09-24', valores: [{ medio: 'efectivo', moneda: 'USD', importe: 50 }], imputaciones: [{ comprobante_id: d.id, importe: 60 }] }, {}, lean), /Se aplican/);
  // 3) informado por Leandro: 100 USD, 80 a la deuda, 20 a favor
  const id1 = await R.cargarPago({ cliente_id: cli, libro: 'SF', fecha: '2026-09-24', valores: [{ medio: 'transferencia', moneda: 'USD', importe: 100, adjunto: 'adj0' }], imputaciones: [{ comprobante_id: d.id, importe: 80 }] }, { adj0: png }, lean);
  let r1 = await R.obtenerRecibo(id1);
  assert.equal(r1.estado, 'informado');
  assert.equal((await cc.obtenerComprobante(d.id)).saldo, d.saldo, 'informado no baja saldo');
  assert.equal((await R.bandeja()).filter(x=>x.id===id1).length, 1);
  // 3b) no se puede comprometer más de lo que queda (considerando el informado)
  await assert.rejects(R.cargarPago({ cliente_id: cli, libro: 'SF', fecha: '2026-09-24', valores: [{ medio: 'efectivo', moneda: 'USD', importe: d.saldo }], imputaciones: [{ comprobante_id: d.id, importe: d.saldo }] }, {}, lean), /sin confirmar/);
  // 3c) Leandro no puede eliminar uno ajeno? es suyo → puede; otro empleado no
  await assert.rejects(R.eliminarPago(id1, 'prueba', { id: 9, usuario: 'victoria', confirmar_pagos: 0 }), /Solo quien lo cargó/);
  // 4) Marcelo confirma
  r1 = await R.confirmarPago(id1, marcelo);
  assert.equal(r1.estado, 'confirmado');
  assert.equal(Math.round((await cc.obtenerComprobante(d.id)).saldo*100), Math.round((d.saldo-80)*100));
  const ac = await db.prepare("SELECT * FROM cc_comprobantes WHERE tipo='AC' AND referencia_id=?").get(r1.comprobante_id);
  assert.equal(ac.saldo, 20);
  const s1 = (await cc.saldosPorCliente({})).find(x=>x.cliente_id===cli);
  console.log('tras confirmar saldo_sf', s1.saldo_sf, 'a_favor_sf', s1.a_favor_sf);
  // 5) empleado no elimina confirmado
  await assert.rejects(R.eliminarPago(id1, 'x mal', lean), /confirmado solo/);
  // 6) Marcelo elimina → vuelve todo
  await R.eliminarPago(id1, 'cargado de prueba', marcelo);
  assert.equal((await cc.obtenerComprobante(d.id)).saldo, d.saldo);
  const ac2 = await cc.obtenerComprobante(ac.id); assert.ok(ac2.anulado_at);
  const s2 = (await cc.saldosPorCliente({})).find(x=>x.cliente_id===cli);
  assert.equal(s2.saldo_sf, s0.saldo_sf); assert.equal(s2.a_favor_sf, s0.a_favor_sf);
  // 7) Marcelo carga directo, cheque en pesos a libro SF con TC
  const id2 = await R.cargarPago({ cliente_id: cli, libro: 'SF', fecha: '2026-09-24', tc_pago: 1450, numero_talonario: 'T-999',
    valores: [{ medio: 'cheque', moneda: 'ARS', importe: 145000, banco: 'Galicia', numero: '123', fecha_vto: '2026-10-10' }],
    imputaciones: [{ comprobante_id: d.id, importe: 100 }] }, {}, marcelo);
  const r2 = await R.obtenerRecibo(id2);
  assert.equal(r2.estado, 'confirmado'); assert.equal(r2.total, 100); assert.equal(r2.a_favor, 0);
  const ch = await db.prepare("SELECT * FROM cc_cheques WHERE recibo_valor_id=?").get(r2.valores[0].id); assert.equal(ch.estado, 'recibido');
  await assert.rejects(R.cargarPago({ cliente_id: cli, libro: 'SF', fecha: '2026-09-24', numero_talonario: 'T-999', valores: [{ medio: 'efectivo', moneda: 'USD', importe: 1 }] }, {}, marcelo), /ya está cargado/);
  await R.eliminarPago(id2, 'prueba', marcelo);
  assert.equal((await cc.obtenerComprobante(d.id)).saldo, d.saldo);
  assert.equal((await db.prepare("SELECT estado FROM cc_cheques WHERE id=?").get(ch.id)).estado, 'anulado');
  // 8) informado que quedó sin saldo porque otro lo cobró antes
  const id3 = await R.cargarPago({ cliente_id: cli, libro: 'SF', fecha: '2026-09-24', valores: [{ medio: 'efectivo', moneda: 'USD', importe: 10 }], imputaciones: [{ comprobante_id: d.id, importe: 10 }] }, {}, lean);
  await db.prepare('UPDATE cc_comprobantes SET saldo = 5 WHERE id = ?').run(d.id);
  await assert.rejects(R.confirmarPago(id3, marcelo), /ya debe solo/);
  assert.equal((await R.obtenerRecibo(id3)).estado, 'informado', 'rollback');
  await db.prepare('UPDATE cc_comprobantes SET saldo = ? WHERE id = ?').run(d.saldo, d.id);
  await R.eliminarPago(id3, 'prueba', lean);
  const tot3 = await cc.saldosPorCliente({});
  const suma = (t,k)=>Math.round(t.reduce((a,x)=>a+x[k],0)*100);
  assert.equal(suma(tot3,'saldo_cf'), suma(tot0,'saldo_cf')); assert.equal(suma(tot3,'saldo_sf'), suma(tot0,'saldo_sf'));
  console.log('pagos cliente (con eliminados):', (await R.pagosCliente(cli,{incluirEliminados:true})).length);
  console.log('TODO OK');
  process.exit(0);
})().catch((e) => { console.error('FALLO', e); process.exit(1); });
