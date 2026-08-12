#!/usr/bin/env node
/**
 * migrar-tramos.js — pasa las tarifas ya cargadas al esquema de tramos por cliente.
 *
 * QUÉ RESUELVE
 * Hasta ahora el rango de peso de una tarifa por kilo era libre: cada cliente tenía el que
 * le hubieran cargado (20 a 29,5 · 32,5 en adelante · 25 en adelante · 10 a 20). Eso dejaba
 * huecos y tramos pisados que solo se veían cuando ya se había cobrado. Ahora cada cliente
 * tiene un JUEGO de tramos continuo y sin solapes, y toda fila de tarifa tiene que caer
 * exactamente en uno.
 *
 * LA IDEA, QUE ES LO IMPORTANTE
 * No se elige un juego y se fuerza a los clientes a entrar. Se hace al revés: el juego de
 * cada cliente sale de la UNIÓN de los cortes que ya usa más los generales. Después cada
 * fila existente se PARTE en los tramos que cubría, con el mismo valor.
 *
 *   PIO ALVAREZ, 20 a 32 kg a USD 7,02  →  20-25, 25-30 y 30-32, los tres a USD 7,02
 *
 * Por eso la migración es NEUTRA: no le cambia el precio a nadie. La tarifa de 32 kg que la
 * oficina dijo que no se puede tocar queda intacta, expresada de otra forma.
 *
 * LO ÚNICO QUE SE MUEVE SON LOS BORDES
 * Antes los límites eran inclusivos de los dos lados (un envío de exactamente 20,00 kg
 * entraba en el rango "20 a 32"). Ahora el límite de abajo es exclusivo: 20,00 kg cae en el
 * tramo que termina en 20. Afecta únicamente a los envíos que pesan EXACTAMENTE un corte.
 * El informe los cuenta contra los envíos reales, así que no hay que suponerlo.
 *
 *   cd backend && node scripts/migrar-tramos.js            → solo informa, no toca nada
 *   cd backend && node scripts/migrar-tramos.js --aplicar  → aplica
 *
 * Sale con 0 si el informe está limpio, 1 si detectó algún cambio de precio.
 */

const APLICAR = process.argv.includes('--aplicar');

