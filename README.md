# Nova Express — Sistema de Gestión

Aplicación web para la gestión operativa de **Nova Express**, empresa de courier (DHL / UPS) en Buenos Aires. Funciona en red local sin conexión a internet.

## Estructura del proyecto

```
Nova-Express-Sistem/
├── frontend/          # Interfaz web (HTML, CSS, JavaScript)
├── backend/           # API REST con Node.js y Express
└── database/          # Esquema SQLite y base nova.db
```

## Módulos

| Módulo | Descripción |
|--------|-------------|
| **Registro de envíos** | Alta, edición, listado con filtros, importación Excel (SALIDAS), cálculo automático de peso volumétrico y facturable |
| **Liquidaciones** | Pendientes por cliente, creación con desglose flete/fuel/seguro, exportación Excel, historial, configuración de fuel DHL/UPS |

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior

## Inicio rápido

```bash
cd backend
npm install
npm run dev
```

Abrir en el navegador: **http://localhost:3000**

La base SQLite se crea automáticamente en `database/nova.db` con fuel inicial DHL y UPS al **39.5%** (configurable desde Liquidaciones → Configuración).

## Lógica de negocio

- **Peso volumétrico:** `(largo × ancho × alto) / 5000` por bulto
- **Peso facturable:** `max(peso real, peso volumétrico total)`
- **Seguro:** $0 si FOB &lt; $100 · $15 si FOB $100–$1000 · 1.5% si FOB &gt; $1000
- **Flete:** `(Total cobrado − Seguro) / (1 + fuel%)`
- **Fuel:** `Flete × fuel%` (fuel leído de BD, nunca hardcodeado en código de liquidación)

## API principal

| Método | Ruta | Uso |
|--------|------|-----|
| GET/POST | `/api/clientes` | Clientes |
| GET/POST/PUT | `/api/envios` | Envíos |
| POST | `/api/envios/importar` | Excel SALIDAS |
| GET | `/api/liquidaciones/pendientes` | Cola pendiente |
| POST | `/api/liquidaciones/preview` | Simular liquidación |
| POST | `/api/liquidaciones` | Crear (confirmar con `confirmar: true`) |
| GET | `/api/liquidaciones/:id/exportar` | Excel DIARIO_[Cliente]_Envio_[fecha].xlsx |
| PUT | `/api/configuracion/fuel/:courier` | Actualizar fuel |

## Licencia

Proyecto privado — Nova Express.
