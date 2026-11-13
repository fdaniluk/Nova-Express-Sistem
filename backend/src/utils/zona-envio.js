// La ZONA que se muestra de un envío (Salidas, liquidaciones) — 13/11/2026.
//
// Pedido de Felipe: que se vea siempre la zona del SERVICIO con el que salió el envío (la
// de UPS si fue por UPS, la de DHL si fue por DHL), como en las cotizaciones. La zona se
// guarda en envios.zona al cargar el envío y era una etiqueta que podía quedar vieja: un
// envío cargado como DHL y pasado después a UPS seguía mostrando la zona de DHL (Cueros
// Santa Cruz a Polonia, liquidación #233: decía zona 4 y por UPS es zona 6), y los envíos
// creados desde una guía podían quedar sin zona.
//
// Es SOLO la etiqueta: el motor de precios resuelve la zona por país y courier en cada
// cálculo (la guardada es apenas un respaldo si el país no está en las tablas), así que
// corregirla no mueve ningún importe. Por eso se sincroniza aparte, después de guardar,
// sin pasar por la lógica de costos.

const { ZONAS_DHL, ZONAS_UPS, ZONAS_UPS_I, canonizarPais } = require('../services/calculos.service');

/** Zona del courier para ese país y dirección, o null si el país no está en la tabla. */
function zonaDelServicio(pais, courier, tipoEnvio) {
  const p = canonizarPais(pais) || String(pais || '').trim();
  if (!p) return null;
  const esImpo = /^impo/i.test(String(tipoEnvio || ''));
  const tabla = String(courier || '').toUpperCase() === 'DHL' ? ZONAS_DHL : (esImpo ? ZONAS_UPS_I : ZONAS_UPS);
  const z = tabla[p];
  return z != null ? Number(z) : null;
}

/**
 * Deja envios.zona igual a la zona del servicio. Si el país no resuelve (destino fuera de
 * las tablas, con zona puesta a mano), NO toca nada. Devuelve la zona nueva si cambió.
 */
async function sincronizarZona(db, envioId) {
  const e = await db.prepare('SELECT id, pais_destino, courier, tipo_envio, zona FROM envios WHERE id = ?').get(envioId);
  if (!e) return null;
  const z = zonaDelServicio(e.pais_destino, e.courier, e.tipo_envio);
  if (z == null || String(e.zona ?? '') === String(z)) return null;
  await db.prepare('UPDATE envios SET zona = ? WHERE id = ?').run(String(z), envioId);
  return z;
}

/** Corrección de arrastre: todos los envíos con la etiqueta vieja o vacía. Idempotente. */
async function sincronizarTodas(db) {
  const filas = await db.prepare('SELECT id, pais_destino, courier, tipo_envio, zona FROM envios').all();
  const cambios = [];
  for (const e of filas) {
    const z = zonaDelServicio(e.pais_destino, e.courier, e.tipo_envio);
    if (z == null || String(e.zona ?? '') === String(z)) continue;
    await db.prepare('UPDATE envios SET zona = ? WHERE id = ?').run(String(z), e.id);
    cambios.push({ id: e.id, antes: e.zona, ahora: z });
  }
  return cambios;
}

module.exports = { zonaDelServicio, sincronizarZona, sincronizarTodas };
