#!/usr/bin/env node
/**
 * test-pantalla-venta-salidas.js — el envío SIN PESAR y el botón "Calcular venta",
 * en un navegador de verdad.
 *
 * El circuito lo cubre test-envio-sin-pesar.js por API. Esto controla lo otro: que la
 * oficina lo pueda hacer desde la pantalla.
 *
 * EL CASO (Kasdorf y parecidos): los envíos no pasan por el depósito. Se manda la guía, el
 * cliente la imprime y despacha, y los pesos reales llegan días después. El envío se carga
 * sin pesar y se completa desde Salidas.
 *
 * Lo que más importa acá: que "Recalcular" (costo) y "Calcular venta" (precio) sean dos
 * cosas distintas, y que el segundo NUNCA pise una venta ya cargada sin confirmar.
 *
 *   cd backend && node scripts/test-pantalla-venta-salidas.js
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.log('⚠ playwright no está instalado — se saltea (necesita navegador de verdad).');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepararDb, abrirSesion, esperarServidor } = require('./_base-test');

const PORT = process.env.PORT_TEST || 3973;
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DB_PATH_TEST || '/tmp/test_pantalla_venta_salidas.db';
const TOKEN = 'token-test-pantalla-venta';

let ok = 0, fail = 0;
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  prepararDb(DB);
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOut = '', logErr = '';
  srv.stdout.on('data', (d) => { logOut += d; });
  srv.stderr.on('data', (d) => { logErr += d; process.stderr.write('[server] ' + d); });
  let srvMuerto = false;
  const matarSrv = () => { if (srvMuerto) return; srvMuerto = true; try { srv.kill(); } catch {} };
  process.on('exit', matarSrv);
  const esperarSrvMuerto = () => new Promise((res) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return res();
    srv.once('exit', res);
    setTimeout(res, 2000);
  });

  // Espera la línea de "listo" que imprime NUESTRO servidor (no un /api/health que puede
  // contestar otro node vivo en el puerto), hasta 60 s: en Windows el primer arranque de
  // node del día tarda y con 12 s el test reventaba con un ECONNREFUSED que parecía del
  // cortafuegos. Ver scripts/_base-test.js.
  await esperarServidor(srv, BASE, () => logErr, () => logOut);
  await abrirSesion(DB, TOKEN);
  const H = { 'Content-Type': 'application/json', Cookie: `nova_session=${TOKEN}` };
  const hoy = new Date().toISOString().slice(0, 10);

  const cli = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nombre: 'KASDORF PANTALLA', tarifa_pct: 75 }),
  })).json();

  // El envío del lunes: sin pesos ni medidas.
  const env = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000PANT000000001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
    }),
  })).json();

  console.log('\n1. El envío sin pesar\n');
  check('el alta sin peso lo acepta', !!env.id, JSON.stringify(env).slice(0, 100));
  check('no le inventa costo', env.flete === null, `flete=${env.flete}`);

  // Igual que en el resto de las tandas de pantalla: si el chromium de Playwright no
  // esta donde el paquete lo espera, se usa el que haya. Sin esto la tanda no corre en
  // el contenedor, que es justamente donde se verifica antes de entregar.
  const cand = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  const exe = cand.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: 'nova_session', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/jsdelivr|ERR_TUNNEL|Failed to load resource/.test(m.text())) {
      errores.push(m.text());
    }
  });

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  const grilla = await page.textContent('body');
  check('la grilla lo marca como "sin pesar"', /sin pesar/.test(grilla));
  check('y la celda queda resaltada', (await page.$$('td.cell-sin-pesar')).length > 0);

  console.log('\n2. El jueves: llegan los pesos\n');

  await page.click('text=1Z000PANT000000001');
  await esperar(1000);
  check('se abre el modal', !!(await page.$('#sal-edit-overlay:not(.hidden)')));
  check('está el botón Calcular venta', !!(await page.$('#saled-calcular-venta')));

  await page.fill('#saled-peso-real', '12');
  await page.fill('#saled-largo', '40');
  await page.fill('#saled-ancho', '30');
  await page.fill('#saled-alto', '30');

  console.log('\n3. Calcular venta usa el profit del cliente\n');

  await page.click('#saled-calcular-venta');
  await esperar(3500);
  const panelVisible = await page.$eval('#saled-venta-panel',
    (e) => !e.classList.contains('hidden')).catch(() => false);
  check('aparece el panel del precio sugerido', panelVisible);
  const panel = panelVisible ? await page.textContent('#saled-venta-panel') : '';
  check('dice el profit del cliente (75%)', /75%/.test(panel), panel.slice(0, 160));
  check('dice de dónde salió el margen', /matriz|cliente|zona|tabla|banda/.test(panel),
    panel.slice(0, 160));
  check('muestra el precio de venta sugerido', /Precio de venta sugerido/.test(panel));
  check('sin venta previa el botón dice "Usar este precio"', /Usar este precio/.test(panel));

  await page.click('#saled-venta-aplicar');
  await esperar(900);
  const total = await page.inputValue('#saled-total');
  const flete = await page.inputValue('#saled-flete');
  const profit = await page.inputValue('#saled-profit');
  check('el total se completa solo', Number(total) > 0, `total=${total}`);
  check('el costo también quedó cargado', Number(flete) > 0, `flete=${flete}`);
  check('la utilidad se deriva sola', Number(profit) > 0, `profit=${profit}`);
  check('la venta es mayor que el costo', Number(total) > Number(flete));

  console.log('\n4. No pisa una venta ya cargada sin confirmar\n');

  await page.click('#saled-calcular-venta');
  await esperar(3500);
  const panel2 = await page.textContent('#saled-venta-panel');
  check('avisa que el envío ya tiene venta', /ya tiene una venta cargada/.test(panel2),
    panel2.slice(0, 200));
  check('el botón pasa a decir "Reemplazar"', /Reemplazar/.test(panel2));
  check('muestra la diferencia contra lo cargado', /Diferencia/.test(panel2));
  await page.click('#saled-venta-descartar');
  await esperar(500);
  check('"Dejar como está" no toca el total',
    (await page.inputValue('#saled-total')) === total);

  console.log('\n5. Recalcular es el COSTO, no el precio\n');

  await page.click('#saled-recalcular');
  await esperar(2500);
  check('Recalcular NO toca el total cobrado',
    (await page.inputValue('#saled-total')) === total,
    `antes ${total} · después ${await page.inputValue('#saled-total')}`);
  check('pero sí repuebla el costo', Number(await page.inputValue('#saled-flete')) > 0);

  await page.click('#sal-modal-save');
  await esperar(2500);
  const g = await (await fetch(`${BASE}/api/envios/${env.id}`, { headers: H })).json();
  check('la venta queda guardada en la base', Number(g.total_cobrado) > 0, `total=${g.total_cobrado}`);
  check('el costo queda guardado', Number(g.flete) > 0, `flete=${g.flete}`);
  check('el peso facturable quedó en 12', Number(g.peso_facturable) === 12, `pf=${g.peso_facturable}`);

  console.log('\n6. Sirve para los envíos viejos sin precio\n');

  // El caso inverso: envío CON peso pero sin venta, porque se cargó antes de que el cliente
  // tuviera matriz. Se le carga la matriz después y el botón la tiene que tomar.
  const cli2 = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'VIEJO SIN MATRIZ', tarifa_pct: 0 }),
  })).json();
  const viejo = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli2.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000INVE000000001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      peso_real: 8, bultos: [{ peso_real: 8, largo: 35, ancho: 25, alto: 25 }],
    }),
  })).json();
  check('el envío viejo tiene costo pero la venta en 0',
    Number(viejo.flete) > 0 && Number(viejo.total_cobrado) === 0);

  await fetch(`${BASE}/api/clientes/${cli2.id}/profit-matrix`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ servicio: 'UPS_EXP', tipo: 'export', zona: null, peso_min: 5, peso_max: 10, profit_pct: 85 }),
  });

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=1Z000INVE000000001');
  await esperar(1000);
  await page.click('#saled-calcular-venta');
  await esperar(3500);
  const panel3 = await page.textContent('#saled-venta-panel');
  check('anda directo, sin tener que recalcular antes',
    /Precio de venta sugerido/.test(panel3));
  check('toma el profit cargado DESPUÉS del envío (85%)', /85%/.test(panel3),
    panel3.slice(0, 170));
  check('no avisa de pisar nada, porque la venta estaba en 0',
    !/ya tiene una venta cargada/.test(panel3));

  console.log('\n7. Recalcular avisa cuando el precio queda viejo\n');

  // EL CASO QUE ENCONTRO LA OFICINA (07/08/2026). Un envio cargado con su precio, al que
  // despues le cambian el peso: Recalcular actualiza el COSTO y el precio de venta queda
  // calculado para el peso anterior. Antes eso se guardaba en silencio y se facturaba mal
  // (5 kg pasados a 50 kg seguian cobrando el precio de 5 kg: USD 372 de menos).
  const cli3 = await (await fetch(BASE + '/api/clientes', {
    method: 'POST', headers: H, body: JSON.stringify({ nombre: 'AVISO DESFASE', tarifa_pct: 80 }),
  })).json();
  const chico = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli3.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000DESFASE00001', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      peso_real: 5, largo: 30, ancho: 25, alto: 20, total_cobrado: 120,
    }),
  })).json();
  check('el envio arranca con su precio cargado', Number(chico.total_cobrado) === 120);

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  await page.click('text=1Z000DESFASE00001');
  await esperar(1000);
  check('sin tocar nada NO hay aviso',
    await page.$eval('#saled-venta-aviso', (e) => e.classList.contains('hidden')));

  // Le cambian el peso de 5 a 50 kg y recalculan, que es lo que hicieron en la oficina.
  await page.fill('#saled-peso-real', '50');
  await page.fill('#saled-largo', '60');
  await page.fill('#saled-ancho', '50');
  await page.fill('#saled-alto', '40');
  await page.click('#saled-recalcular');
  await esperar(4000);

  const avisoVisible = await page.$eval('#saled-venta-aviso',
    (e) => !e.classList.contains('hidden'));
  check('al recalcular con otro peso, AVISA que el precio quedo viejo', avisoVisible);
  const textoAviso = avisoVisible ? await page.textContent('#saled-venta-aviso') : '';
  check('dice cuanto tiene cargado y cuanto deberia ser',
    /120/.test(textoAviso) && /deberia|seria/i.test(textoAviso), textoAviso.slice(0, 180));
  check('y dice cuanta plata es la diferencia', /US\$/.test(textoAviso), textoAviso.slice(0, 120));
  check('y dice que hay que tocar Calcular venta', /Calcular venta/.test(textoAviso));

  // Al aplicar el precio sugerido el aviso tiene que irse solo.
  await page.click('#saled-calcular-venta');
  await esperar(3500);
  await page.click('#saled-venta-aplicar');
  await esperar(1200);
  check('al usar el precio sugerido, el aviso desaparece',
    await page.$eval('#saled-venta-aviso', (e) => e.classList.contains('hidden')));
  const totalNuevo = Number(await page.inputValue('#saled-total'));
  check('y el precio quedo actualizado al peso nuevo', totalNuevo > 120, `total=${totalNuevo}`);

  console.log('\n8. El precio de la PANTALLA contra el del cotizador\n');

  // ESTE ES EL CHEQUEO QUE FALTABA. Los tests de API comparaban pedidos armados A MANO, asi
  // que probaban el servidor pero no lo que la pantalla realmente manda. Y lo que mandaba
  // estaba mal: leia `editEnvio.fob` y `editEnvio.tipo_envio`, y la fila de la grilla no
  // tiene esos nombres (el fob viaja como `valor_declarado` y el tipo_envio no viaja).
  // `undefined || 0` es 0, asi que:
  //   · fob 0      -> sin SEGURO: USD 15 de menos en cada envio con valor declarado.
  //   · sin tipo   -> toda importacion cotizada con la tarifa de EXPORTACION.
  // Los dos pasaron todos los tests de API. Solo se ven manejando la pantalla de verdad.
  const casos = [
    { nombre: 'con valor declarado (tiene que cobrar seguro)',
      guia: '1Z000PANTFOB00001', tipo_envio: 'exportacion', fob: 500, pais: 'Estados Unidos' },
    { nombre: 'importacion (no puede cotizar como exportacion)',
      guia: '1Z000PANTIMP00001', tipo_envio: 'importacion', fob: 300, pais: 'China' },
  ];

  for (const caso of casos) {
    const e = await (await fetch(BASE + '/api/envios', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: caso.tipo_envio,
        numero_guia: caso.guia, pais_destino: caso.pais, servicio_ups: 'UPS_EXP',
        peso_real: 16, largo: 24, ancho: 24, alto: 24, fob: caso.fob,
      }),
    })).json();

    // Lo que TIENE que dar, pedido al servidor con los datos del envio bien puestos.
    const esperadoResp = await (await fetch(BASE + '/api/liquidaciones/cotizar', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        envio_id: e.id, pesoFacturable: 16, profitManual: false,
      }),
    })).json();
    const esperado = Number(esperadoResp.precioFinal);

    await page.goto(`${BASE}/pages/salidas.html`);
    await esperar(3000);
    await page.click(`text=${caso.guia}`);
    await esperar(1000);
    await page.click('#saled-calcular-venta');
    await esperar(3500);
    const panel = await page.textContent('#saled-venta-panel');
    const m = /Precio de venta sugerido[^0-9]*([0-9.,]+)/.exec(panel.replace(/\s+/g, ' '));
    const enPantalla = m ? Number(m[1].replace(/,/g, '')) : NaN;

    check(`${caso.nombre}: la pantalla dice lo mismo que el cotizador`,
      Math.abs(enPantalla - esperado) < 0.02,
      `pantalla ${enPantalla} · cotizador ${esperado}`);
    check(`${caso.nombre}: el seguro esta contemplado`,
      /Costo con fuel/.test(panel) && enPantalla > 0, panel.slice(0, 120));
  }

  // Y que el envio con valor declarado efectivamente cobre seguro: si el fob se perdiera
  // otra vez, el costo bajaria justo el importe del seguro y este check lo agarra.
  const conFob = await (await fetch(`${BASE}/api/liquidaciones/cotizar`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP',
      pesoFacturable: 16, fob: 500, fuelPct: 36.5, profitPct: 0, profitManual: true,
      bultos: [{ peso_real: 16, largo: 24, ancho: 24, alto: 24 }] }),
  })).json();
  const sinFob = await (await fetch(`${BASE}/api/liquidaciones/cotizar`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ pais: 'Estados Unidos', tipo: 'export', servicio: 'UPS_EXP',
      pesoFacturable: 16, fob: 0, fuelPct: 36.5, profitPct: 0, profitManual: true,
      bultos: [{ peso_real: 16, largo: 24, ancho: 24, alto: 24 }] }),
  })).json();
  check('perder el valor declarado costaria exactamente el seguro (USD 15)',
    Math.abs((conFob.precioFinal - sinFob.precioFinal) - 15) < 0.02,
    `con fob ${conFob.precioFinal} · sin fob ${sinFob.precioFinal}`);

  // ── La doble vista del profit (31/08, pedido de la oficina) ────────────────
  //
  // Antes la columna Profit cambiaba de fórmula SOLA al aprobar la revisión (pasaba del
  // estimado al real) y la oficina lo leía como "me sobrescribió el profit". Ahora:
  // Profit/% y Compra Total muestran SIEMPRE la estimación nuestra, y el real contra la
  // factura de UPS tiene su columna propia (Profit Real), visible desde que la factura
  // se cruza y sin esperar el tilde.
  console.log('\n9. La doble vista: profit estimado y profit real, cada uno en su columna\n');

  // Un envío con venta y desglose conocidos + la "factura de UPS" puesta por SQL.
  const dv = await (await fetch(BASE + '/api/envios', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      cliente_id: cli.id, fecha: hoy, courier: 'UPS', tipo_envio: 'exportacion',
      numero_guia: '1Z000DOBLEVISTA01', pais_destino: 'Estados Unidos', servicio_ups: 'UPS_EXP',
      peso_real: 10, largo: 30, ancho: 30, alto: 30, fob: 0,
      total_cobrado: 300, flete: 150, seguro: 0, fuel: 50, adicionales: 0, otros: 0,
    }),
  })).json();
  // Compra estimada 200 → profit estimado 100. UPS facturó 160 → profit real 140.
  const sqlite3dv = require('sqlite3');
  const dbdv = new sqlite3dv.Database(DB);
  const sqldv = (q, pr = []) => new Promise((res, rej) => dbdv.run(q, pr, (er) => (er ? rej(er) : res())));
  await sqldv("UPDATE envios SET costo_facturado = 160, peso_facturado = 11, courier_facturado = 'UPS', fecha_facturado = ?, estado_revision = 'pendiente' WHERE id = ?", [hoy, dv.id]);

  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  const filaDV = () => page.evaluate((id) => {
    const tr = document.querySelector(`#salidas-body tr[data-envio-id="${id}"]`);
    if (!tr) return null;
    const celda = (col) => tr.querySelector(`td[data-col="${col}"]`)?.textContent.trim();
    return {
      compra: celda('compra_total'), profit: celda('profit'), pct: celda('porcentaje'),
      costoUps: celda('costo_ups'), profitReal: celda('profit_real'),
      titleReal: tr.querySelector('td[data-col="profit_real"] span')?.title || '',
    };
  }, dv.id);

  // OJO: al crear el envío, el backend congela el desglose AL COSTO con el motor (no
  // toma el flete/fuel del POST), así que la compra estimada no es un número elegido por
  // el test. Lo que se afirma es la RELACIÓN: estimado = venta − compra estimada, real =
  // venta − costo UPS, y que el estimado no se mueva al aprobar.
  const num = (t) => Number(String(t || '').replace(/[^0-9.-]/g, ''));
  let f = await filaDV();
  check('la columna Profit muestra el ESTIMADO (venta − Compra Total, al centavo)',
    f && Math.abs((num(f.compra) + num(f.profit)) - 300) < 0.02, JSON.stringify(f));
  check('Profit Real muestra el real (300 − 160 = 140) SIN esperar el tilde', f && num(f.profitReal) === 140, f && f.profitReal);
  check('y son DOS números distintos, cada uno en su columna', f && Math.abs(num(f.profit) - num(f.profitReal)) > 1,
    f && `${f.profit} vs ${f.profitReal}`);
  check('el tooltip del real avisa que la factura aún no está aprobada', /no está aprobada/.test(f.titleReal), f.titleReal);
  const estimadoAntes = num(f.profit);
  const compraAntes = num(f.compra);

  // Se aprueba la revisión: el estimado NO se mueve (antes acá se "sobrescribía").
  await sqldv("UPDATE envios SET estado_revision = 'revisado_ok' WHERE id = ?", [dv.id]);
  await new Promise((res) => dbdv.close(() => res()));
  await page.goto(`${BASE}/pages/salidas.html`);
  await esperar(3000);
  f = await filaDV();
  check('aprobada la revisión, Profit SIGUE mostrando el mismo estimado (no se "sobrescribe")',
    f && num(f.profit) === estimadoAntes, f && `${f.profit} vs ${estimadoAntes}`);
  check('Compra Total sigue en la estimación, no salta al costo real (160)',
    f && num(f.compra) === compraAntes && num(f.compra) !== 160, f && f.compra);
  check('y Profit Real sigue en 140, ahora sin la advertencia',
    f && num(f.profitReal) === 140 && !/no está aprobada/.test(f.titleReal), f && f.titleReal);

  console.log('\n10. Sin errores de JavaScript\n');
  check('ningún error en la pantalla', errores.length === 0, errores.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(60));
  console.log(`${ok} pasaron · ${fail} fallaron`);
  await browser.close();
  matarSrv();
  await esperarSrvMuerto();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 3000).unref();
}

main().catch((e) => { console.error('✗ Error inesperado:', e); process.exit(1); });
