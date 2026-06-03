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

async function crear(req, res, next) {
  try {
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
      return res.status(409).json({ error: 'Ya existe un envío con ese número de guía' });
    }
    next(e);
  }
}

async function actualizar(req, res, next) {
  try {
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
