// Emisión de guías UPS desde el sistema (guías, etapa 2 — 08/09/2026, GUIAS-UPS.md).
//
// Arma el pedido a la Shipping API con los datos del sistema (cliente = remitente,
// destinatario de la libreta, bultos, servicio, DDP) y devuelve número de guía, etiqueta
// y cargo. Es la versión "de verdad" de scripts/ups-shipping-prueba.js (Etapa 0).
//
// Entorno: UPS_SHIPPING_ENTORNO=test (default) pega a wwwcie.ups.com → guías de PRUEBA,
// sin cargos ni recolección. Recién con UPS_SHIPPING_ENTORNO=prod se emiten guías reales
// contra onlinetools.ups.com. El token OAuth se pide al mismo host que la guía (un token
// de producción no sirve en test y viceversa), por eso no se reutiliza el de ups.service.
//
// Remitente en la guía (Shipper): la cuenta de Nova. Los datos vienen del .env:
//   UPS_SHIPPER_NOMBRE, UPS_SHIPPER_ATENCION, UPS_SHIPPER_TELEFONO, UPS_SHIPPER_DIRECCION,
//   UPS_SHIPPER_CIUDAD, UPS_SHIPPER_PROVINCIA (código UPS, ej. B), UPS_SHIPPER_CP
// ShipFrom (de dónde sale físicamente): el cliente, con su dirección de recolección.
//
// UPS_SHIPPING_MOCK=1 (tests): no llama a UPS, devuelve una respuesta inventada con la
// forma real. Nunca se activa en producción (server.js no lo setea).
const { isoDePais } = require('../utils/paisesIso');

const HOSTS = {
  test: 'https://wwwcie.ups.com',
  prod: 'https://onlinetools.ups.com',
};
const SERVICIO_CODIGO = { UPS_SAV: '65', UPS_EXP: '08' };
const SERVICIO_NOMBRE = { UPS_SAV: 'Worldwide Saver', UPS_EXP: 'Worldwide Expedited' };

function entorno() {
  return (process.env.UPS_SHIPPING_ENTORNO || 'test').trim() === 'prod' ? 'prod' : 'test';
}

function cuentaExpo() {
  return (process.env.UPS_CUENTA_EXPO || '327W09').trim();
}

function esMock() {
  return String(process.env.UPS_SHIPPING_MOCK || '') === '1';
}

function shipperNova() {
  const e = process.env;
  return {
    nombre: (e.UPS_SHIPPER_NOMBRE || 'NOVA EXPRESS').trim(),
    atencion: (e.UPS_SHIPPER_ATENCION || 'Administracion').trim(),
    telefono: (e.UPS_SHIPPER_TELEFONO || '').trim(),
    direccion: (e.UPS_SHIPPER_DIRECCION || '').trim(),
    ciudad: (e.UPS_SHIPPER_CIUDAD || '').trim(),
    provincia: (e.UPS_SHIPPER_PROVINCIA || 'B').trim(),
    cp: (e.UPS_SHIPPER_CP || '').trim(),
  };
}

function configuracion() {
  const s = shipperNova();
  return {
    entorno: entorno(),
    cuenta: cuentaExpo(),
    mock: esMock(),
    shipper_completo: Boolean(s.direccion && s.ciudad && s.cp && s.telefono),
    shipper: s,
  };
}

