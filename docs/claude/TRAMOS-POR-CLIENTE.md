# Tramos por cliente + la regla de tarifas (11-13/08/2026)

Historia completa de tres días: la matriz única, el despliegue que hubo que revertir, la
migración de tramos, la pantalla unificada y **la regla final de cobro**. Este documento
reemplaza el detalle día a día; el estado actual manda.

---

## ⚠️ LA REGLA FINAL DE COBRO (13/08, definida por Felipe, desplegada en `a5afad2`)

> **"Lo que yo cargo es lo que se cobra. Si no lo cargué, es porque no es así."**

- **El precio por kilo cargado SE COBRA SIEMPRE, cuadrante por cuadrante.** Si una fila de
  `tarifa_kg_overrides` cubre ese peso/zona/servicio, ese es el precio. El porcentaje cubre
  todo lo que no tenga precio por kilo. Un cliente puede tener el mix de las tres cosas:
  global de porcentaje + porcentajes editados + precios por kilo puntuales.
- **`clientes.modo_tarifa` ya NO decide qué se cobra.** Quedó solo para una cosa: si está en
  `por_kg`, el cotizador AVISA cuando un peso cae al porcentaje (probable agujero de carga).
  **El selector se eliminó de la pantalla** — la columna sigue en la base, no borrarla sin
  revisar `resolverTarifaVenta`.
- Implementación: `resolverTarifaVenta()` intenta `resolverTarifaKg()` SIEMPRE primero.
  Tests: `test-tarifa-por-kg` sección 9 ("el precio por kilo se cobra AUNQUE el cliente esté
  en modo porcentaje") y `test-pantalla-tarifa-kg` 7-ter.
- **Consecuencia medida en producción (13/08):** PIO ALVAREZ estaba en modo porcentaje (alguien
  lo cambió), así que sus 97 filas kg no actuaban; con la regla volvieron a valer — **incluidos
  81 precios en USD 0 que COBRAN FLETE GRATIS** (zonas 1, 3-6 y el general de UPS Express).
  Felipe avisado; lo resuelve la oficina cargando o borrando esos ceros. La pantalla los marca
  en rojo con contador. Battlo (23) tiene 1 fila kg que también empezó a actuar.

## La pantalla del perfil del cliente (commits `44d041d` → `72893c9` → `a5afad2`)

Lo que Felipe pidió, después de tres iteraciones (las dos primeras estuvieron MAL — leer
"Errores cometidos" abajo):

1. **Entrar al perfil → UNA tabla general con TODO a la vista:** los tres servicios apilados
   (`#sec-DHL`, `#sec-UPS_EXP`, `#sec-UPS_SAVER`), expo/impo rotuladas, y en cada celda UN
   solo número: **el precio por kilo donde hay, el porcentaje donde no.** Nada de dos valores
   en una celda, nada de marcas amarillas tapando valores.
2. **Editar es un estado aparte:** botones "Editar porcentaje" / "Editar precio por kilo"
   (`#tarifas-vista .vista-btn`). Ahí las celdas se clickean, aparecen las ✕ y el general por
   tabla es editable. En la vista no se edita nada.
3. Impo sin datos = una línea plegada con link. Celdas en USD 0 en rojo + contador arriba
   (`#tarifas-alerta`) — ahora SIEMPRE, porque los ceros cobran.
4. Los botones DHL/UPS Express/UPS Saver de arriba solo scrollean (scrollspy), no ocultan.

### Errores cometidos en el camino (para no repetirlos)

- **v1:** celda con el valor del modo grande + el otro chico. Felipe: "o dice 70 o dice 5,50".
- **v2:** celda con "solo lo que se cobra" según el motor viejo + marca amarilla para kg
  muerto. Felipe: "quiero ver el precio por kilo, qué marquita amarilla me estás hablando".
- **La raíz de los dos errores:** el motor viejo ignoraba el kg en modo porcentaje, y yo
  diseñé pantallas fieles a ese motor en vez de escuchar que Felipe estaba describiendo OTRA
  regla de cobro. La pantalla y el motor tienen que decir lo mismo, y lo que dicen lo define
  él, no el código existente.

## Los tramos por cliente (12-13/08) — resumen

- Tabla `cliente_tramos`; el juego de cada cliente no puede tener huecos ni solapes
  (`validarJuegoDeTramos`). `TRAMOS_POR_DEFECTO` = los NUEVE de siempre; `TRAMOS_SUGERIDOS`
  = once de 5 en 5 (solo pantalla y migrador).
- **El 12/08 se desplegó con los once como default y cambió precios sin migrar → revertido.**
  Regla: un default con datos apoyados no se toca en un despliegue (`test-datos-viejos.js`).
- **La migración (`migrar-tramos.js --aplicar`) corrió el 13/08 en producción**: 11 clientes,
  PIO con 13 tramos propios (corte comercial en 32 kg intacto). Restauró los rangos rotos
  desde el 11/08 (PIO 20-32 a 7,02 entero, Cueros, GERSCOVICH, Demo).
- El guard de tramos huérfanos compara el tramo ENTERO (min y max), no solo el "desde".
- ⚠️ El informe del migrador corrido sobre datos YA migrados reporta cambios fantasma (su
  "antes" modela un cliente sin tramos). Pendiente: que use `obtenerTramos()`.

## Pendientes que dejó esto

1. **La oficina: los 81 ceros de PIO** (cargar o borrar — HOY COBRAN CERO). Battlo: 1 fila kg.
2. Arreglar el "antes" del informe del migrador.
3. Decidir si `modo_tarifa` se elimina del todo (base + aviso) o queda como flag de aviso.
