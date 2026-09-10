# Dashboard — rediseño (propuesta 10/09/2026)

**Pedido** (jefe de Felipe + Felipe, `LISTA-OFICINA-10-09.md` bloque C): kg enviados por mes;
top de clientes "hasta donde quiera" por kg / facturación / utilidad en una tabla con
selector; con el mes cerrado (facturas cargadas) ver kg, utilidad y compra REALES contra lo
estimado, con gráficos; que quede lindo, amistoso y dinámico, con más cosas que se me
ocurran. Lo miran el jefe y Felipe (quizás algún empleado): permiso `ver_dashboard`, que ya
existe.

**Regla:** primero la maqueta (`maqueta-dashboard.html`), después el OK de Felipe, después
se construye. Maqueta con números inventados (la base de prueba tiene 36 envíos y ninguna
factura cruzada).

## Lo que hay hoy

`index.html` + `js/modules/dashboard.js`: período hoy / semana / mes o un mes elegido; 8
tarjetas (utilidad neta, desvío de cotización, disputa UPS, envíos, kilos, ticket promedio,
pendientes de liquidar, clientes nuevos); un gráfico de utilidad por día dibujado a mano en
canvas; top 5 clientes por utilidad; mix de couriers en barras; accesos rápidos. Sin
librería de gráficos. `GET /api/dashboard/metricas` hace 7 consultas con `no_volo = 0`.
No usa `peso_facturado` ni `facturas_cargadas` (lo "real" está sin explotar).

## Propuesta (maqueta)

1. **Cabecera con filtros globales** que afectan TODO lo de abajo: **Período** (Este mes ·
   Últimos 12 meses · Este año · desplegable con rango a medida), **Courier** (Todos / UPS /
   DHL), **Tipo** (Todos / Expo / Impo). Botón **↓ Excel** que baja lo que se ve.
2. **Seis KPIs** con la comparación contra el período anterior y una mini-línea de
   tendencia: Envíos · Kg facturables · Venta · Compra · Profit (con el %) · Sin liquidar
   (cantidad, plata y cuántos con +30 días).
3. **Kg enviados por mes** (C1): barras por mes; barra clara = mismo mes del año anterior;
   selector Kg / Envíos / Venta / Profit para cambiar la magnitud sin cambiar de gráfico.
4. **Mix de couriers** por mes (apilado al 100 %), por Venta / Envíos / Kg.
5. **Top clientes** (C2): UNA tabla con selector de orden (Kg / Venta / Profit / Envíos),
   "Ver 5 · 10 · 20 · Todos", columnas Envíos · Kg · Venta · Profit · % · barra de
   participación · variación contra el período anterior; clic en el cliente abre su perfil;
   pie: "los 8 primeros son el 89 % de la venta · 27 clientes con envíos".
