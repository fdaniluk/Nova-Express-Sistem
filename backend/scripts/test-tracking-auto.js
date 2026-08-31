#!/usr/bin/env node
/**
 * test-tracking-auto.js — el semáforo de Salidas que se pinta solo (31/08/2026).
 *
 * El riesgo de un tracking automático lo decía el backlog desde antes de que existiera:
 * "que falle en silencio y muestre estados viejos como frescos". Por eso acá no se
 * prueba solo que pinte bien — se prueba QUÉ NO TOCA (DHL, NO VOLÓ, lo viejo, lo ya
 * entregado) y que los errores queden A LA VISTA con su fecha, nunca tragados.
 *
 * UPS se reemplaza por un doble de prueba (obtenerTracking inyectado): la tanda corre
 * sin red y sin credenciales, en Windows igual que acá.
 *
 *   cd backend && node scripts/test-tracking-auto.js
 */

process.env.DB_PATH = process.env.DB_PATH_TEST || '/tmp/test_tracking_auto.db';

const { prepararDb } = require('./_base-test');
prepararDb(process.env.DB_PATH);

const { initDb } = require('../src/db');
const { refrescarSemaforo } = require('../src/services/tracking-auto.service');
const { semaforoDeEstado } = require('../src/services/ups.service');

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}

// Guías con forma UPS válida (1Z + 16 alfanuméricos)
const G = {
  manifest:  '1ZAAAA000000000001',
  transito:  '1ZAAAA000000000002',
  entregada: '1ZAAAA000000000003',
  falla:     '1ZAAAA000000000004',
  vieja:     '1ZAAAA000000000005',
  novolo:    '1ZAAAA000000000006',
  yaverde:   '1ZAAAA000000000007',
  multi:     '1ZAAAA000000000008',
  vacia:     '1ZAAAA000000000009',
};

// El doble de UPS: responde por guía, y anota a quiénes le preguntaron.
const consultadas = [];
async function upsFalso(guia) {
  consultadas.push(guia);
  switch (guia) {
    case G.manifest:  return { guia, tipo: 'M', estado: 'Shipper created a label, UPS has not received the package yet.', ubicacion: null };
    case G.transito:  return { guia, tipo: 'I', estado: 'Departed from facility', ubicacion: 'Louisville, KY, US' };
    case G.entregada: return { guia, tipo: 'D', estado: 'Delivered', ubicacion: 'Miami, FL, US' };
    case G.multi:     return { guia, tipo: 'I', estado: 'Arrived at facility', ubicacion: 'Koeln, DE' };
    case G.vacia:     return { guia, tipo: null, estado: null, ubicacion: null };
    case G.falla:     throw new Error('UPS tracking falló (404): TV1002 Invalid inquiry number');
    default:          throw new Error('el doble de UPS no esperaba la guía ' + guia);
  }
}

