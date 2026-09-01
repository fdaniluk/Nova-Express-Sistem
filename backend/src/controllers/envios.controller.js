const envioModel = require('../models/envio.model');
const { calcularPesos } = require('../services/calculos.service');
const excelService = require('../services/excel.service');

async function listar(req, res, next) {
  try {
    res.json(await envioModel.listar(req.query));
  } catch (e) {
    next(e);
  }
}

async function obtener(req, res, next) {
  try {
    const envio = await envioModel.buscarPorId(req.params.id);
    if (!envio) return res.status(404).json({ error: 'Envío no encontrado' });
    res.json(envio);
  } catch (e) {
    next(e);
  }
}

// Regla de negocio: los documentos se despachan unicamente por DHL.
// Se valida tambien en el backend porque la pantalla se puede saltear
// (llamada directa a la API, pestaña vieja en cache, import).
function errorDocumentoSoloDHL(tipoPaquete, courier) {
  const esDoc = String(tipoPaquete ?? '').trim().toLowerCase() === 'd';
  const cur = String(courier ?? '').trim().toUpperCase();
  if (esDoc && cur && cur !== 'DHL') {
    return `Los documentos se envian unicamente por DHL (se recibio ${cur})`;
  }
  return null;
}

async function crear(req, res, next) {
  try {
    const errDoc = errorDocumentoSoloDHL(req.body.tipo_paquete, req.body.courier);
    if (errDoc) return res.status(400).json({ error: errDoc });
    // `peso_real` NO está en la lista: un envío se puede cargar SIN PESAR.
    //
    // Hay clientes cuyos paquetes no pasan por el depósito (Kasdorf y parecidos): se les
    // manda la guía, la imprimen y despachan, y los pesos reales llegan días después. El
    // envío se carga igual el día que sale, y cuando llegan los pesos se completan desde
    // Salidas. Sin peso, las columnas de costo quedan vacías (ver sinPesar() en
    // envio.model): el envío existe, pero no aporta plata inventada a ningún total.
    const required = [
      'cliente_id',
      'fecha',
      'courier',
      'tipo_envio',
      'numero_guia',
      'pais_destino',
    ];
    for (const f of required) {
      if (req.body[f] === undefined || req.body[f] === '') {
        return res.status(400).json({ error: `Campo obligatorio: ${f}` });
      }
    }
    // peso_real es NOT NULL en la base: sin pesar se guarda 0, que es el marcador.
    // Valores de lista: la base los tiene con CHECK, asi que un valor invalido reventaba
    // con un 500 y el error crudo de SQLite en la cara del usuario (punto E6). Se validan
    // aca para devolver un 400 que se entienda y que diga que llego.
    const tipoEnvio = String(req.body.tipo_envio ?? '').trim();
    if (tipoEnvio !== 'exportacion' && tipoEnvio !== 'importacion') {
      return res.status(400).json({
        error: `El tipo de envio debe ser "exportacion" o "importacion" (se recibio "${tipoEnvio}").`,
      });
    }
    const courierNuevo = String(req.body.courier ?? '').trim();
    if (courierNuevo !== 'DHL' && courierNuevo !== 'UPS') {
      return res.status(400).json({
        error: `El courier debe ser "DHL" o "UPS" (se recibio "${courierNuevo}").`,
      });
    }

    const body = { ...req.body };
    if (body.peso_real === undefined || body.peso_real === '' || body.peso_real === null) {
      body.peso_real = 0;
    }
    const envio = await envioModel.crear(body);
    res.status(201).json(envio);
  } catch (e) {
    if (e.message?.includes('UNIQUE')) {
      const guia = String(req.body.numero_guia ?? '').trim().toUpperCase();
      return res.status(409).json({
        error: guia
          ? `Ya existe un envío con la guía "${guia}"`
          : 'Ya existe un envío con ese número de guía',
      });
    }
    next(e);
  }
}

async function actualizar(req, res, next) {
  try {
    // Se valida sobre el resultado final (lo que manda el body + lo que ya estaba),
    // porque una edicion parcial puede tocar solo uno de los dos campos.
    if (req.body.tipo_paquete !== undefined || req.body.courier !== undefined) {
      const actual = await envioModel.buscarPorId(req.params.id);
      if (!actual) return res.status(404).json({ error: 'Envío no encontrado' });
      const errDoc = errorDocumentoSoloDHL(
        req.body.tipo_paquete !== undefined ? req.body.tipo_paquete : actual.tipo_paquete,
        req.body.courier !== undefined ? req.body.courier : actual.courier
      );
      if (errDoc) return res.status(400).json({ error: errDoc });
    }
    const envio = await envioModel.actualizar(req.params.id, req.body);
    if (!envio) return res.status(404).json({ error: 'Envío no encontrado' });
    res.json(envio);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    if (e.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Número de guía duplicado' });
    }
    next(e);
  }
}

function calcularPesosPreview(req, res, next) {
  try {
    const pesos = calcularPesos(
      req.body.peso_real,
      req.body.bultos,
      { largo: req.body.largo, ancho: req.body.ancho, alto: req.body.alto }
    );
    res.json(pesos);
  } catch (e) {
    next(e);
  }
}

async function importarExcel(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Debe enviar un archivo Excel' });
    }
    const resultado = await excelService.importarSalidas(req.file.buffer);
    res.json(resultado);
  } catch (e) {
    next(e);
  }
}

module.exports = {
  listar,
  obtener,
  crear,
  actualizar,
  calcularPesosPreview,
  importarExcel,
};
