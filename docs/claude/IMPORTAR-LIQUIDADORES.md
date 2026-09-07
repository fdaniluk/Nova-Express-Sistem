# Importar los liquidadores viejos a la matriz de profit (pedido del 07/09)

**Creado 07/09/2026.** Administración tiene que pasar ~40 clientes del sistema viejo (los
"liquidadores", un `.xls` por cliente) a la **matriz de profit** del sistema nuevo
(`profit_overrides`: servicio × zona 1-6 × 9 bandas de peso). Trabajo de una vez. Coincide
con el limitador **L4** (51 clientes sin margen). Muestras recibidas: `LA MARTINA 2026
LIQUIDADOR.xls`, `CASABLANCA LIQUIDADOR 2026 UPS EXPEDITED FEBRERO.xls`, `FAGLIANO 2026
LIQUIDADOR.xls` (en `C:\dev` no; los tiene Felipe / la oficina).

## 1. Qué hay adentro de un liquidador

Hojas que importan (el resto son históricas):
- **`costo`** (o `COSTO UPS EXPEDITED 25`): la tabla de costo del courier, ZONA 1-6 × pasos de
  0,5 kg, separada en DOCUMENTOS (hasta 5 kg) y PAQUETES.
- **`profit`**: el margen por celda, mismo formato (0,4 = 40 %).
- **`c+p`**: costo × (1 + profit) = **el precio que se le cobra al cliente**, por zona y peso.
- `Tarifa exportaciones`: el tarifario que ve el cliente, agrupado por región (Mercosur, Resto
  Sudamérica, Caribe y Norteam, Europa Occ., Resto del Mundo).

## 2. Lo que enseñaron las tres muestras (07/09)

- **CASABLANCA (UPS Expedited):** su hoja de costo **es exactamente la tabla UPS_EXP del
  sistema nuevo** (0,5 kg: 18,06 · 21,90 · 21,09 · 27,76 · 28,94 · 31,28 — coincide zona por
  zona con `desglosarCosto`). Su `profit` es plano: **40 % en zonas 1-2, 30 % en zonas 3-6**,
  todos los pesos; documentos 150 %. → **Se copia directo** a la matriz.
- **LA MARTINA y FAGLIANO (DHL):** la hoja de costo es una tabla **vieja** ("0290008": 0,5 kg
  z1 = 15,96) que no coincide ni con la DHL actual (24,91) ni con UPS. Por eso sus `profit` no
  dicen nada solos (FAGLIANO tiene **-4 %** en los pesos bajos y sube a 45 % en 40 kg; LA
  MARTINA 10 % y 1 % arriba de 31,5 kg). → **NO se copia el %: se toma `c+p` (el precio final)
  y se busca el % que lo reproduce sobre la tabla NUEVA**, banda por banda.

## 2-bis. El importador ya existe (07/09, noche): `backend/scripts/importar-liquidador.js`

Corrido sobre las tres muestras (`node scripts/importar-liquidador.js --carpeta=C:\dev\liquidadores`):
- **CASABLANCA (UPS Expedited):** 54 celdas, casi todas verdes, 38,5-40 % en zonas 1-2 y
  29,5-31,5 % en zonas 3-6. **Las 6 celdas rojas son la banda 30-40 kg**: el liquidador viejo
  arriba de 31,5 kg cobraba kg × 2,60 sin mínimo y por medio kilo; el sistema nuevo aplica el
  mínimo de UPS (95,16 en z1 hasta 36,5 kg) y redondea al kilo, que es lo que UPS factura de
  verdad (auditoría del 28/08). Ahí el precio viejo estaba por debajo del costo real.
- **FAGLIANO y LA MARTINA (hoja de costo "DHL 0290008", vieja):** contra la tabla DHL actual
  los % implícitos dan **negativos** (FAGLIANO −25 a +18 %, LA MARTINA −11 a +17 %): los
  precios que pagan están por debajo del costo DHL de hoy. Contra UPS Expedited dan 14-67 % y
  40-72 %. **Conclusión: hasta saber por qué courier sale cada cliente hoy, el % propuesto no
  vale.** El importador acepta `--servicio=` para forzarlo.
- El Excel de revisión tiene tres hojas: **Propuesta** (zona × banda, verde/rojo, con el % del
  liquidador viejo en un comentario de cada celda), **Detalle** (cada peso: precio viejo,
  flete nuevo, % implícito, % propuesto, precio nuevo, diferencia) y **Documentos** (solo para
  mirar: la matriz nueva no distingue documentos). Al lado deja un `.propuesta.json` con las
  filas para `profit_overrides` (cliente, servicio, tipo, zona, peso_min, peso_max, profit_pct).
- Rutas relativas, probado desde `/tmp` (regla once). No está en el verificar: es un script de
  una vez, no una tanda.

## 3. El plan (importador, una sola vez)

1. **Script `backend/scripts/importar-liquidador.js`** que lee un `.xls`, detecta el courier
   (por el nombre de la hoja de costo / el archivo) y toma `c+p`.
2. Para cada zona y cada una de las **9 bandas** del sistema nuevo, calcula el % implícito en
   cada paso de 0,5 kg (`c+p / flete_nuevo − 1`) y propone **un % por banda** (el que menos
   desvía), marcando las celdas donde el precio viejo y el nuevo difieren más de un umbral.
3. Genera un **Excel de revisión por cliente**: precio viejo · precio con el % propuesto ·
   diferencia · % propuesto. Administración lo revisa y corrige.
4. Recién con el OK, se carga en `profit_overrides` (con informe, regla del 12/08: el código
   no cambia precios solo).

**Lo que hace falta de administración antes de arrancar:** la **lista de los ~40 clientes con
el courier/servicio que usan hoy** (DHL / UPS Expedited / UPS Saver), y los `.xls`. Y una
decisión de Felipe: para los clientes con tabla vieja (DHL 0290008), ¿se respeta el precio
final que venían pagando (lo que propone el plan) o se les fija un % nuevo?

**Los 40 no se hacen a mano por el chat.** Tampoco los puede hacer administración desde su
propio Claude: lo que hace falta es el motor del sistema, que vive en el repo, no en los
documentos.