6. **Destinos**: barras horizontales por país (Envíos / Kg / Venta), "Otros (n)" al final.
   (Los países se normalizan: hoy conviven "Estados Unidos", "estados unidos" y "ESTADOS
   UNIDOS".)
7. **Estimado vs. real** (C3): tres gráficos, solo meses con facturas cruzadas — **Compra
   estimada vs. costo facturado**, **Profit estimado vs. real**, **Kg nuestros vs. peso
   facturado por el courier** — con la **cobertura del mes** (% de guías con factura) y un
   aviso ámbar cuando un mes está parcial. Septiembre no aparece hasta que haya facturas.
8. **Margen por mes** (profit / compra) con la línea de objetivo (55 %, configurable).
9. **Plata en la calle** (del panel de Salud, cada renglón abre la pantalla que lo
   resuelve): envíos sin liquidar, liquidaciones sin cobrar, guías con desvío sin revisar,
   en disputa con UPS.
10. **Ritmo**: envíos por semana, kg por envío, venta por envío, días carga → liquidación,
    clientes nuevos; cada uno con el valor del período anterior.
11. Pie: "Σ de envíos con fecha en el período, sin los NO VOLÓ · Profit = venta − compra
    estimada; 'real' usa la factura del courier cuando está aprobada".

## Cómo se construye (cuando Felipe apruebe)

- **Chart.js 4** vendorizado en `frontend/js/vendor/chart.umd.js` (205 KB, sin CDN: la
  app no depende de internet para verse).
- Un endpoint nuevo `GET /api/dashboard/analitica?desde&hasta&courier&tipo` que devuelve
  todo en una sola respuesta (series por mes, top clientes, países, estimado vs real,
  ritmo) para no hacer 10 llamadas; el `metricas` de hoy queda para compatibilidad.
- Los cálculos usan **la misma función de profit** que Salidas y el dashboard actual
  (`utils/profit.js`), NO VOLÓ afuera, "real" solo con `estado_revision = 'revisado_ok'`.
- Excel: `exceljs` ya está en el backend (cierre de mes) — una hoja por bloque.
- Tests: tanda de API (números contra una base armada a mano) + tanda de pantalla.
- Estimación: 2 paquetes (API + pantalla).

## Estado — HECHO (10/09, cache `?v=20260910c`, paquete `dashboard.tgz`)

Felipe aprobó la maqueta ("perfecto, arranca"). Respuestas: el objetivo de margen va en
**Configuración → Margen objetivo del dashboard** (vacío = sin línea); la comparación es
**elegible** (desplegable "Comparar con": el período anterior / el mismo período del año
pasado).

- **Backend:** `services/analitica.service.js` (`analitica(q)` → todo en una respuesta:
  `periodo`, `comparacion`, `kpis`, `kpis_ant`, `variaciones`, `series` (por mes, con la
  serie de comparación alineada por posición), `mix`, `mix_total`, `top_clientes` (con
  participación y variación por métrica), `clientes_activos`, `paises` (normalizados:
  "Estados Unidos" = "estados unidos"), `real` (solo meses con guías cruzadas: compra
  estimada vs facturada, profit estimado vs real, kg nuestros vs facturados, cobertura),
  `margen` (por mes + objetivo), `plata` (sin liquidar, desvíos sin revisar, disputa, UPS
  sin factura +45 días — global, no del período), `ritmo`). `GET /api/dashboard/analitica`
  y `GET /api/dashboard/analitica.xlsx` (`services/excel-dashboard.service.js`, una hoja
  por bloque). `configuracion_nova.margen_objetivo_pct` (migración + schema) con
  `GET/PUT /configuracion/margen-objetivo`. El `metricas` viejo sigue (lo usa
  `test-no-volo`).
- **Pantalla:** `index.html` + `js/modules/dashboard.js` + `css/modules/dashboard.css`;
  **Chart.js 4.4.1 vendorizado** en `js/vendor/chart.umd.js` (sin CDN). Filtros:
  período (Este mes · Últimos 12 meses · Este año · rango de meses), courier, tipo,
  "Comparar con"; ↓ Excel. Seis KPIs con variación y mini-línea; Por mes (Kg / Envíos /
  Venta / Profit, barra clara = comparación); Mix de couriers (100 % apilado); Top
  clientes (selector de métrica, Ver 5/10/20/Todos, link al perfil, participación,
  vs. ant.); Destinos (8 + "Otros"); Estimado vs real (3 gráficos + cobertura + aviso de
  meses parciales; se esconde si no hay guías cruzadas); Margen por mes con objetivo;
  Plata en la calle (cada renglón abre su pantalla); Ritmo. La franja de salud sigue
  arriba. Configuración tiene la tarjeta del margen objetivo.
- **Tandas:** `test-dashboard-analitica` (52, API, en `npm test`) y
  `test-pantalla-dashboard` (29, en `test-pantallas`); `npm run test-dashboard` corre las
  dos. `check-schema` ✓.
- **Pendiente chico:** en pantallas angostas (<1300 px) los KPIs pasan a 3 por fila; la
  cabecera de filtros ocupa dos renglones a 1600 px (aceptable, revisar con Felipe).

## Preguntas para Felipe (respondidas arriba)

- ¿El objetivo de margen (línea punteada) va en Configuración o lo fijo en 55 %?
- ¿"Período anterior" para comparar: mismo largo inmediatamente anterior (12 meses vs los
  12 previos) o mismo período del año pasado? (la maqueta usa el anterior inmediato).
- ¿Algún gráfico que sobre o que falte? El "Ritmo" y "Plata en la calle" son de mi cosecha.
