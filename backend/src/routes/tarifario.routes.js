// Lo del tarifario que NO cuelga de un cliente: los presets del panel (una combinación
// de opciones con nombre, compartida por toda la oficina) y la lectura de una emisión
// puntual por id (la hoja tal como salió, para reabrirla o reimprimirla).
// Lo que SÍ cuelga de un cliente (generar, emitir, listar emisiones) vive en
// clientes.routes.js, junto al resto del perfil.
const { Router } = require('express');
const ctrl = require('../controllers/tarifario.controller');

const router = Router();

router.get('/presets', ctrl.presets);
router.put('/presets', ctrl.guardarPreset);
router.delete('/presets/:presetId', ctrl.borrarPreset);

router.get('/emitidos/:id', ctrl.emitido);

module.exports = router;
