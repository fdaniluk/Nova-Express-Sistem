#!/usr/bin/env node
// Capturas del dashboard con una base de demo (para el manual de uso). No es una tanda.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = 3975; const BASE = `http://localhost:${PORT}`;
const DB = '/tmp/demo_dashboard.db'; const TOKEN = 'token-demo-dash';
const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
const OUT = '/tmp/manual-dash'; fs.mkdirSync(OUT, { recursive: true });
function sql(q, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.all(q, p, (e, r) => { d.close(() => (e ? rej(e) : res(r || []))); }); }); }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

async function main() {
  prepararDb(DB, { desdeProduccion: false });
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logOut = ''; let logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; }); srv.stderr.on('data', (d) => { logErr += d; });
  process.on('exit', () => { try { srv.kill(); } catch { /* */ } });
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  const uid = await abrirSesion(DB, TOKEN);
  await sql('UPDATE usuarios SET ver_dashboard = 1 WHERE id = ?', [uid]);
  await sql('INSERT INTO configuracion_nova (id, fuel_pct, margen_objetivo_pct) VALUES (1, 36, 45) ON CONFLICT(id) DO UPDATE SET fuel_pct = 36, margen_objetivo_pct = 45');
  await sql('DELETE FROM envios');

  const nombres = ['Laboratorio Andes', 'Textil del Sur', 'Bodega Altamira', 'Cueros Pampa', 'Insumos Médicos SA', 'Editorial Faro', 'Agro Semillas', 'Diseño Punto', 'Herrajes Norte', 'Cosmética Luna', 'Vinos Mendoza', 'Repuestos Ruta 8'];
  const clientes = [];
  for (const n of nombres) clientes.push(await (await fetch(`${BASE}/api/clientes`, { method: 'POST', headers: H, body: JSON.stringify({ nombre: n, tarifa_pct: 80 }) })).json());
  const paises = ['Estados Unidos', 'Estados Unidos', 'Estados Unidos', 'España', 'Chile', 'Brasil', 'Alemania', 'México', 'Uruguay', 'Italia', 'China', 'Reino Unido'];
  const hoy = new Date();
  let n = 1;
  for (let m = 13; m >= 0; m--) {
    const cant = 9 + Math.floor(rnd() * 9) + (m < 3 ? 4 : 0);
    for (let i = 0; i < cant; i++) {
      const f = new Date(hoy.getFullYear(), hoy.getMonth() - m, 1 + Math.floor(rnd() * 27));
      if (f > hoy) continue;
      const fecha = f.toISOString().slice(0, 10);
      const ci = Math.floor(rnd() * rnd() * clientes.length);
      const cli = clientes[ci];
      const peso = Math.round((0.5 + rnd() * rnd() * 40) * 10) / 10;
      const courier = rnd() < 0.62 ? 'UPS' : 'DHL';
      const tipo = rnd() < 0.85 ? 'exportacion' : 'importacion';
      const total = Math.round((60 + peso * (18 + rnd() * 14)) * 100) / 100;
      const e = await (await fetch(`${BASE}/api/envios`, { method: 'POST', headers: H, body: JSON.stringify({ fecha, courier, tipo_envio: tipo, pais_destino: pick(paises), peso_real: peso, largo: 40, ancho: 30, alto: 20, cliente_id: cli.id, numero_guia: `1Z99${String(n++).padStart(6, '0')}`, total_cobrado: total }) })).json();
      if (!e || !e.id) continue;
      // meses cerrados (más de 1 mes atrás): factura cruzada en ~85 % de las guías
      if (m >= 2 && rnd() < 0.85) {
        const compra = total * (0.55 + rnd() * 0.12);
        await sql("UPDATE envios SET costo_facturado = ?, peso_facturado = ?, estado_revision = 'revisado_ok', fecha_facturado = ? WHERE id = ?", [Math.round(compra * 100) / 100, Math.round(peso * (0.95 + rnd() * 0.15) * 10) / 10, fecha, e.id]);
      }
      if (rnd() < 0.03) await sql('UPDATE envios SET no_volo = 1 WHERE id = ?', [e.id]);
    }
  }
  console.log('envíos:', (await sql('SELECT COUNT(*) c FROM envios'))[0].c);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/index.html`);
  await page.waitForFunction(() => /→/.test(document.querySelector('#dash-hint')?.textContent || ''));
  // Últimos 12 meses para que los gráficos tengan cuerpo
  const btn12 = await page.$('button[data-periodo="12m"]');
  if (btn12) { await btn12.click(); await esperar(1500); }
  await esperar(800);
  await page.screenshot({ path: `${OUT}/completo.png`, fullPage: true });
  const shot = async (sel, name, pad = 0) => {
    const el = await page.$(sel); if (!el) { console.log('no encontré', sel); return; }
    await el.scrollIntoViewIfNeeded(); await esperar(300);
    const b = await el.boundingBox();
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2 } });
  };
  await shot('.page-header.dash-header', 'filtros');
  await shot('.dash-kpis', 'kpis');
  const cards = await page.$$('.card.dash-card');
  console.log('tarjetas', cards.length);
  for (let i = 0; i < cards.length; i++) {
    const t = ((await cards[i].$eval('h2', (h) => h.childNodes[0].textContent)) || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await cards[i].scrollIntoViewIfNeeded(); await esperar(400);
    await cards[i].screenshot({ path: `${OUT}/card-${i}-${t}.png` });
  }
  await browser.close();
  srv.kill();
}
main().catch((e) => { console.error(e); process.exit(1); });