// ── Token contra el host del entorno ─────────────────────────────────────────
const tokens = {};
async function getTokenPara(host) {
  const t = tokens[host];
  if (t && Date.now() < t.expira) return t.valor;
  const clientId = (process.env.UPS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.UPS_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw new Error('Faltan credenciales UPS_CLIENT_ID / UPS_CLIENT_SECRET en .env');
  const res = await fetch(`${host}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`UPS auth falló (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  tokens[host] = { valor: data.access_token, expira: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 };
  return tokens[host].valor;
}

// ── Validación y armado del pedido ───────────────────────────────────────────
function recortar(s, n) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function soloDigitos(s) {
  return String(s ?? '').replace(/\D+/g, '');
}

/** Devuelve la lista de problemas que impiden pedir la guía (vacía si está todo). */
// `remitente` es la forma única de remitentes.model.resolver(): la ficha del cliente o
// un perfil de la libreta de remitentes.
function validar({ cliente, remitente, destinatario, bultos, servicio, contenido }) {
  const faltan = [];
  if (!SERVICIO_CODIGO[servicio]) faltan.push('Elegí el servicio (Saver o Expedited)');
  if (!cliente) faltan.push('Falta el cliente');
  else if (!remitente) faltan.push('El remitente elegido no es de ese cliente');
  else {
    const quien = remitente.principal ? 'El cliente' : `El remitente "${remitente.nombre}"`;
    if (!remitente.direccion) faltan.push(`${quien} no tiene dirección cargada`);
    if (!remitente.ciudad) faltan.push(`${quien} no tiene localidad cargada`);
    if (!remitente.codigo_postal) faltan.push(`${quien} no tiene código postal cargado`);
  }
  if (!destinatario) faltan.push('Falta el destinatario');
  else {
    if (!destinatario.direccion1) faltan.push('El destinatario no tiene dirección');
    if (!destinatario.ciudad) faltan.push('El destinatario no tiene ciudad');
    if (!isoDePais(destinatario.pais)) faltan.push(`No conozco el código de país de "${destinatario.pais}": cargalo como código de 2 letras`);
    if (!soloDigitos(destinatario.telefono)) faltan.push('El destinatario no tiene teléfono (UPS lo exige)');
    const iso = isoDePais(destinatario.pais);
    if ((iso === 'US' || iso === 'CA') && !destinatario.estado) faltan.push('Para Estados Unidos y Canadá UPS exige el estado/provincia (código de 2 letras)');
    if ((iso === 'US' || iso === 'CA') && !destinatario.codigo_postal) faltan.push('Para Estados Unidos y Canadá UPS exige el código postal');
  }
  if (!Array.isArray(bultos) || !bultos.length) faltan.push('Cargá al menos un bulto');
  else {
    bultos.forEach((b, i) => {
      if (!(Number(b.peso_real) > 0)) faltan.push(`El bulto ${i + 1} no tiene peso`);
    });
  }
  if (!recortar(contenido, 50)) faltan.push('Falta el contenido (descripción de la mercadería)');
  const nova = shipperNova();
  if (!nova.direccion || !nova.ciudad || !nova.cp || !nova.telefono) {
    faltan.push('Faltan los datos del remitente Nova en el .env (UPS_SHIPPER_DIRECCION / CIUDAD / CP / TELEFONO)');
  }
  return faltan;
}

function armarPedido({ remitente, destinatario, bultos, servicio, ddp, contenido, fob, referencia }) {
  const nova = shipperNova();
  const cuenta = cuentaExpo();
  const iso = isoDePais(destinatario.pais);
  const shipTo = {
    Name: recortar(destinatario.nombre, 35),
    AttentionName: recortar(destinatario.contacto || destinatario.nombre, 35),
    Phone: { Number: soloDigitos(destinatario.telefono).slice(0, 15) },
    Address: {
      AddressLine: [destinatario.direccion1, destinatario.direccion2, destinatario.direccion3]
        .filter(Boolean).map((l) => recortar(l, 35)),
      City: recortar(destinatario.ciudad, 30),
      PostalCode: recortar(destinatario.codigo_postal, 9),
      CountryCode: iso,
    },
  };
  if (destinatario.estado) shipTo.Address.StateProvinceCode = recortar(destinatario.estado, 5).toUpperCase();
  if (destinatario.email) shipTo.EMailAddress = recortar(destinatario.email, 50);
  if (destinatario.tax_id) shipTo.TaxIdentificationNumber = recortar(destinatario.tax_id, 15);

  const shipmentCharge = [{ Type: '01', BillShipper: { AccountNumber: cuenta } }];
  // Impuestos y derechos: con DDP los paga Nova (misma cuenta); sin DDP no se manda el
  // cargo 02 y UPS se los cobra al destinatario, que es "facturar al destinatario" (4-ter).
  if (ddp) shipmentCharge.push({ Type: '02', BillShipper: { AccountNumber: cuenta } });

  return {
    ShipmentRequest: {
      Request: {
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: recortar(referencia || 'nova', 50) },
      },
      Shipment: {
        Description: recortar(contenido, 50),
        Shipper: {
          Name: recortar(nova.nombre, 35),
          AttentionName: recortar(nova.atencion, 35),
          Phone: { Number: soloDigitos(nova.telefono).slice(0, 15) },
          ShipperNumber: cuenta,
          Address: {
            AddressLine: [recortar(nova.direccion, 35)],
            City: recortar(nova.ciudad, 30),
            StateProvinceCode: nova.provincia,
            PostalCode: recortar(nova.cp, 9),
            CountryCode: 'AR',
          },
        },
        ShipTo: shipTo,
        ShipFrom: {
          Name: recortar(remitente.nombre, 35),
          AttentionName: recortar(remitente.contacto || remitente.nombre, 35),
          Phone: { Number: soloDigitos(remitente.telefono || nova.telefono).slice(0, 15) },
          Address: {
            AddressLine: [recortar(remitente.direccion, 35)],
            City: recortar(remitente.ciudad, 30),
            StateProvinceCode: nova.provincia,
            PostalCode: recortar(remitente.codigo_postal, 9),
            CountryCode: 'AR',
          },
        },
        PaymentInformation: { ShipmentCharge: shipmentCharge },
        Service: { Code: SERVICIO_CODIGO[servicio] },
        InvoiceLineTotal: { CurrencyCode: 'USD', MonetaryValue: String(Math.max(1, Math.round(Number(fob) || 0))) },
        Package: bultos.map((b, i) => {
          const pkg = {
            Description: recortar(`${contenido} ${bultos.length > 1 ? `(${i + 1}/${bultos.length})` : ''}`, 35),
            Packaging: { Code: '02' },
            PackageWeight: { UnitOfMeasurement: { Code: 'KGS' }, Weight: String(Math.max(0.1, Math.round(Number(b.peso_real) * 10) / 10)) },
          };
          if (Number(b.largo) > 0 && Number(b.ancho) > 0 && Number(b.alto) > 0) {
            pkg.Dimensions = {
              UnitOfMeasurement: { Code: 'CM' },
              Length: String(Math.ceil(Number(b.largo))),
              Width: String(Math.ceil(Number(b.ancho))),
              Height: String(Math.ceil(Number(b.alto))),
            };
          }
          return pkg;
        }),
      },
      LabelSpecification: {
        LabelImageFormat: { Code: 'GIF' },
        HTTPUserAgent: 'Mozilla/4.5',
      },
    },
  };
}

// ── Llamadas a UPS ───────────────────────────────────────────────────────────
function erroresDe(data, texto) {
  const errores = data?.response?.errors || [];
  if (errores.length) return errores.map((e) => `[${e.code}] ${e.message}`);
  return [String(texto || '').slice(0, 300) || 'sin detalle'];
}

// GIF de 1×1 para el mock: la etiqueta de mentira existe y se puede imprimir.
const GIF_MOCK = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

function respuestaMock(pedido) {
  const n = String(Date.now()).slice(-10);
  const numero = `1Z${cuentaExpo()}${'0'.repeat(Math.max(0, 10 - n.length))}${n}`.slice(0, 18);
  const paquetes = pedido.ShipmentRequest.Shipment.Package.map((p, i) => ({
    TrackingNumber: numero,
    ShippingLabel: { ImageFormat: { Code: 'GIF' }, GraphicImage: GIF_MOCK },
    _mock: i,
  }));
  return {
    ShipmentResponse: {
      Response: { ResponseStatus: { Code: '1', Description: 'Success' }, Alert: [{ Code: '0', Description: 'Respuesta simulada (UPS_SHIPPING_MOCK)' }] },
      ShipmentResults: {
        ShipmentCharges: { TotalCharges: { CurrencyCode: 'USD', MonetaryValue: '123.45' } },
        ShipmentIdentificationNumber: numero,
        PackageResults: paquetes,
      },
    },
  };
}

async function pedirGuia(pedido) {
  if (esMock()) return { ok: true, status: 200, data: respuestaMock(pedido) };
  const host = HOSTS[entorno()];
  const token = await getTokenPara(host);
  const res = await fetch(`${host}/api/shipments/v2403/ship`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      transId: `nova-${Date.now()}`,
      transactionSrc: 'nova-express',
    },
    body: JSON.stringify(pedido),
  });
  const texto = await res.text();
  let data = null;
  try { data = JSON.parse(texto); } catch { data = { crudo: texto }; }
  if (!res.ok) return { ok: false, status: res.status, data, errores: erroresDe(data, texto) };
  return { ok: true, status: res.status, data };
}

