#!/usr/bin/env node
/**
 * importar-gecom.js — carga el historial de cuenta corriente del GECOM en cc_comprobantes /
 * cc_recibos / cc_recibo_valores / cc_recibo_imputaciones.
 *
 * Entrada: la carpeta que escribe scripts/gecom/gecom_exportar.py (comprobantes.csv,
 * imputaciones.csv, valores.csv, compensa.csv, cuenta.csv) + scripts/gecom/gecom_clientes.csv
 * (agenda del GECOM: código → CUIT, para cruzar con clientes.cuit).
 *
 *   cd backend && node scripts/importar-gecom.js --carpeta=../scripts/gecom/out [--aplicar]
 *
 * Sin --aplicar solo simula e imprime el informe (clientes sin match, imputaciones sin
 * destino, saldos por libro contra cuenta.fac). Con --aplicar graba, en una transacción.
 *
 * IDEMPOTENTE: la clave es (gecom_punto, gecom_tipo, gecom_numero, gecom_agenda). Si el
 * comprobante ya está, se actualiza; los recibos rehacen sus valores e imputaciones. Se puede
 * correr con nova2026 hoy y con nova2024+2025+2026 mañana sin duplicar nada.
 *
 * Reglas (COBRANZAS-DISENO.md, 21/09/2026):
 *   · punto 00003 → libro CF (ARS) · punto 01900 → libro SF (USD). En SF la "FA" interna es LQ.
 *   · saldo de cada débito = lo que dice cuenta.fac (IMPORTE − IMPCANCELADO): es la verdad del
 *     GECOM. Un comprobante que no está en cuenta.fac está cancelado → saldo 0.
 *   · Recibo con IMPORTE − IMPCANCELADO > 0 en cuenta.fac = plata sin imputar → se crea un AC
 *     (saldo a favor) por el resto, referenciando el recibo.
 *   · Comprobantes de arrastre (solo cabecera, tiporeg 0) toman importe y fechas de cuenta.fac.
 *   · Recibos: 0000nnnn = talonario (numero_talonario = numero); 0010nnnn = automático.
 *   · Clientes: primero scripts/gecom/gecom_mapa_clientes.csv (agenda → accion usar/crear/omitir
 *     + cliente_id, revisado a mano el 22/09); si la agenda no está ahí: CUIT → clientes.cuit,
 *     después nombre exacto, y si no hay nada se CREA el cliente con el nombre y CUIT del GECOM
 *     (un cliente con deuda no puede quedar afuera). Todo lo creado queda listado en el informe.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { initDb, getDb } = require('../src/db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const CARPETA = path.resolve(process.cwd(), args.carpeta || '../scripts/gecom/out');
const AGENDA_CSV = path.resolve(__dirname, '../../scripts/gecom/gecom_clientes.csv');
const MAPA_CSV = path.resolve(__dirname, '../../scripts/gecom/gecom_mapa_clientes.csv');
const APLICAR = !!args.aplicar;

function leerCsv(nombre) {
  const p = path.join(CARPETA, nombre);
  if (!fs.existsSync(p)) return [];
  const txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  const lineas = txt.split(/\r?\n/).filter((l) => l.length);
  if (!lineas.length) return [];
  const cab = lineas[0].split(';');
  return lineas.slice(1).map((l) => Object.fromEntries(l.split(';').map((v, i) => [cab[i], v])));
}
const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const soloDigitos = (s) => String(s || '').replace(/\D/g, '');
const LIBRO = { '00003': 'CF', '01900': 'SF' };
const MONEDA = { CF: 'ARS', SF: 'USD' };

async function main() {
  await initDb();
  const db = getDb();
  const comps = leerCsv('comprobantes.csv');
  const imps = leerCsv('imputaciones.csv');
  const vals = leerCsv('valores.csv');
  const compensa = leerCsv('compensa.csv');
  const cuenta = leerCsv('cuenta.csv');
  if (!comps.length) { console.error('No hay comprobantes.csv en ' + CARPETA); process.exit(1); }

  // ── Clientes: agenda → CUIT → clientes.id ────────────────────────────────────────
  const agenda = new Map(); // codigo (8 dígitos) → { cuit, nombre }
  if (fs.existsSync(AGENDA_CSV)) {
    const txt = fs.readFileSync(AGENDA_CSV, 'utf8').replace(/^﻿/, '');
    const [cab, ...rows] = txt.split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));
    const ix = Object.fromEntries(cab.map((c, i) => [c, i]));
    for (const r of rows) agenda.set(String(r[ix.codigo]).padStart(8, '0'), { cuit: soloDigitos(r[ix.nro_doc]), nombre: r[ix.nombre] });
  }
  const clientes = await db.prepare('SELECT id, nombre, nombre_nova, cuit, gecom_agenda_cf, gecom_agenda_sf FROM clientes').all();
  const porCuit = new Map(); const porAgenda = new Map();
  for (const c of clientes) {
    if (soloDigitos(c.cuit)) porCuit.set(soloDigitos(c.cuit), c);
    if (c.gecom_agenda_cf) porAgenda.set(String(c.gecom_agenda_cf).padStart(8, '0'), c);
    if (c.gecom_agenda_sf) porAgenda.set(String(c.gecom_agenda_sf).padStart(8, '0'), c);
  }
  const normNombre = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const porNombre = new Map();
  for (const c of clientes) { for (const n of [c.nombre, c.nombre_nova]) if (normNombre(n)) porNombre.set(normNombre(n), c); }
  const porId = new Map(clientes.map((c) => [c.id, c]));
  const mapa = new Map(); // agenda → { accion, cliente_id }
  if (fs.existsSync(MAPA_CSV)) {
    const txt = fs.readFileSync(MAPA_CSV, 'utf8').replace(/^\uFEFF/, '');
    const [cab, ...rows] = txt.split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));
    const ix = Object.fromEntries(cab.map((c, i) => [c, i]));
    for (const r of rows) mapa.set(String(r[ix.agenda]).padStart(8, '0'), { accion: r[ix.accion], cliente_id: Number(r[ix.cliente_id]) || null });
  }
  const creados = new Map(); // agenda → cliente (nuevo, todavía sin id hasta grabar)
  const omitidos = new Set();
  const clienteDe = (ag) => {
    const m = mapa.get(ag);
    const a = agenda.get(ag);
    // El mapa revisado a mano manda, incluso sobre lo que una corrida anterior ya cruzó.
    if (m && m.accion === 'omitir') { omitidos.add(ag); return null; }
    if (m && m.accion === 'usar' && m.cliente_id && porId.has(m.cliente_id)) return porId.get(m.cliente_id);
    if (porAgenda.has(ag)) return porAgenda.get(ag);
    if (creados.has(ag)) return creados.get(ag);
    if (!(m && m.accion === 'crear')) {
      if (a && a.cuit && a.cuit.length >= 10 && porCuit.has(a.cuit)) return porCuit.get(a.cuit);
      if (a && porNombre.has(normNombre(a.nombre))) return porNombre.get(normNombre(a.nombre));
    }
    if (!a) return null;
    // No existe: se crea con los datos del GECOM. Si el nombre ya está tomado, se le agrega el código.
    let nombre = a.nombre.replace(/¥/g, 'Ñ').trim();
    if (porNombre.has(normNombre(nombre))) nombre += ' (GECOM ' + Number(ag) + ')';
    const nuevo = { id: null, nombre, nombre_nova: null, cuit: a.cuit && a.cuit.length >= 10 ? a.cuit : null, nuevo: true, agenda: ag };
    creados.set(ag, nuevo); porNombre.set(normNombre(nombre), nuevo);
    return nuevo;
  };
  const sinMatch = new Map();

  // ── cuenta.fac: saldo verdadero por comprobante ───────────────────────────────────
  const claveDe = (r) => `${r.punto}|${r.tipo_cod}|${r.letra}|${r.numero}|${r.agenda}`;
  const enCuenta = new Map();
  for (const r of cuenta) enCuenta.set(claveDe(r), r);

  // ── Comprobantes ──────────────────────────────────────────────────────────────────
  const filas = []; // listas para grabar
  const ids = new Map(); // clave → id (después de grabar) / índice
  let saltados = 0;
  for (const c of comps) {
    const libro = LIBRO[c.punto]; if (!libro) { saltados++; continue; }
    const tipoBase = c.tipo;
    if (!['FA', 'NC', 'ND', 'RC', 'AC'].includes(tipoBase)) { saltados++; continue; }
    const cli = clienteDe(c.agenda);
    if (!cli) { const a = agenda.get(c.agenda); sinMatch.set(c.agenda, (a && a.nombre) || '?'); continue; }
    const cu = enCuenta.get(claveDe(c));
    const tipo = tipoBase === 'FA' && libro === 'SF' ? 'LQ' : tipoBase;
    let importe = num(c.importe);
    let fecha = c.fecha, venc = c.vencimiento || null, tc = num(c.tc), importeUsd = num(c.importe_divisa);
    if (c.tiporeg === '0' || importe === null) {
      if (!cu) { saltados++; continue; }        // arrastre sin datos: no se puede reconstruir
      importe = num(cu.importe); fecha = cu.fecha || fecha; venc = cu.vencimiento || venc;
      importeUsd = num(cu.importe_moneda);
    }
    if (libro === 'SF') { importeUsd = importe; tc = tc && tc !== 1 ? tc : null; }
    if (libro === 'CF' && tc && !importeUsd) importeUsd = r2(importe / tc);
    if (libro === 'CF' && !tc && importeUsd) tc = r2(importe / importeUsd);
    const esDebito = ['FA', 'LQ', 'ND'].includes(tipo);
    // Débito: lo que falta cobrar. NC: lo que todavía no se aplicó a ninguna factura (crédito
    // a favor). Puede quedar negativo en el GECOM (cliente que pagó de más: Casablanca FA 7).
    let saldo = 0;
    if ((esDebito || tipo === 'NC') && cu) saldo = r2(num(cu.importe) - (num(cu.cancelado) || 0));
    const fila = {
      clave: claveDe(c), cliente_id: cli.id, cli, libro, tipo, letra: c.letra || null, punto_venta: c.punto.slice(-4),
      numero: c.numero, fecha, vencimiento: esDebito ? (venc || fecha) : null, moneda: MONEDA[libro], importe: r2(importe),
      tc_dia: tc, importe_usd: importeUsd !== null ? r2(importeUsd) : null,
      importe_ars: libro === 'CF' ? r2(importe) : (tc ? r2(importe * tc) : null),
      saldo, descripcion: c.leyenda || null,
      gecom_punto: c.punto, gecom_tipo: c.tipo_cod, gecom_numero: c.numero, gecom_agenda: c.agenda,
      esRecibo: tipoBase === 'RC', cobrador: c.cobrador, cu,
    };
    filas.push(fila); ids.set(fila.clave, fila);
    // Recibo con plata sin imputar → AC por el resto
    if (tipoBase === 'RC' && cu) {
      const resto = r2(num(cu.importe) - (num(cu.cancelado) || 0));
      if (resto > 0.005) {
        const ac = { ...fila, clave: fila.clave + '|AC', tipo: 'AC', importe: resto, saldo: resto, esRecibo: false,
          gecom_tipo: c.tipo_cod + 'AC', descripcion: 'Saldo a favor del recibo ' + c.numero, refClave: fila.clave,
          importe_usd: libro === 'SF' ? resto : (tc ? r2(resto / tc) : null), importe_ars: libro === 'CF' ? resto : null };
        filas.push(ac); ids.set(ac.clave, ac);
      }
    }
  }
  // Compensaciones NC → FA (referencia). c1 = FA, c2 = NC o RC.
  const refs = [];
  for (const k of compensa) {
    if (k.c2_tipo !== '04') continue;   // 04 = nota de crédito
    const nc = filas.find((f) => f.gecom_punto === k.c2_punto && f.gecom_tipo === '04' && f.gecom_numero === k.c2_numero && f.gecom_agenda === k.agenda);
    const fa = filas.find((f) => f.gecom_punto === k.c1_punto && f.gecom_tipo === k.c1_tipo && f.gecom_numero === k.c1_numero && f.gecom_agenda === k.agenda);
    if (nc && fa) refs.push([nc, fa]);
  }
  // Imputaciones y valores por recibo
  const impPorRc = new Map(); const valPorRc = new Map(); let impSinDestino = 0;
  const buscar = (punto, tipoCod, letra, numero, agendaCod) => {
    const f = filas.find((x) => x.gecom_punto === punto && x.gecom_tipo === tipoCod && x.gecom_numero === numero && x.gecom_agenda === agendaCod)
      || filas.find((x) => x.gecom_punto === punto && x.gecom_tipo === tipoCod && x.gecom_numero === numero);
    return f || null;
  };
  for (const i of imps) {
    const k = `${i.rc_punto}|05||${i.rc_numero}|${i.rc_agenda}`;
    const dest = buscar(i.punto, i.tipo_cod, i.letra, i.numero, i.rc_agenda);
    if (!dest) impSinDestino++;
    impPorRc.set(k, [...(impPorRc.get(k) || []), { dest, importe: num(i.importe), moneda_pago: num(i.moneda_pago), a_cuenta: num(i.a_cuenta) }]);
  }
  for (const v of vals) {
    const k = `${v.rc_punto}|05||${v.rc_numero}|${v.rc_agenda}`;
    valPorRc.set(k, [...(valPorRc.get(k) || []), v]);
  }

  // ── Informe ──────────────────────────────────────────────────────────────────────
  // Saldo neto por libro = débitos abiertos − créditos sin aplicar (NC y resto de recibos).
  const porLibro = { CF: { deb: 0, saldo: 0, n: 0 }, SF: { deb: 0, saldo: 0, n: 0 } };
  for (const f of filas) {
    if (['FA', 'LQ', 'ND'].includes(f.tipo)) { porLibro[f.libro].n++; porLibro[f.libro].saldo += f.saldo; }
    else if (['NC', 'AC'].includes(f.tipo)) porLibro[f.libro].saldo -= f.saldo;
  }
  const saldoCuenta = { CF: 0, SF: 0 };
  for (const r of cuenta) {
    const s = num(r.importe) - (num(r.cancelado) || 0);
    if (['02', '03'].includes(r.tipo_cod)) saldoCuenta[LIBRO[r.punto]] += s;
    else if (['04', '05'].includes(r.tipo_cod)) saldoCuenta[LIBRO[r.punto]] -= s;
  }
  console.log(`Comprobantes a cargar: ${filas.length} (saltados ${saltados}) · recibos ${filas.filter((f) => f.esRecibo).length} · AC por resto ${filas.filter((f) => f.tipo === 'AC').length}`);
  if (creados.size) {
    console.log(`\nCLIENTES NUEVOS que se crean desde el GECOM (${creados.size}):`);
    for (const [ag, c] of creados) console.log(`  agenda ${ag}  ${c.nombre}  (CUIT ${c.cuit || '-'})`);
  }
  if (omitidos.size) console.log(`Agendas omitidas por el mapa: ${[...omitidos].join(', ')}`);
  console.log(`Saldo CF (ARS): importado ${r2(porLibro.CF.saldo).toLocaleString('es-AR')} vs cuenta.fac ${r2(saldoCuenta.CF).toLocaleString('es-AR')}`);
  console.log(`Saldo SF (USD): importado ${r2(porLibro.SF.saldo).toLocaleString('es-AR')} vs cuenta.fac ${r2(saldoCuenta.SF).toLocaleString('es-AR')}`);
  console.log(`Imputaciones: ${imps.length} (sin destino en esta corrida: ${impSinDestino}) · valores: ${vals.length} · referencias NC→FA: ${refs.length}`);
  if (sinMatch.size) {
    console.log(`\nCLIENTES DEL GECOM SIN MATCH (${sinMatch.size}) — sus comprobantes NO se cargan:`);
    for (const [ag, nom] of sinMatch) console.log(`  agenda ${ag}  ${nom}  (CUIT ${(agenda.get(ag) || {}).cuit || '-'})`);
  }
  // Diferencia por cliente entre lo que da cuenta.fac y lo importado (solo clientes con match)
  const porCli = new Map();
  for (const r of cuenta) {
    if (!['02', '03', '04', '05'].includes(r.tipo_cod)) continue;
    const cli = clienteDe(r.agenda); if (!cli) continue;
    const k = (cli.id || 'nuevo:' + cli.agenda) + '|' + LIBRO[r.punto];
    const s = num(r.importe) - (num(r.cancelado) || 0);
    porCli.set(k, (porCli.get(k) || 0) + (['02', '03'].includes(r.tipo_cod) ? s : -s));
  }
  const importado = new Map();
  for (const f of filas) {
    const k = (f.cli.id || 'nuevo:' + f.cli.agenda) + '|' + f.libro;
    if (['FA', 'LQ', 'ND'].includes(f.tipo)) importado.set(k, (importado.get(k) || 0) + f.saldo);
    else if (['NC', 'AC'].includes(f.tipo)) importado.set(k, (importado.get(k) || 0) - f.saldo);
  }
  const difs = [...porCli].filter(([k, v]) => Math.abs(v - (importado.get(k) || 0)) > 0.01);
  if (difs.length) { console.log('\nDIFERENCIAS por cliente (cuenta.fac vs importado):'); for (const [k, v] of difs) console.log(`  ${k}: ${r2(v)} vs ${r2(importado.get(k) || 0)}`); }
  else console.log('\nSaldos por cliente: todos iguales a cuenta.fac.');

  // ── Liquidaciones que están dos veces: LQ del sistema (origen sistema) y FAB 1900 del GECOM ──
  // Regla (22/09): se queda la del GECOM, que es la que tiene los recibos imputados, enlazada a
  // la liquidación (liquidacion_id); la del sistema se anula con motivo. Cruce: mismo cliente,
  // mismo importe (±0,01) y fecha a menos de 60 días. Corre también sobre lo ya grabado, así que
  // sirve tanto en la primera importación como en las nocturnas.
  const cruces = await cruzarLiquidaciones(db, filas, APLICAR);
  console.log(`\nLiquidaciones del sistema cruzadas con su FAB del GECOM: ${cruces.unidas} · sin par en el GECOM (quedan como están): ${cruces.sinPar}`);

  if (!APLICAR) { console.log('\n(simulación: agregá --aplicar para grabar)'); process.exit(0); }

  // ── Grabar ───────────────────────────────────────────────────────────────────────
  await db.transaction(async () => {
    for (const [ag, c] of creados) {
      const r = await db.prepare(`INSERT INTO clientes (nombre, tipo_cobro, cuit, gecom_agenda_cf, gecom_agenda_sf) VALUES (?, 'CC', ?, ?, ?)`).run(c.nombre, c.cuit, ag, ag);
      c.id = r.lastInsertRowid;
    }
    for (const f of filas) f.cliente_id = f.cli.id;
    // Razón social por agenda del GECOM (22/09): cada perfil viejo es una razón social del
    // cliente, no un cliente. Si la principal del cliente no tiene agenda y coincide el CUIT
    // (o es la única), se le asigna esta; si no, se crea otra con el nombre y CUIT del GECOM.
    const rsPorAgenda = new Map();
    const agendasUsadas = [...new Set(filas.map((f) => f.gecom_agenda))];
    for (const ag of agendasUsadas) {
      const f = filas.find((x) => x.gecom_agenda === ag);
      const a = agenda.get(ag) || {};
      let rs = await db.prepare('SELECT id, cliente_id FROM clientes_razones_sociales WHERE gecom_agenda = ?').get(ag);
      if (rs && rs.cliente_id !== f.cliente_id) {
        // El mapa movió esta agenda a otro cliente: la razón social se muda con sus comprobantes.
        await db.prepare('UPDATE clientes_razones_sociales SET cliente_id = ?, principal = 0 WHERE id = ?').run(f.cliente_id, rs.id);
      }
      if (!rs) {
        const cuit = a.cuit && a.cuit.length >= 10 ? a.cuit : null;
        const libres = await db.prepare('SELECT id, cuit, razon_social FROM clientes_razones_sociales WHERE cliente_id = ? AND gecom_agenda IS NULL').all(f.cliente_id);
        const cand = libres.find((r) => cuit && soloDigitos(r.cuit) === cuit) || (libres.length === 1 && !(libres[0].cuit && cuit && soloDigitos(libres[0].cuit) !== cuit) ? libres[0] : null);
        if (cand) {
          await db.prepare('UPDATE clientes_razones_sociales SET gecom_agenda = ?, cuit = COALESCE(cuit, ?) WHERE id = ?').run(ag, cuit, cand.id);
          rs = { id: cand.id };
        } else {
          const nombre = (a.nombre || ('GECOM ' + ag)).replace(/¥/g, 'Ñ').trim();
          const esPrincipal = (await db.prepare('SELECT COUNT(*) AS n FROM clientes_razones_sociales WHERE cliente_id = ?').get(f.cliente_id)).n === 0 ? 1 : 0;
          const r = await db.prepare('INSERT INTO clientes_razones_sociales (cliente_id, razon_social, cuit, principal, gecom_agenda) VALUES (?, ?, ?, ?, ?)').run(f.cliente_id, nombre, cuit, esPrincipal, ag);
          rs = { id: r.lastInsertRowid };
        }
      }
      rsPorAgenda.set(ag, rs.id);
    }
    const sel = db.prepare('SELECT id FROM cc_comprobantes WHERE gecom_punto = ? AND gecom_tipo = ? AND gecom_numero = ? AND gecom_agenda = ?');
    const ins = db.prepare(`INSERT INTO cc_comprobantes (cliente_id, razon_social_id, libro, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, importe,
        tc_dia, importe_usd, importe_ars, saldo, descripcion, origen, gecom_punto, gecom_tipo, gecom_numero, gecom_agenda, creado_por)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gecom', ?, ?, ?, ?, 'importar-gecom')`);
    const upd = db.prepare(`UPDATE cc_comprobantes SET cliente_id = ?, razon_social_id = ?, libro = ?, tipo = ?, letra = ?, punto_venta = ?, numero = ?, fecha = ?, vencimiento = ?,
        moneda = ?, importe = ?, tc_dia = ?, importe_usd = ?, importe_ars = ?, saldo = ?, descripcion = ? WHERE id = ?`);
    for (const f of filas) {
      const ex = await sel.get(f.gecom_punto, f.gecom_tipo, f.gecom_numero, f.gecom_agenda);
      const p = [f.cliente_id, rsPorAgenda.get(f.gecom_agenda) || null, f.libro, f.tipo, f.letra, f.punto_venta, f.numero, f.fecha, f.vencimiento, f.moneda, f.importe, f.tc_dia, f.importe_usd, f.importe_ars, f.saldo, f.descripcion];
      if (ex) { await upd.run(...p, ex.id); f.id = ex.id; }
      else { const r = await ins.run(...p, f.gecom_punto, f.gecom_tipo, f.gecom_numero, f.gecom_agenda); f.id = r.lastInsertRowid; }
      if (f.liquidacion_id) await db.prepare('UPDATE cc_comprobantes SET liquidacion_id = ? WHERE id = ?').run(f.liquidacion_id, f.id);
    }
    for (const f of filas) if (f.refClave) await db.prepare('UPDATE cc_comprobantes SET referencia_id = ? WHERE id = ?').run(ids.get(f.refClave).id, f.id);
    for (const [nc, fa] of refs) await db.prepare('UPDATE cc_comprobantes SET referencia_id = ? WHERE id = ?').run(fa.id, nc.id);
    // Recibos
    for (const f of filas.filter((x) => x.esRecibo)) {
      const talonario = /^0000\d{4}$/.test(f.numero) ? f.numero : null;
      const impsRc = impPorRc.get(f.clave) || [];
      const sumaMon = impsRc.reduce((s, i) => s + (i.moneda_pago || 0), 0);
      const tcPago = f.libro === 'CF' && sumaMon > 0 ? r2(f.importe / sumaMon) : null;
      let rc = await db.prepare('SELECT id FROM cc_recibos WHERE comprobante_id = ?').get(f.id);
      if (!rc) {
        const r = await db.prepare(`INSERT INTO cc_recibos (comprobante_id, numero_sistema, numero_talonario, estado, confirmado_por, confirmado_at, moneda_pago, tc_pago, total, observaciones)
          VALUES (?, ?, ?, 'confirmado', 'gecom', ?, ?, ?, ?, ?)`).run(f.id, Number(f.numero), talonario, f.fecha, f.moneda, tcPago, f.importe, f.descripcion);
        rc = { id: r.lastInsertRowid };
      } else {
        await db.prepare('UPDATE cc_recibos SET numero_sistema = ?, numero_talonario = ?, moneda_pago = ?, tc_pago = ?, total = ? WHERE id = ?').run(Number(f.numero), talonario, f.moneda, tcPago, f.importe, rc.id);
        await db.prepare('DELETE FROM cc_recibo_valores WHERE recibo_id = ?').run(rc.id);
        await db.prepare('DELETE FROM cc_recibo_imputaciones WHERE recibo_id = ?').run(rc.id);
      }
      for (const v of valPorRc.get(f.clave) || []) {
        await db.prepare(`INSERT INTO cc_recibo_valores (recibo_id, medio, moneda, importe, banco, numero, fecha_vto, cuit_emisor)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(rc.id, ['efectivo', 'transferencia', 'cheque', 'mercadopago', 'otro'].includes(v.medio) ? v.medio : 'otro',
          f.moneda, r2(v.importe), v.banco || null, v.cheque_nro || null, v.vto || null, v.cuit_emisor || null);
      }
      for (const i of impsRc) {
        if (!i.dest || !i.dest.id) continue;
        await db.prepare('INSERT INTO cc_recibo_imputaciones (recibo_id, comprobante_id, importe, estado) VALUES (?, ?, ?, ?)').run(rc.id, i.dest.id, r2(i.importe), 'aplicada');
      }
    }
    // Guardar el código de agenda en el cliente para las próximas corridas
    for (const f of filas) {
      const col = f.libro === 'CF' ? 'gecom_agenda_cf' : 'gecom_agenda_sf';
      await db.prepare(`UPDATE clientes SET ${col} = ? WHERE id = ? AND (${col} IS NULL OR ${col} = '')`).run(f.gecom_agenda, f.cliente_id);
    }
    // Clientes que una corrida anterior creó desde el GECOM y que el mapa ahora manda a otro
    // cliente: quedaron vacíos (sin envíos, liquidaciones ni comprobantes) → se borran.
    const huerfanos = await db.prepare(`
      SELECT c.id, c.nombre FROM clientes c
      WHERE COALESCE(c.gecom_agenda_cf, c.gecom_agenda_sf) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cc_comprobantes x WHERE x.cliente_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM envios e WHERE e.cliente_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM liquidaciones l WHERE l.cliente_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM cotizaciones q WHERE q.cliente_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM pickups p WHERE p.cliente_id = c.id)`).all();
    for (const h of huerfanos) {
      const ag = agendasUsadas.find((x) => x === (clientes.find((c) => c.id === h.id) || {}).gecom_agenda_cf || x === (clientes.find((c) => c.id === h.id) || {}).gecom_agenda_sf);
      const m = ag ? mapa.get(ag) : null;
      if (!m || m.accion !== 'usar' || m.cliente_id === h.id) continue;
      await db.prepare('DELETE FROM clientes_razones_sociales WHERE cliente_id = ?').run(h.id);
      await db.prepare('DELETE FROM clientes WHERE id = ?').run(h.id);
      console.log(`  cliente vacío borrado: #${h.id} ${h.nombre} (su agenda ahora va al cliente ${m.cliente_id})`);
    }
  });
  console.log('\nGrabado.');
  process.exit(0);
}
async function cruzarLiquidaciones(db, filas, aplicar) {
  const sistema = await db.prepare(
    `SELECT id, cliente_id, importe, fecha, liquidacion_id, saldo FROM cc_comprobantes
     WHERE origen = 'sistema' AND tipo = 'LQ' AND liquidacion_id IS NOT NULL AND anulado_at IS NULL`
  ).all();
  let unidas = 0, sinPar = 0;
  for (const lq of sistema) {
    // Candidato en lo ya grabado (corridas anteriores) o en lo que se va a grabar ahora.
    let par = await db.prepare(
      `SELECT id FROM cc_comprobantes WHERE origen = 'gecom' AND tipo = 'LQ' AND cliente_id = ? AND anulado_at IS NULL
         AND ABS(importe - ?) < 0.011 AND ABS(julianday(fecha) - julianday(?)) <= 60 AND (liquidacion_id IS NULL OR liquidacion_id = ?)
       ORDER BY ABS(julianday(fecha) - julianday(?)) LIMIT 1`
    ).get(lq.cliente_id, lq.importe, lq.fecha, lq.liquidacion_id, lq.fecha);
    if (!par) {
      const f = filas.find((x) => x.tipo === 'LQ' && (x.cli.id === lq.cliente_id) && Math.abs(x.importe - lq.importe) < 0.011
        && Math.abs((new Date(x.fecha) - new Date(lq.fecha)) / 86400000) <= 60 && !x.liquidacion_id);
      if (f) { f.liquidacion_id = lq.liquidacion_id; par = f; }
    }
    if (!par) { sinPar++; continue; }
    unidas++;
    if (aplicar) {
      // liquidacion_id es único en cc_comprobantes: primero se libera en la del sistema (queda
      // anulada, con el id de la liquidación en la descripción), después se enlaza la del GECOM.
      await db.prepare(
        `UPDATE cc_comprobantes SET liquidacion_id = NULL, anulado_at = datetime('now','localtime'), anulado_por = 'importar-gecom',
           anulado_motivo = 'Duplicada: la liquidación ' || ? || ' está cargada en el GECOM (FAB 1900), que es la que lleva los pagos',
           descripcion = COALESCE(descripcion, '') || ' [LQ sistema ' || ? || ']' WHERE id = ?`
      ).run(lq.liquidacion_id, lq.liquidacion_id, lq.id);
      if (par.id) await db.prepare('UPDATE cc_comprobantes SET liquidacion_id = ? WHERE id = ?').run(lq.liquidacion_id, par.id);
    }
  }
  return { unidas, sinPar };
}

main().catch((e) => { console.error(e); process.exit(1); });
