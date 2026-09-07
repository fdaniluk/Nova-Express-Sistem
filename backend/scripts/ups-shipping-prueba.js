#!/usr/bin/env node
/**
 * ups-shipping-prueba.js — ETAPA 0 de las guías automáticas (GUIAS-UPS.md, 07/09/2026).
 *
 * Crea UNA guía de prueba contra el ENTORNO DE TEST de UPS (wwwcie.ups.com): no genera
 * cargos ni una guía real. Sirve para confirmar que la app "Nova Express Tracking" tiene
 * el producto Shipping habilitado y para ver qué campos exige UPS para Argentina → exterior.
 *
 * Usa las MISMAS credenciales del semáforo (UPS_CLIENT_ID / UPS_CLIENT_SECRET del .env de
 * backend/). No toca la base ni el sistema.
 *
 *   cd backend && node scripts/ups-shipping-prueba.js
 *
 * Deja en backend/ups-prueba/:
 *   · pedido.json     lo que se mandó
 *   · respuesta.json  lo que contestó UPS (completo)
 *   · etiqueta.gif    la etiqueta, si UPS la devolvió
 *
 * Variables opcionales (todas con default de prueba):
 *   UPS_CUENTA_EXPO=327W09   cuenta que paga el flete
 *   UPS_SERVICIO=65          65 Worldwide Saver · 08 Worldwide Expedited · 07 Express
 *   UPS_PESO_KG=5            peso del bulto de prueba
 */

const fs = require('fs');
const path = require('path');

// .env de backend/ (el mismo del semáforo). Se fuerza el entorno de TEST antes de cargar
// el servicio: ups.service lee UPS_API_BASE al arrancar.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.UPS_API_BASE = 'https://wwwcie.ups.com';
const { getToken } = require('../src/services/ups.service');

const CUENTA = (process.env.UPS_CUENTA_EXPO || '327W09').trim();
const SERVICIO = (process.env.UPS_SERVICIO || '65').trim();
const PESO_KG = Number(process.env.UPS_PESO_KG || 5);
const OUT = path.join(__dirname, '..', 'ups-prueba');

function armarPedido() {
  return {
    ShipmentRequest: {
      Request: {
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: `nova-prueba-${Date.now()}` },
      },
      Shipment: {
        Description: 'Muestras sin valor comercial - prueba de integracion',
        Shipper: {
          Name: 'NOVA EXPRESS',
          AttentionName: 'Administracion',
          Phone: { Number: '5411' },
          ShipperNumber: CUENTA,
          Address: {
            AddressLine: ['Av. Prueba 123'],
            City: 'Bella Vista',
            StateProvinceCode: 'B',
            PostalCode: '1661',
            CountryCode: 'AR',
          },
        },
        ShipTo: {
          Name: 'TEST RECEIVER LLC',
          AttentionName: 'John Test',
          Phone: { Number: '3055550100' },
          Address: {
            AddressLine: ['1000 NW 57TH CT'],
            City: 'MIAMI',
            StateProvinceCode: 'FL',
            PostalCode: '33126',
            CountryCode: 'US',
          },
        },
        ShipFrom: {
          Name: 'NOVA EXPRESS',
          AttentionName: 'Administracion',
          Phone: { Number: '5411' },
          Address: {
            AddressLine: ['Av. Prueba 123'],
            City: 'Bella Vista',
            StateProvinceCode: 'B',
            PostalCode: '1661',
            CountryCode: 'AR',
          },
        },
        PaymentInformation: {
          ShipmentCharge: [
            { Type: '01', BillShipper: { AccountNumber: CUENTA } },   // 01 = flete → lo paga Nova
          ],
        },
        Service: { Code: SERVICIO },
        // Valor de la mercadería (lo pide UPS en varias rutas internacionales).
        InvoiceLineTotal: { CurrencyCode: 'USD', MonetaryValue: '50' },
        Package: [
          {
            Description: 'Muestras',
            Packaging: { Code: '02' },   // 02 = embalaje propio ("otro tipo")
            Dimensions: {
              UnitOfMeasurement: { Code: 'CM' },
              Length: '30', Width: '20', Height: '20',
            },
            PackageWeight: {
              UnitOfMeasurement: { Code: 'KGS' },
              Weight: String(PESO_KG),
            },
          },
        ],
      },
      LabelSpecification: {
        LabelImageFormat: { Code: 'GIF' },
        HTTPUserAgent: 'Mozilla/4.5',
      },
    },
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('▸ Entorno de TEST de UPS (wwwcie.ups.com) — no genera cargos ni guías reales');
  console.log(`  cuenta ${CUENTA} · servicio ${SERVICIO} · ${PESO_KG} kg · Bella Vista → Miami\n`);

  console.log('▸ Pidiendo token OAuth con las credenciales del .env');
  const token = await getToken();
  console.log('  token OK\n');

  const pedido = armarPedido();
  fs.writeFileSync(path.join(OUT, 'pedido.json'), JSON.stringify(pedido, null, 2));

  console.log('▸ Creando la guía de prueba (POST /api/shipments/v2403/ship)');
  const res = await fetch(`${process.env.UPS_API_BASE}/api/shipments/v2403/ship`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      transId: `nova-prueba-${Date.now()}`,
      transactionSrc: 'nova-express',
    },
    body: JSON.stringify(pedido),
  });
  const texto = await res.text();
  let data = null;
  try { data = JSON.parse(texto); } catch { data = { crudo: texto }; }
  fs.writeFileSync(path.join(OUT, 'respuesta.json'), JSON.stringify(data, null, 2));

  if (!res.ok) {
    console.log(`  ✗ UPS contestó ${res.status}`);
    const errores = data?.response?.errors || [];
    if (errores.length) {
      for (const e of errores) console.log(`    · [${e.code}] ${e.message}`);
    } else {
      console.log('    ' + texto.slice(0, 600));
    }
    console.log(`\n  Respuesta completa en ${path.join(OUT, 'respuesta.json')}`);
    process.exit(1);
  }

  const r = data?.ShipmentResponse?.ShipmentResults || {};
  const guia = r.ShipmentIdentificationNumber;
  const paq = (r.PackageResults || [])[0] || {};
  const cargos = r.ShipmentCharges || {};
  console.log(`  ✓ UPS contestó ${res.status}`);
  console.log(`  Guía de prueba: ${guia || '(no vino)'}`);
  if (paq.TrackingNumber) console.log(`  Tracking del bulto: ${paq.TrackingNumber}`);
  if (cargos.TotalCharges) {
    console.log(`  Cargo total (tarifa de lista, entorno de test): ${cargos.TotalCharges.CurrencyCode} ${cargos.TotalCharges.MonetaryValue}`);
  }
  const alertas = [].concat(data?.ShipmentResponse?.Response?.Alert || []);
  for (const a of alertas) console.log(`  aviso UPS: [${a.Code}] ${a.Description}`);

  const img = paq.ShippingLabel?.GraphicImage;
  if (img) {
    fs.writeFileSync(path.join(OUT, 'etiqueta.gif'), Buffer.from(img, 'base64'));
    console.log(`  Etiqueta guardada en ${path.join(OUT, 'etiqueta.gif')}`);
  } else {
    console.log('  (no vino etiqueta en la respuesta)');
  }
  console.log(`\n  Respuesta completa en ${path.join(OUT, 'respuesta.json')}`);
  console.log('\nETAPA 0: OK — la app puede emitir guías. Lo que sigue es cuestión de datos (Etapa 1).');
}

main().catch((e) => {
  console.error('\n✗ Falló:', e.message);
  process.exit(1);
});
