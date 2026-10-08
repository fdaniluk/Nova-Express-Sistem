#!/usr/bin/env node
// Prueba de la MyDHL API con las credenciales del .env (08/10/2026). Etapa 0 del plan DHL:
// un tracking real contra el entorno que diga DHL_API_ENTORNO (test por defecto).
//
//   cd backend && node scripts/dhl-api-prueba.js 5751412866
//
// Imprime lo que devuelve DHL ya normalizado (lo que usaría el semáforo) y, con --crudo,
// también la respuesta tal cual, para ver qué campos manda en el sandbox.
require('../src/config');
const dhl = require('../src/services/dhl.service');

(async () => {
  const guia = (process.argv[2] || '').trim();
  const crudo = process.argv.includes('--crudo');
  if (!dhl.hayCredenciales()) { console.error('Faltan DHL_API_KEY / DHL_API_SECRET en backend/.env'); process.exit(1); }
  if (!dhl.DHL_GUIA_REGEX.test(guia)) { console.error('Uso: node scripts/dhl-api-prueba.js <guía DHL de 10 dígitos> [--crudo]'); process.exit(1); }
  console.log(`Entorno: ${dhl.baseUrl()}`);
  try {
    if (crudo) {
      const key = process.env.DHL_API_KEY.trim(); const secret = process.env.DHL_API_SECRET.trim();
      const res = await fetch(`${dhl.baseUrl()}/shipments/${guia}/tracking?trackingView=all-checkpoints&levelOfDetail=all`, {
        headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, Accept: 'application/json', 'Message-Reference': require('crypto').randomUUID(), 'Message-Reference-Date': new Date().toUTCString() },
      });
      console.log(`HTTP ${res.status}`);
      console.log(await res.text());
    }
    const t = await dhl.getTrackingDHL(guia);
    console.log(JSON.stringify(t, null, 2));
    console.log(`\nSemáforo: ${dhl.semaforoDeEstadoDHL(t.tipo, t.estado)}`);
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
})();