async function main() {
  const db = await initDb();

  console.log('\n1. El mapeo tipo→color, contra la tabla de tipos de UPS\n');
  check("M (manifest) → rojo: la etiqueta existe, nadie la escaneó", semaforoDeEstado('M') === 'rojo');
  check('MV también', semaforoDeEstado('MV') === 'rojo');
  check('I (en tránsito) → amarillo', semaforoDeEstado('I') === 'amarillo');
  check('P (pickup) y X (excepción) → amarillo', semaforoDeEstado('P') === 'amarillo' && semaforoDeEstado('X') === 'amarillo');
  check('D (delivered) → verde', semaforoDeEstado('D') === 'verde');
  check('sin tipo pero con descripción → amarillo (algo pasó)', semaforoDeEstado(null, 'In Transit') === 'amarillo');
  check('sin nada de nada → null (no tocar el semáforo)', semaforoDeEstado(null, null) === null);

  console.log('\n2. La pasada: a quién le pregunta y a quién NO\n');

  const cli = await db.prepare("INSERT INTO clientes (nombre, tipo_cobro) VALUES ('CLIENTE TEST', 'D')").run();
  const clienteId = cli.lastInsertRowid;
  const alta = async (guia, campos = {}) => {
    const r = await db.prepare(`
      INSERT INTO envios (cliente_id, courier, tipo_envio, fecha, numero_guia, pais_destino, peso_real, no_volo, tracking_estado)
      VALUES (?, ?, 'exportacion', ?, ?, 'Estados Unidos', 5, ?, ?)
    `).run(clienteId, campos.courier ?? 'UPS', campos.fecha ?? new Date().toISOString().slice(0, 10),
           guia, campos.no_volo ?? 0, campos.tracking_estado ?? null);
    return r.lastInsertRowid;
  };

  const idManifest  = await alta(G.manifest);
  const idTransito  = await alta(G.transito);
  const idEntregada = await alta(G.entregada);
  const idFalla     = await alta(G.falla);
  const idVacia     = await alta(G.vacia);
  const idDhl       = await alta('1234567890', { courier: 'DHL' });
  const idMala      = await alta('1Z-GUIA-MALA');
  const idVieja     = await alta(G.vieja, { fecha: '2026-05-01' });
  const idNoVolo    = await alta(G.novolo, { no_volo: 1 });
  const idYaVerde   = await alta(G.yaverde, { tracking_estado: 'verde' });
  const idMulti     = await alta(G.multi);
  // el multibulto tiene DOS filas de bulto, una marcada a mano en verde (la va a pisar UPS)
  await db.prepare(`INSERT INTO envio_bultos (envio_id, numero_bulto, largo, ancho, alto, peso_volumetrico, estado_caja)
                    VALUES (?, 1, 10, 10, 10, 0.2, 'verde'), (?, 2, 10, 10, 10, 0.2, NULL)`).run(idMulti, idMulti);

  const resumen = await refrescarSemaforo(db, { obtenerTracking: upsFalso, pausaMs: 0 });

  check('preguntó por las 6 guías UPS en curso', resumen.consultados === 6, JSON.stringify(resumen));
  check('a DHL no le preguntó nada', !consultadas.includes('1234567890'));
  check('al NO VOLÓ tampoco', !consultadas.includes(G.novolo));
  check('al de mayo (más de 45 días) tampoco', !consultadas.includes(G.vieja));
  check('al ya entregado tampoco: verde es terminal', !consultadas.includes(G.yaverde));
  check('la guía mal tipeada no gastó una llamada de API', !consultadas.includes('1Z-GUIA-MALA') && resumen.omitidos === 1);

  console.log('\n3. Lo que pintó\n');
  const envio = (id) => db.prepare('SELECT tracking_estado, tracking_detalle, tracking_fecha FROM envios WHERE id = ?').get(id);

  let e = await envio(idManifest);
  check('etiqueta sin escanear → rojo', e.tracking_estado === 'rojo', JSON.stringify(e));
  e = await envio(idTransito);
  check('en tránsito → amarillo', e.tracking_estado === 'amarillo');
  check('con el estado y la ubicación en palabras', /Departed.*Louisville/.test(e.tracking_detalle), e.tracking_detalle);
  check('y la fecha de consulta anotada', !!e.tracking_fecha);
  e = await envio(idEntregada);
  check('entregada → verde', e.tracking_estado === 'verde');

  console.log('\n4. GANA UPS SIEMPRE (decisión de Felipe): pisa lo manual\n');
  const bultos = await db.prepare('SELECT numero_bulto, estado_caja FROM envio_bultos WHERE envio_id = ? ORDER BY numero_bulto').all(idMulti);
  check('el bulto marcado verde a mano quedó amarillo (lo que dijo UPS)', bultos[0].estado_caja === 'amarillo', JSON.stringify(bultos));
  check('y el bulto sin estado también', bultos[1].estado_caja === 'amarillo');

  console.log('\n5. Los errores quedan A LA VISTA, nunca en silencio\n');
  e = await envio(idFalla);
  check('la guía que UPS rechazó no cambió de color', e.tracking_estado === null, JSON.stringify(e));
  check('pero el error quedó anotado en el detalle', /Error al rastrear/.test(e.tracking_detalle), e.tracking_detalle);
  check('con su fecha (se sabe CUÁNDO falló)', !!e.tracking_fecha);
  e = await envio(idMala);
  check('la guía sin formato UPS quedó explicada', /sin formato UPS/.test(e.tracking_detalle), e.tracking_detalle);
  e = await envio(idVacia);
  check('la respuesta vacía no pintó nada, pero dejó constancia', e.tracking_estado === null && /sin actividad/.test(e.tracking_detalle), JSON.stringify(e));
  check('el resumen cuenta el error', resumen.errores === 1 && resumen.pintados === 4, JSON.stringify(resumen));

  console.log('\n6. La segunda pasada no repite lo terminado\n');
  consultadas.length = 0;
  const resumen2 = await refrescarSemaforo(db, { obtenerTracking: upsFalso, pausaMs: 0 });
  check('la entregada ya no se consulta', !consultadas.includes(G.entregada), JSON.stringify(consultadas));
  check('las que siguen en curso sí (rojo, amarillo, la fallada y la vacía)', resumen2.consultados === 5, JSON.stringify(resumen2));

  console.log('\n7. El fallback del bulto único en el GET de Salidas\n');
  // El envío sin filas de bulto tiene que salir con el color del tracking en su bulto
  // sintético. Se prueba contra listarSalidas de verdad, no contra una copia.
  const { listarSalidas } = require('../src/routes/salidas.routes');
  if (typeof listarSalidas === 'function') {
    const lista = await listarSalidas({});
    const row = lista.find((r) => r.id === idTransito);
    check('el bulto sintético hereda el color del semáforo automático',
      row && row.bultos && row.bultos[0].estado_caja === 'amarillo',
      row ? JSON.stringify(row.bultos) : 'no vino el envío');
    const rowD = lista.find((r) => r.id === idDhl);
    check('el DHL sigue sin estado (rojo por lectura, como siempre)',
      rowD && rowD.bultos && rowD.bultos[0].estado_caja === null,
      rowD ? JSON.stringify(rowD.bultos) : 'no vino el envío');
    check('el envío lleva el detalle y la fecha para el tooltip',
      row.tracking_detalle != null && row.tracking_fecha != null);
  } else {
    check('listarSalidas exportada para poder probar el fallback', false, 'salidas.routes no exporta listarSalidas');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
