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
    const required = [
      'cliente_id',
      'fecha',
      'courier',
      'tipo_envio',
      'numero_guia',
      'pais_destino',
      'peso_real',
    ];
    for (const f of required) {
      if (req.body[f] === undefined || req.body[f] === '') {
        return res.status(400).json({ error: `Campo obligatorio: ${f}` });
      }
    }
    const envio = await envioModel.crear(req.body);
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
