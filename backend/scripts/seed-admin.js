const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const { initDb, getDb } = require('../src/db');
const bcrypt = require('bcryptjs');

async function main() {
  await initDb();
  const db = getDb();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pregunta = (q) => new Promise((res) => rl.question(q, res));

  const usuario = (await pregunta('Nombre de usuario: ')).trim();
  const password = (await pregunta('Contraseña: ')).trim();
  rl.close();

  if (!usuario || !password) {
    console.error('Usuario y contraseña son obligatorios.');
    process.exit(1);
  }

  const existing = await db.prepare('SELECT id FROM usuarios WHERE usuario = ? COLLATE NOCASE').get(usuario);
  if (existing) {
    console.log(`El usuario "${usuario}" ya existe. No se creó duplicado.`);
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 10);
  await db
    .prepare(
      `INSERT INTO usuarios (usuario, password_hash, rol, ver_dashboard, activo)
       VALUES (?, ?, 'admin', 1, 1)`
    )
    .run(usuario, hash);

  console.log(`Admin "${usuario}" creado exitosamente.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
