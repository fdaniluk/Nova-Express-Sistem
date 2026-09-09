# Rediseño de Salidas — brief y análisis

**Creado 09/09/2026.** Pedido textual de Felipe (guardado por si la sesión se corta):

> empecemos a diseñar la parte de salidas, esto es quiza el modulo mas importante y visual
> de todo el sistema, por lo tanto tiene que estar hecho con mucho enfasis, por lo tanto
> necesito que analices todo, espacios muertos, optimizaciones de tamaños, ayudas visuales
> de colores para los botones y distintos estados de las cajas, etc. todo tenes que analizar
> y te pido que no modifiques sin consultarme antes, arma un diseño y mostramelo primero a
> mi por aca y si esta bien lo subimos o vemos que modificamos. pensa en el empleados, que
> hoy en dia esta empezando a acostumbrarse a usarlo, por lo tanto modificalo acorde a eso,
> tambien tene en cuenta que es gente que viene de excel, por lo tanto si hay alguna funcion
> de excel que puedas sumar como para ayudar tambien esta bien tenerlo en cuenta, por
> ejemplo algo que me dijeron que les gustaria tener pero no se que tan viable es es el
> tema de suma de columnas que tiene excel, quiza para contar cantidad de envios de un
> cliente o suma total de Kg o cuestiones numericas rapidas, que si bien se van a consultar
> en el dashboard, tambien esta bueno que tengan rapido acceso desde salidas.

**Regla:** NO se modifica nada sin mostrarle el diseño a Felipe primero. Primero
diagnóstico + maqueta; después, con su OK, se implementa módulo por módulo.

## 1. Diagnóstico de la pantalla de hoy (09/09, sobre capturas a 1600 px)

