#!/usr/bin/env node
// Una sola vez (14/10/2026, pedido de Felipe): pisar total_cobrado de 24 envíos de septiembre
// que YA están liquidados con el valor del Excel de ventas. La API lo frena a propósito
// (frenos de plata); acá se hace directo en la base porque es solo para nutrir el Dashboard.
// Las liquidaciones confirmadas NO se tocan. Hacer backup antes.
const path = require('path');
const sqlite3 = require('sqlite3');
const DB = process.env.DB_PATH || path.join(__dirname, '..', 'database', 'nova.db');
// [id, guía, valor viejo esperado, valor nuevo]
const CAMBIOS = [
  [586, '1777758695', 760.33, 770.34], [585, '3155953080', 760.33, 770.34], [576, '2370479204', 417.37, 516.65],
  [573, '1Z327W096798487455', 403.44, 409.44], [571, '1Z327W096794051726', 144.27, 150.27], [554, '1Z327W096796791352', 236.79, 242.79],
  [529, '1Z327W096799091424', 320.26, 326.26], [528, '1Z327W096797565005', 338.37, 344.37], [527, '1Z327W096791690149', 242.05, 248.05],
  [513, '1Z327W096798606950', 219.22, 225.22], [509, '1Z327W096798507361', 459.48, 466.08], [499, '1Z327W096798710855', 286.16, 292.16],
  [498, '1Z327W096792348302', 522.47, 556.12], [494, '2654045973', 139.55, 189.35], [490, '1Z327W096797467120', 299.52, 443.09],
  [486, '1Z327W096796044972', 142.02, 148.02], [477, '7855775734', 224.08, 273.16], [473, '2761179293', 300.28, 477],
  [471, '1Z327W096790302524', 99.63, 105.63], [444, '1Z327W096797326335', 591.35, 633.5], [439, '1Z327W096797626627', 123.14, 151.24],
  [438, '1Z327W096797199447', 142.95, 148.95], [430, '3032852911', 392.31, 422.06], [413, '1Z327W096795918137', 1104.85, 1121.35],
];
const db = new sqlite3.Database(DB);
const get = (s, p) => new Promise((r, j) => db.get(s, p, (e, x) => (e ? j(e) : r(x))));
const run = (s, p) => new Promise((r, j) => db.run(s, p, function (e) { e ? j(e) : r(this.changes); }));
(async () => {
  let ok = 0, saltados = 0;
  for (const [id, guia, viejo, nuevo] of CAMBIOS) {
    const e = await get('SELECT id, numero_guia, total_cobrado, liquidado FROM envios WHERE id = ?', [id]);
    if (!e || String(e.numero_guia).trim() !== guia) { console.log(`✗ #${id} no es ${guia}: no se toca`); saltados++; continue; }
    if (Math.abs(Number(e.total_cobrado) - viejo) > 0.01) { console.log(`✗ #${id} ${guia}: tiene ${e.total_cobrado}, esperaba ${viejo}: no se toca`); saltados++; continue; }
    await run('UPDATE envios SET total_cobrado = ? WHERE id = ?', [nuevo, id]);
    console.log(`✓ #${id} ${guia}: ${viejo} → ${nuevo}`);
    ok++;
  }
  console.log(`\n${ok} cambiados · ${saltados} sin tocar`);
  db.close();
})().catch((e) => { console.error(e); process.exit(1); });