(async () => {
  const { initDb, getDb, closeDb } = require('../src/db');
  await initDb();
  const db = getDb();
  const { TRAMOS_POR_DEFECTO } = require('../src/services/profit.service');

  const CORTES_POR_DEFECTO = TRAMOS_POR_DEFECTO.map((t) => t.min);
  const fmt = (t) => (t.max === null ? `${t.min}+` : `${t.min}-${t.max}`);
  const usd = (v) => `USD ${Number(v).toFixed(2)}`;

  // ── Qué clientes tienen algo cargado ──────────────────────────────────────
  const filasKg = await db
    .prepare(
      `SELECT k.id, k.cliente_id, k.servicio, k.tipo, k.zona, k.peso_min, k.peso_max, k.precio_kg,
              c.nombre
         FROM tarifa_kg_overrides k JOIN clientes c ON c.id = k.cliente_id
        ORDER BY k.cliente_id, k.servicio, k.tipo, k.zona, k.peso_min`
    )
    .all();
  const filasPct = await db
    .prepare(
      `SELECT p.id, p.cliente_id, p.servicio, p.tipo, p.zona, p.peso_min, p.peso_max, p.profit_pct,
              c.nombre
         FROM profit_overrides p JOIN clientes c ON c.id = p.cliente_id
        ORDER BY p.cliente_id, p.servicio, p.tipo, p.zona, p.peso_min`
    )
    .all();

  const clientes = new Map();
  const anotar = (f, tabla) => {
    if (!clientes.has(f.cliente_id)) {
      clientes.set(f.cliente_id, { id: f.cliente_id, nombre: f.nombre, kg: [], pct: [] });
    }
    clientes.get(f.cliente_id)[tabla].push(f);
  };
  filasKg.forEach((f) => anotar(f, 'kg'));
  filasPct.forEach((f) => anotar(f, 'pct'));

  /**
   * Arma el juego de tramos de un cliente: los cortes generales más los que él ya usa.
   * Así ninguna fila queda huérfana y ningún corte negociado se pierde.
   */
  function juegoDe(cliente) {
    const cortes = new Set(CORTES_POR_DEFECTO);
    cortes.add(0);
    for (const f of [...cliente.kg, ...cliente.pct]) {
      if (f.peso_min !== null) cortes.add(Number(f.peso_min));
      if (f.peso_max !== null && f.peso_max !== undefined) cortes.add(Number(f.peso_max));
    }
    const orden = [...cortes].sort((a, b) => a - b);
    const tramos = [];
    for (let i = 0; i < orden.length; i += 1) {
      tramos.push({ min: orden[i], max: i === orden.length - 1 ? null : orden[i + 1] });
    }
    return tramos;
  }

  /** Los tramos que una fila vieja cubría, con los límites viejos (inclusivos). */
  function tramosCubiertos(tramos, fila) {
    const min = Number(fila.peso_min);
    const max = fila.peso_max === null || fila.peso_max === undefined ? Infinity : Number(fila.peso_max);
    return tramos.filter((t) => t.min >= min && (t.max === null ? max === Infinity : t.max <= max));
  }

  // ── Resolución vieja y nueva, para comparar precio contra precio ───────────
  const resolverViejo = (filas, zona, pf) => {
    const nivel = (z, conRango) =>
      filas.filter((f) => (z === null ? f.zona === null : f.zona === z)
        && (conRango ? f.peso_min !== null : f.peso_min === null));
    const contiene = (rows) => {
      const c = rows.filter((r) => pf >= r.peso_min && (r.peso_max === null || pf <= r.peso_max));
      return c.sort((a, b) => b.peso_min - a.peso_min)[0] || null;
    };
    return contiene(nivel(zona, true)) || contiene(nivel(null, true))
      || nivel(zona, false)[0] || nivel(null, false)[0] || null;
  };
  const resolverNuevo = (filas, tramos, zona, pf) => {
    const t = tramos.find((x) => (x.max === null ? pf > x.min : (x.min === 0 ? pf <= x.max : pf > x.min && pf <= x.max)));
    const exacta = (z) => filas.find((f) => (z === null ? f.zona === null : f.zona === z)
      && t && f.peso_min === t.min);
    const general = (z) => filas.find((f) => (z === null ? f.zona === null : f.zona === z) && f.peso_min === null);
    return exacta(zona) || exacta(null) || general(zona) || general(null) || null;
  };

  // ── Informe ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(APLICAR ? 'MIGRACIÓN DE TRAMOS — APLICANDO' : 'MIGRACIÓN DE TRAMOS — SOLO INFORME, no se toca nada');
  console.log('═'.repeat(72));

  const plan = [];
  let cambiosDePrecio = 0;

  for (const cliente of [...clientes.values()].sort((a, b) => a.id - b.id)) {
    const tramos = juegoDe(cliente);
    const propios = !(tramos.length === TRAMOS_POR_DEFECTO.length
      && tramos.every((t, i) => t.min === TRAMOS_POR_DEFECTO[i].min && t.max === TRAMOS_POR_DEFECTO[i].max));

    const nuevasKg = [];
    const nuevasPct = [];
    const partir = (filas, destino, campo) => {
      for (const f of filas) {
        if (f.peso_min === null) { destino.push({ ...f, _intacta: true }); continue; }
        const cubre = tramosCubiertos(tramos, f);
        if (cubre.length === 0) { destino.push({ ...f, _huerfana: true }); continue; }
        cubre.forEach((t) => destino.push({
          ...f, peso_min: t.min, peso_max: t.max, [campo]: f[campo],
          _de: `${f.peso_min}-${f.peso_max === null ? '' : f.peso_max}`,
        }));
      }
    };
    partir(cliente.kg, nuevasKg, 'precio_kg');
    partir(cliente.pct, nuevasPct, 'profit_pct');

    // ¿Cambia algún precio? Se barre de 0,1 en 0,1 kg hasta 60 y se compara.
    const difs = [];
    for (const grupo of ['kg', 'pct']) {
      const viejas = grupo === 'kg' ? cliente.kg : cliente.pct;
      const nuevas = grupo === 'kg' ? nuevasKg : nuevasPct;
      const campo = grupo === 'kg' ? 'precio_kg' : 'profit_pct';
      const combos = new Set(viejas.map((f) => `${f.servicio}|${f.tipo}`));
      for (const combo of combos) {
        const [servicio, tipo] = combo.split('|');
        const vs = viejas.filter((f) => f.servicio === servicio && f.tipo === tipo);
        const ns = nuevas.filter((f) => f.servicio === servicio && f.tipo === tipo);
        for (const zona of [1, 2, 3, 4, 5, 6]) {
          for (let kg = 0.1; kg <= 60.05; kg += 0.1) {
            const pf = Number(kg.toFixed(1));
            const a = resolverViejo(vs, zona, pf);
            const b = resolverNuevo(ns, tramos, zona, pf);
            const va = a ? a[campo] : null;
            const vb = b ? b[campo] : null;
            if (va !== vb) difs.push({ grupo, servicio, tipo, zona, pf, antes: va, despues: vb });
          }
        }
      }
    }

    plan.push({ cliente, tramos, propios, nuevasKg, nuevasPct, difs });
    cambiosDePrecio += difs.length;

    console.log(`\n▸ ${cliente.id} · ${cliente.nombre}`);
    console.log(`  tramos: ${tramos.map(fmt).join(' · ')}`);
    console.log(`  ${propios ? 'PROPIOS (su tarifa no corta donde cortan los generales)' : 'los generales'}`);
    console.log(`  tarifa por kilo: ${cliente.kg.length} filas → ${nuevasKg.length}`);
    console.log(`  porcentaje:      ${cliente.pct.length} filas → ${nuevasPct.length}`);

    const huerfanas = [...nuevasKg, ...nuevasPct].filter((f) => f._huerfana);
    if (huerfanas.length) {
      console.log(`  ⚠️  ${huerfanas.length} fila(s) que ningún tramo cubre — REVISAR A MANO`);
      huerfanas.forEach((f) => console.log(`      zona ${f.zona} · ${f.peso_min}-${f.peso_max}`));
    }

    if (difs.length === 0) {
      console.log('  ✓ ningún precio cambia');
    } else {
      // Se agrupan los pesos contiguos para no escupir 600 renglones.
      const porCaso = new Map();
      difs.forEach((d) => {
        const k = `${d.grupo}|${d.servicio}|${d.tipo}|${d.zona}|${d.antes}|${d.despues}`;
        if (!porCaso.has(k)) porCaso.set(k, { ...d, pesos: [] });
        porCaso.get(k).pesos.push(d.pf);
      });
      console.log(`  ⚠️  ${difs.length} peso(s) cambian de precio:`);
      [...porCaso.values()].forEach((c) => {
        const desde = Math.min(...c.pesos), hasta = Math.max(...c.pesos);
        const val = (v) => (v === null ? 'sin precio (cae al porcentaje)' : c.grupo === 'kg' ? usd(v) : `${v}%`);
        console.log(
          `      ${c.servicio}/${c.tipo} zona ${c.zona} · de ${desde} a ${hasta} kg: ` +
            `${val(c.antes)} → ${val(c.despues)}`
        );
      });
    }
  }

  // ── Los envíos reales que caen justo en un borde ──────────────────────────
  console.log('\n' + '─'.repeat(72));
  console.log('Envíos reales que pesan EXACTAMENTE un corte de tramo');
  console.log('─'.repeat(72));
  let enElBorde = 0;
  for (const p of plan) {
    const cortes = p.tramos.map((t) => t.min).filter((m) => m > 0);
    const envios = await db
      .prepare(
        `SELECT id, fecha, peso_facturable FROM envios
          WHERE cliente_id = ? AND peso_facturable IN (${cortes.map(() => '?').join(',')})`
      )
      .all(p.cliente.id, ...cortes);
    if (envios.length) {
      enElBorde += envios.length;
      console.log(`  ${p.cliente.nombre}: ${envios.length}`);
      envios.forEach((e) => console.log(`    envío ${e.id} · ${e.fecha} · ${e.peso_facturable} kg`));
    }
  }
  if (enElBorde === 0) console.log('  ninguno · el cambio de borde no afecta a ningún envío cargado');

  // ── Veredicto ─────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  if (cambiosDePrecio === 0) {
    console.log('LA MIGRACIÓN ES NEUTRA · no le cambia el precio a ningún cliente');
  } else {
    console.log(`ATENCIÓN · ${cambiosDePrecio} peso(s) cambian de precio. Leer el detalle de arriba.`);
  }
  console.log('═'.repeat(72));

  if (!APLICAR) {
    console.log('\nNo se tocó nada. Para aplicar:  node scripts/migrar-tramos.js --aplicar\n');
    await closeDb();
    process.exitCode = cambiosDePrecio === 0 ? 0 : 1;
    setTimeout(() => process.exit(cambiosDePrecio === 0 ? 0 : 1), 3000).unref();
    return;
  }

  // ── Aplicar ───────────────────────────────────────────────────────────────
  console.log('\nAplicando…');
  for (const p of plan) {
    if (p.propios) {
      await db.prepare('DELETE FROM cliente_tramos WHERE cliente_id = ?').run(p.cliente.id);
      for (const t of p.tramos) {
        await db
          .prepare('INSERT INTO cliente_tramos (cliente_id, peso_min, peso_max) VALUES (?, ?, ?)')
          .run(p.cliente.id, t.min, t.max);
      }
    }

    const rehacer = async (tabla, campo, viejas, nuevas) => {
      const ids = viejas.filter((f) => f.peso_min !== null).map((f) => f.id);
      if (ids.length) {
        await db.prepare(`DELETE FROM ${tabla} WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      }
      for (const f of nuevas) {
        if (f._intacta || f._huerfana) continue;
        await db
          .prepare(
            `INSERT OR REPLACE INTO ${tabla} (cliente_id, servicio, tipo, zona, peso_min, peso_max, ${campo})
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(p.cliente.id, f.servicio, f.tipo, f.zona, f.peso_min, f.peso_max, f[campo]);
      }
    };
    await rehacer('tarifa_kg_overrides', 'precio_kg', p.cliente.kg, p.nuevasKg);
    await rehacer('profit_overrides', 'profit_pct', p.cliente.pct, p.nuevasPct);

    console.log(`  ✓ ${p.cliente.nombre}`);
  }
  console.log('\nListo.\n');

  await closeDb();
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 3000).unref();
})().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