- **Cabecera cargada y sin jerarquía:** seis botones seguidos (Solo alertas, 1º bulto,
  Limpiar filtros, Copiar guías) + la caja de Cierre (mes, ↓ Mes, ↓ Semana, "nunca se cerró
  un período") en una sola fila; no se distingue qué es "modo de vista", qué es "acción" y
  qué es "archivo". Abajo, otra fila con buscador enorme, contador, Columnas fijas y
  Columnas UPS. Dos filas de botones antes de la tabla.
- **37 columnas sin agrupar:** el ojo no sabe dónde termina la identificación y dónde
  empiezan los costos. Rótulos abreviados (P.Fact, Dscto, Adic) y todos con el mismo peso.
- **Ceros por todos lados:** `$0.00` repetido en Dscto, Derechos, Otros, Costo UPS…; el
  `$` en cada celda; los números importantes (Venta, Compra, Profit) no se destacan.
- **Sub-filas de bultos altas como las principales:** un envío de 5 bultos ocupa 5 renglones
  iguales; el botón "1º bulto" es global (todo o nada).
- **Espacio muerto:** meses con pocas salidas dejan media pantalla vacía; abajo no hay nada.
  Ni total de kilos, ni de venta, ni conteo por cliente: lo que la oficina hacía en Excel
  con la barra de estado.
- **Colores con significados distintos y sin leyenda:** barra roja/ámbar en la primera celda
  (profit), celda amarilla en la guía (mal tipeada), celda roja en Costo UPS (desvío), celda
  azul en Compra (foco de comparación), fila crema (marcada), borde oscuro (NO VOLÓ), punto
  rojo/amarillo/verde (estado de la caja), chips de estado, badges de courier/cobro/tipo/dir.
  Cada uno tiene sentido, pero nadie lo explica en pantalla.
- **Tres badges de poca información:** Tipo (m/d) y Dir (expo/impo) son casi siempre "m" y
  "expo"; ocupan dos columnas con color.
- **Modal:** una columna larga (identificación → estado de caja → medidas → bultos →
  Recalcular / Calcular venta → costos → desglose → observaciones), el resultado (venta,
  compra, profit) queda al final; en el pie, Eliminar (rojo) y NO VOLÓ (rojo oscuro) uno al
  lado del otro: dos botones destructivos del mismo color.

## 2. Propuesta (maquetas `maqueta-salidas.html` y `maqueta-salidas-modal.html`)

1. **Cabecera en dos grupos rotulados:** VER (Solo alertas · Bultos plegados · Columnas
   fijas · Factura UPS · ? Colores) y ACCIONES (Copiar guías (n) · Limpiar filtros). El
   Cierre pasa a la derecha de la barra del buscador, con el mes y sus dos botones.
2. **Barra única:** buscador más corto, chips de filtros activos al lado, contador
   "6 de 23 envíos · 9 bultos", Cierre.
3. **Solapas de mes** como hoy, con el año a la izquierda.
4. **Banda de grupos sobre las columnas:** Identificación · Bulto · Medidas y pesos ·
   Venta · Costos (USD) · Resultado · Factura UPS · Estado, cada una con su color, y las
   de Medidas y Costos **plegables** (como agrupar columnas en Excel).
5. **Números legibles:** sin `$` (la banda dice USD), coma decimal, ceros como "—" en gris,
   tabulares alineados a la derecha; Venta total / Compra total / Peso facturable en negrita;
   Profit y % en verde/rojo.
6. **Bultos como árbol:** ▾ en el #Sal pliega/despliega el envío; las sub-filas son más
   bajas, en gris, con "└ 2/5"; más de 3 bultos se resumen en "… 2 bultos más ▸ ver".
7. **Estados de la caja con nombre** (● Rojo / ● Amarillo / ● Verde) en vez de un punto
   de 8 px. Tipo y Dir dejan de ser columnas con badge: van al modal y al tooltip; DDP se
   ve como chip al lado del courier.
8. **Barra de totales estilo Excel, fija abajo:** Envíos · Bultos · Kg facturables · Kg
   balanza · Venta · Compra · Profit · % promedio de **lo filtrado**; con filas tildadas,
   además "☑ n seleccionados: kg · venta". Clic en un número lo copia. Filtrar por cliente
   = "cuántos envíos y cuántos kilos le mandé a Felipillo este mes" sin ir al dashboard.
9. **Leyenda "? Colores"**: un panel que explica cada color de la tabla.
10. **Modal en dos columnas:** izquierda los tres pasos (Identificación · Bultos, medidas y
    estado de la caja · Costos), derecha el **Resultado** (venta, compra, profit, y si
    coincide con la cotización aceptada), los botones Recalcular / Calcular venta, la
    factura UPS y el **Guardar** coral. Pie: "Eliminar envío" como link rojo chico a la
    izquierda, "Marcar NO VOLÓ" con borde ámbar (ya no dos rojos juntos), Cancelar a la
    derecha. Esc cierra, Ctrl+Enter guarda.
11. **Ayudas de Excel** además de la barra de totales: flechas ↑↓ mueven la fila activa,
    Enter abre el modal, Ctrl+C sobre una celda copia el valor, Ctrl+F va al buscador;
    doble clic en el borde de una columna la ajusta al contenido.

Lo que NO cambia: la lógica (filtros, orden, columnas UPS, revisión ✓/✕, copiar guías,
cierre, cotizaciones, marcas de lectura, columnas fijas), los ids de los tests y la API.

## 3. Decisión de Felipe (09/09) y estado

> "me gusta como se ve, no sacaria las filas que propones por el momento, pero el resto se
> lo ve lindo"

Aprobado todo **menos el punto 7 en lo que toca a las columnas Tipo (m/d) y Dir
(expo/impo): quedan en la tabla** por ahora. Se implementa en tres fases; cada una sale
con las tandas de Salidas en verde y se sube por separado.

### Fase A — HECHA (09/09, `dbe9a44` + el retiro de la barra; cache `?v=20260909b`)

| Punto | Qué quedó |
|---|---|
| 1 | Cabecera en dos pastillas: **VER** (⚠ Solo alertas · ▸ 1º bulto · 📌 Columnas fijas · 🧾 Columnas UPS · ? Colores) y **ACCIONES** (Copiar guías (n) · ✕ Limpiar filtros). Ningún id cambió. |
| 2 | Una sola barra: buscador (380 px) · chips de filtro · contador · **Cierre** (mes, ↓ Mes, ↓ Semana, último cierre) a la derecha. |
| 4 | Banda de grupos (`tr.th-groups`) arriba de los rótulos (`tr.th-cols`): Identificación 8 · Bulto 3 · Medidas y pesos 6 · Venta 3 · Costos (USD) 8 · Resultado 2 · Factura UPS 6 (`.ups-col`, se pliega con el bloque) · Estado 2 = **38**. Las dos filas son sticky; el `top` de los rótulos es el alto real de la banda (`--sal-thg-h`, lo mide `refreshTableHeight`). Sin plegado por grupo todavía. |
| 5 | Importes de la grilla sin `$` y con el **cero en gris** (`fmtCell`); Profit / Profit Real sin `$`; kilos con la unidad en gris chiquito (`.unit`). **Punto decimal, no coma**: los tests y el copiado leen el número tal cual (`Number(t.replace(/[^0-9.-]/g,''))`). |
| 8 | ~~Barra de totales~~ **SACADA el mismo 09/09** a pedido de Felipe: *"no es a lo que me refería… tapa mucha pantalla y son datos que no tienen que estar a simple vista"*. Lo que quiere es **elegir campos y hacer la cuenta rápida en el momento** (estilo barra de estado de Excel al seleccionar celdas). Queda pendiente hasta que hable con administración. Del bloque sobrevive solo el **(n)** del botón Copiar guías (`updateCopiarN`). |
| 9 | **? Colores**: panel flotante con la leyenda (filas, celdas, bultos y estado). Esc o clic afuera lo cierra. |

Test nuevo: `scripts/test-pantalla-rediseno-salidas.js` (26 checks; en `test-pantallas`).
`test-pantalla-columnas-fijas.js` ahora mira `thead tr.th-cols th` (la banda no son columnas).

### Pendiente de definir con administración: la "cuenta rápida"

Felipe (09/09): *"algo más como seleccionar campos y hacer la cuenta rápida en el momento"*.
Idea a proponer cuando vuelva con la respuesta: al seleccionar celdas numéricas con el mouse
(arrastrar) o con Shift+flechas, un globito chico al lado del cursor / en el pie de la
tabla con **Σ · promedio · cantidad**, como la barra de estado de Excel; desaparece al
soltar la selección. Nada fijo en pantalla.

### Fase B — HECHA (09/09, cache `?v=20260909c`)

| Punto | Qué quedó |
|---|---|
| 6 | **Bultos como árbol.** En la fila principal de un multibulto la celda Bulto lleva **▾/▸** (`.bultos-toggle`) que pliega o abre los bultos de ESE envío; las sub-filas son más bajas (padding 2 px, 11 px, gris) y llevan **└**. Estado por envío en `bultosOverride` (XOR con el botón global "1º bulto": el botón pliega/abre todos y olvida los individuales; "Limpiar filtros" también). No se hizo el resumen "… n bultos más": los bultos tienen guía propia y checkbox para Copiar guías, esconderlos a medias confundía. |
| 11 | **Atajos sobre la celda activa** (`onGridKeydown`): **Enter** abre el modal con el destello en el campo de esa columna; **Ctrl+C** copia el valor limpio de la celda (sin ▸, lápiz ni "kg"; punto decimal) y la parpadea en verde — si hay texto marcado a mano, copia eso como siempre; **Esc** suelta la celda; **Ctrl+F** (en toda la pantalla, fuera de un input y sin modal) va al buscador de la tabla. Las flechas ya existían. |
| 4 (2ª parte) | **Plegar Medidas / Costos por grupo: NO se hizo.** Con `table-layout:auto`, columnas fijas por `nth-child`, colspans de las sub-filas y la navegación por flechas, esconder columnas del medio toca demasiado por poco; el bloque UPS ya cubre el caso que importa. Si administración lo pide, se retoma. |
| 7 | Estado de la caja: sigue el punto de color (con el nombre en el tooltip); con nombre escrito la columna Bulto se ensanchaba. |

Test: `test-pantalla-rediseno-salidas.js` pasa a 47 checks (secciones 6 y 7).

### Fase C — pendiente

Punto 10: modal en dos columnas (Resultado a la derecha, Guardar coral, Eliminar como
link, NO VOLÓ ámbar, Esc / Ctrl+Enter).