/** Lee de la respuesta lo que el sistema guarda. */
function resumirRespuesta(data) {
  const r = data?.ShipmentResponse?.ShipmentResults || {};
  const paquetes = r.PackageResults || [];
  const alertas = [].concat(data?.ShipmentResponse?.Response?.Alert || []).map((a) => `[${a.Code}] ${a.Description}`);
  return {
    numero_guia: r.ShipmentIdentificationNumber || null,
    trackings: paquetes.map((p) => p.TrackingNumber).filter(Boolean),
    etiquetas: paquetes.map((p) => p.ShippingLabel?.GraphicImage || null),
    cargo: r.ShipmentCharges?.TotalCharges ? Number(r.ShipmentCharges.TotalCharges.MonetaryValue) : null,
    moneda: r.ShipmentCharges?.TotalCharges?.CurrencyCode || null,
    alertas,
  };
}

async function anularGuia(numeroGuia) {
  if (esMock()) return { ok: true, data: { VoidShipmentResponse: { SummaryResult: { Status: { Code: '1', Description: 'Voided (mock)' } } } } };
  const host = HOSTS[entorno()];
  const token = await getTokenPara(host);
  const res = await fetch(`${host}/api/shipments/v1/void/cancel/${encodeURIComponent(numeroGuia)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, transId: `nova-void-${Date.now()}`, transactionSrc: 'nova-express' },
  });
  const texto = await res.text();
  let data = null;
  try { data = JSON.parse(texto); } catch { data = { crudo: texto }; }
  if (!res.ok) return { ok: false, status: res.status, data, errores: erroresDe(data, texto) };
  return { ok: true, data };
}

module.exports = {
  SERVICIO_CODIGO,
  SERVICIO_NOMBRE,
  configuracion,
  validar,
  armarPedido,
  pedirGuia,
  resumirRespuesta,
  anularGuia,
  entorno,
  cuentaExpo,
};
