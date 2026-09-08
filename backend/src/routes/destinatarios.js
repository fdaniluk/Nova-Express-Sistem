// Libreta de destinatarios por cliente (guías, etapa 1 — 08/09/2026).
//
// Lo que hoy la oficina tipea cada vez en la página de UPS y en la proforma, guardado una
// vez por cliente. Montado en /api/clientes/:id/destinatarios. Se borra en blando (activo=0)
// porque un envío ya emitido puede apuntar al destinatario: la libreta lo esconde, la
// proforma y la guía lo siguen viendo.
const { Router } = require('express');
const { getDb } = require('../db');

const router = Router({ mergeParams: true });

const CAMPOS = [
  'nombre', 'contacto', 'direccion1', 'direccion2', 'direccion3',
  'codigo_postal', 'ciudad', 'estado', 'pais', 'telefono', 'email', 'tax_id',
];

function limpiar(body) {
  const out = {};
  for (const c of CAMPOS) {
    if (body[c] === undefined) continue;
    const v = String(body[c] ?? '').trim();
    out[c] = v || null;
  }
  return out;
}

function validar(d, parcial) {
  if (!parcial || d.nombre !== undefined) {
    if (!d.nombre) return 'El nombre del destinatario es obligatorio';
  }
  if (!parcial || d.pais !== undefined) {
    if (!d.pais) return 'El país del destinatario es obligatorio';
  }
  return null;
}

async function clienteExiste(db, id) {
  return Boolean(await db.prepare('SELECT id FROM clientes WHERE id = ?').get(id));
}

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    if (!(await clienteExiste(db, req.params.id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const todos = req.query.todos === '1';
    const rows = await db
      .prepare(
        `SELECT * FROM destinatarios
         WHERE cliente_id = ? ${todos ? '' : 'AND activo = 1'}
         ORDER BY ultimo_uso DESC, nombre COLLATE NOCASE`
      )
      .all(req.params.id);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const db = getDb();
    if (!(await clienteExiste(db, req.params.id))) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const d = limpiar(req.body || {});
    const err = validar(d, false);
    if (err) return res.status(400).json({ error: err });
    const cols = CAMPOS.filter((c) => d[c] !== undefined);
    const result = await db
      .prepare(
        `INSERT INTO destinatarios (cliente_id, ${cols.join(', ')})
         VALUES (?, ${cols.map(() => '?').join(', ')})`
      )
      .run(req.params.id, ...cols.map((c) => d[c]));
    const creado = await db.prepare('SELECT * FROM destinatarios WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(creado);
  } catch (e) {
    next(e);
  }
});

async function buscarDelCliente(db, clienteId, destId) {
  return db
    .prepare('SELECT * FROM destinatarios WHERE id = ? AND cliente_id = ?')
    .get(destId, clienteId);
}

router.put('/:destId', async (req, res, next) => {
  try {
    const db = getDb();
    const actual = await buscarDelCliente(db, req.params.id, req.params.destId);
    if (!actual) return res.status(404).json({ error: 'Destinatario no encontrado' });
    const d = limpiar(req.body || {});
    const err = validar(d, true);
    if (err) return res.status(400).json({ error: err });
    const cols = CAMPOS.filter((c) => d[c] !== undefined);
    if (req.body.activo !== undefined) {
      cols.push('activo');
      d.activo = req.body.activo ? 1 : 0;
    }
    if (!cols.length) return res.json(actual);
    await db
      .prepare(`UPDATE destinatarios SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => d[c]), actual.id);
    res.json(await db.prepare('SELECT * FROM destinatarios WHERE id = ?').get(actual.id));
  } catch (e) {
    next(e);
  }
});

router.delete('/:destId', async (req, res, next) => {
  try {
    const db = getDb();
    const actual = await buscarDelCliente(db, req.params.id, req.params.destId);
    if (!actual) return res.status(404).json({ error: 'Destinatario no encontrado' });
    await db.prepare('UPDATE destinatarios SET activo = 0 WHERE id = ?').run(actual.id);
    res.json({ ok: true, id: actual.id });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
