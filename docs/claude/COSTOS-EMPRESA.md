# Costos de la empresa — Entrega 1 (08/10/2026)

Módulo nuevo "Costos" (menú, pantalla `pages/costos.html`) para que Marcelo vea mes a mes lo que cuesta tener Nova Express abierta y, en la entrega 2, el Dashboard muestre "utilidad de envíos − costos".

## Lo que decidió Felipe (08/10)
- Lista fija de categorías + se pueden agregar a mano. Hay cosas en pesos y en dólares: cada costo se carga **en la moneda en que se paga** y se puede ver todo en USD o en ARS.
- Registro **mensual**; después se refleja en distintas partes del Dashboard.
- **Todos entran** al módulo, pero los empleados solo cargan **gastos del día a día** (combustible, insumos, mensajería, servicios menores…). Lo que cargan queda **por confirmar** hasta que lo revise dirección. Sueldos, alquiler, totales y resultado neto los ve solo quien tiene permiso.

## Cómo quedó
- **Permiso nuevo `ver_costos`** (Usuarios → chip "Costos"): ver todo y confirmar. Regla admin OR ver_costos (`requireCostos`). Marcelo lo recibe solo al desplegar (migración una vez `ver_costos_marcelo`).
- **Categorías** (`costos_categorias`): Sueldos · Alquiler · Servicios* · Impuestos y contador · Ingresos Brutos (automática) · Insumos y embalaje* · Courier no refacturable · Vehículo y combustible* · Mensajería y viáticos* · Otros*. Las marcadas * "las carga la oficina"; la marca se cambia desde el botón Categorías (solo dirección), que también crea categorías nuevas y las da de baja.
- **Ingresos Brutos** no se carga: es la suma de `facturas_cargadas.percepciones` de las facturas con fecha en el mes (UPS + DHL). Fila automática con link a Facturas → pestaña Ingresos Brutos (`facturas.html#iibb`).
- **Dólar del mes**: a mano para ese mes (pill de la cabecera, solo dirección) > promedio de `cc_tipo_cambio` (los que carga Cobranzas) dentro del mes > el último cargado antes de fin de mes > "sin cargar" (los pesos no se suman y se avisa).
- **Fijos**: "Se repite: todos los meses" marca el costo; el botón **Traer los fijos del mes pasado** los copia al mes como "por confirmar" (idempotente, por `origen_id`). Se confirman con el monto real (Confirmar pide el monto).
- **Empleado**: ve y carga solo categorías de oficina; edita/borra lo suyo mientras esté por confirmar; no ve totales, tarjetas, fijos, categorías ni el dólar editable. El backend filtra por `req.usuario`, no la pantalla.
- **Tarjetas** (dirección): costos del mes (con el desglose pesos/dólares), utilidad de envíos (la misma del Dashboard, `analitica.service`), resultado neto (utilidad − costos, % de la utilidad, rojo si no cubre) y comparación con el mes anterior.
- API `/api/costos`: `GET ?mes` (resumen del mes según permiso) · `POST/PUT/DELETE` · `POST /:id/confirmar {monto?}` · `POST /traer-fijos {mes}` · `GET/PUT /tc` · `GET/POST/PUT /categorias` · `GET /serie?desde&hasta` (para el Dashboard, entrega 2).
- Tablas: `costos_categorias`, `costos`, `costos_meses` (dólar a mano). Migración en `db/index.js` (`migrateCostos`) y `schema.sql`.
- Tests: `test-costos.js` (37, API y reglas) y `test-pantalla-costos.js` (24, las dos vistas en el navegador). Maqueta aprobada: `docs/maquetas/maqueta-costos.html`.

## Entrega 2 (pendiente)
Dashboard, solo con permiso de costos: KPIs "Costos de la empresa", "Resultado neto" y "Punto de equilibrio" (cuánto profit hace falta para cubrir el mes) + gráfico profit vs. costos por mes (`GET /api/costos/serie`).
