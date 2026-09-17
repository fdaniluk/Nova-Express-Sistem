#!/usr/bin/env node
/**
 * _capturas-clientes.js — capturas de Clientes y del perfil para mostrarle el rediseño a
 * Felipe (17/09/2026). NO es una tanda: no verifica nada, solo saca fotos.
 *   cd backend && node scripts/_capturas-clientes.js      → backend/_capturas/
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('playwright no esta instalado'); process.exit(0); }

const PORT = 3936;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(require('os').tmpdir(), 'nova-capturas-clientes.db');
const TOKEN = 'tok-capturas-clientes';
const SALIDA = path.join(__dirname, '..', '_capturas');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; });
  process.on('exit', () => { try { srv.kill(); } catch {} });
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const J = async (m, u, b) => (await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();
  const hoy = new Date(); const dia = (n) => iso(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n));

  const a = await J('POST', '/api/clientes', { razon_social: 'ASAPLAST S.R.L.', nombre_nova: 'ASAPLAST', tarifa_pct: 75, tipo_cobro: 'S', cuit: '30-71234567-8', contacto: 'Marcela Ríos', whatsapp: '+54 9 11 5555-1234', email: 'marcela@asaplast.com.ar', direccion_recoleccion: 'Av. Mitre 2450, Munro', localidad: 'Munro', provincia: 'Buenos Aires', codigo_postal: '1605', telefono: '+54 11 4756-1234', plazo_pago_dias: 15 });
  const b = await J('POST', '/api/clientes', { razon_social: 'CUEROS SANTA CRUZ S.A.', nombre_nova: 'CUEROS SANTA CRUZ', tarifa_pct: 0, tipo_cobro: 'CC', cuit: '30-65432109-1', contacto: 'Jorge Battaglia', whatsapp: '+54 9 11 4444-9876', localidad: 'San Martín' });
  const c = await J('POST', '/api/clientes', { razon_social: 'NUMANA INDUMENTARIA S.A.S.', nombre_nova: 'NUMANA', tarifa_pct: 0, tipo_cobro: 'D', contacto: 'Lucía Ferreyra', whatsapp: '+54 9 11 3333-2211', localidad: 'CABA' });
  await J('POST', '/api/clientes', { razon_social: 'GIANNASTACIO HNOS', tarifa_pct: 80, tipo_cobro: 'Q', cuit: '30-55555555-5', localidad: 'Pilar' });
  await J('PUT', `/api/clientes/${a.id}/profit-matrix`, { servicio: 'DHL', tipo: 'export', zona: 2, profit_pct: 60 });
  await J('PUT', `/api/clientes/${a.id}/profit-matrix`, { servicio: 'DHL', tipo: 'export', profit_pct: 70 });
  await J('PUT', `/api/clientes/${b.id}`, { modo_tarifa: 'por_kg' });
  await J('PUT', `/api/clientes/${b.id}/tarifa-kg`, { servicio: 'UPS_EXP', tipo: 'export', zona: 3, precio_kg: 5 });
  await J('POST', `/api/clientes/${a.id}/direcciones`, { direccion: 'Depósito Ruta 8 km 32, Pilar' });
  const alta = (cid, g, f, courier, pais, kg, tot, fob) => J('POST', '/api/envios', { cliente_id: cid, fecha: f, courier, tipo_envio: 'exportacion', servicio_ups: courier === 'UPS' ? 'UPS_EXP' : undefined, numero_guia: g, pais_destino: pais, peso_real: kg, largo: 40, ancho: 30, alto: 25, fob, total_cobrado: tot });
  await alta(a.id, '1Z327W090491234567', dia(30), 'UPS', 'Estados Unidos', 12.5, 236.4, 500);
  await alta(a.id, '1Z327W090491234580', dia(6), 'UPS', 'Chile', 4, 118.2, 250);
  await alta(a.id, '4412345678', dia(2), 'DHL', 'España', 22, 402.7, 1200);
  const pend = await J('GET', `/api/liquidaciones/pendientes?cliente_id=${a.id}`);
  const primero = pend[0].envios.find((e) => e.numero_guia === '1Z327W090491234567');
  await J('POST', '/api/liquidaciones', { cliente_id: a.id, periodo_desde: dia(40), periodo_hasta: dia(20), envio_ids: [primero.id], cargos: [], cotizaciones: [], confirmar: true });

  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = []; page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto(BASE + '/pages/clientes.html'); await page.waitForSelector('#tabla-clientes tr[data-cliente-id]'); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SALIDA, 'clientes-1-lista.png'), fullPage: true });
  await page.click('#btn-nuevo'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SALIDA, 'clientes-2-alta.png'), fullPage: true });
  await page.goto(BASE + `/pages/clientes-perfil.html?id=${a.id}`); await page.waitForSelector('#libretas-lista li'); await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SALIDA, 'clientes-3-perfil.png'), fullPage: true });
  await page.click('#btn-editar-tarifas'); await page.waitForSelector('#tarifas-grid table'); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SALIDA, 'clientes-4-perfil-tarifas.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/pages/clientes.html'); await page.waitForSelector('#tabla-clientes tr[data-cliente-id]'); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SALIDA, 'clientes-5-telefono-lista.png'), fullPage: true });
  await page.goto(BASE + `/pages/clientes-perfil.html?id=${a.id}`); await page.waitForSelector('#libretas-lista li'); await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SALIDA, 'clientes-6-telefono-perfil.png'), fullPage: true });
  console.log(errores.length ? 'ERRORES JS: ' + errores.join(' | ') : 'sin errores de JS');
  await browser.close(); srv.kill();
})();
