const { Router } = require('express');
const multer = require('multer');
const ctrl = require('../controllers/envios.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const router = Router();

router.get('/', ctrl.listar);
router.post('/calcular-pesos', ctrl.calcularPesosPreview);
router.post('/importar', upload.single('archivo'), ctrl.importarExcel);
router.get('/:id', ctrl.obtener);
router.post('/', ctrl.crear);
router.put('/:id', ctrl.actualizar);

module.exports = router;
