> ⚠ **SUPERADO EL 01/09/2026 — ver `claude/TARIFA-DHL-MAS-50.md`.**
> Este análisis comparaba **fletes pelados** y le faltaba el dato clave: la cuenta MAS 50 KGS
> **no cobra GoGreen** (0,98 USD por kilo facturable). Comparando el costo completo, la +50
> gana en las **seis** zonas de 51 a 300 kg — no en tres como dice el cuadro de abajo.
> El punto 1 de "Pendiente / a decidir" también quedó contestado: son **dos cuentas
> distintas de DHL**, así que sí se puede elegir por guía. La tarifa ya está en el sistema.
> Lo que sigue vale como registro de cómo se hizo la comparación en agosto.

# Tarifario DHL EXPO unificado (03-08-2026)

Felipe pasó dos tarifarios de DHL Express Argentina, cliente NOVA EXPRESS / DANILUK MARCELO,
y pidió armar uno solo con el mejor precio de cada uno.

- **`DHL Express Tarifario EXPO 2026 2.pdf`** — el que ya usaban. 6 páginas, solo exportación.
- **`TARIFARIO DHL EXPO MAS 50 KGS.pdf`** — nuevo, formato del de Impo. 22 páginas: exportación (1-5),
  **importación (6-10)**, zonificación (11) y servicios/recargos (12-22).

Ambos: USD, adicionales incluidos, 6 zonas, 330 filas de peso de 0.5 a 300 kg (0.5 kg hasta 30, 1 kg de 31 a 300).
Rate card 23-jul-2026, código de tarifa `ARC01TMZ6–ARB01RCBA/ARB01RCC7`.

## Resultado de la comparación (1.980 casilleros) — SIN el GoGreen

| Zona | Gana | Detalle |
|---|---|---|
| 1 | **EXPO 2026 siempre** | el MAS 50 KG no gana en ningún peso |
| 2 | mixto | EXPO ≤50 kg · **MAS 50 KG de 51 a 84** · EXPO de 85 a 300 (diferencia de centavos) |
| 3 | **EXPO 2026 siempre** | el MAS 50 KG no gana en ningún peso |
| 4 | mixto | EXPO ≤50 kg · **MAS 50 KG de 51 a 300** |
| 5 | mixto | EXPO ≤50 kg · **MAS 50 KG de 51 a 300** |
| 6 | mixto | EXPO ≤50 kg · **MAS 50 KG de 51 a 300** |

**784 de 1.980 casilleros cambian.** Todos arriba de 50 kg.

Debajo de 51 kg el EXPO 2026 gana en las seis zonas sin una sola excepción: el MAS 50 KG
es entre 2 y 3 veces más caro ahí (0.5 kg Z1: 24,91 vs 71,18). En 51 kg el MAS 50 KG
salta a tarifa lineal por kilo (Z1 4,38 · Z2 4,98 · Z3 6,00 · Z4 6,60 · Z5 7,50 · Z6 8,40 USD/kg)
y es donde empieza a ganar.

Ahorro típico arriba de 50 kg en zonas 4/5/6: **~5,8 %** hasta ~200 kg, bajando a ~3 % en 300 kg.
Zona 2 es marginal (centavos) — se puede ignorar sin perder casi nada.

Documentos hasta 2 kg: **todo EXPO 2026**, menos de la mitad que el otro.

## Entregable

`Tarifario_DHL_EXPO_unificado.xlsx` — 5 hojas:

1. **Resumen** — el cuadro de arriba y las advertencias
2. **Tarifario unificado** — formato DHL (banda amarilla, barras rojas). Fondo blanco = EXPO 2026,
   **fondo amarillo = rescatado del MAS 50 KG**. Cada celda es `=MIN()` contra las dos hojas fuente.
3. **MAS 50 KG** / 4. **EXPO 2026** — datos crudos de los PDF, para auditar
5. **Comparación** — 1.980 filas con ambos precios, cuál se eligió, ahorro USD y %

## Pendiente / a decidir — estado al 01/09

1. ~~**El unificado supone que Nova puede elegir con qué tarifario despachar cada guía.**~~
   **CONTESTADO:** son dos cuentas distintas de DHL. Se elige por guía. Ya está en el sistema.
2. **Arriba de 300 kg ninguno de los dos tiene tabla** — hay que cotizar con DHL.
   *(El motor extrapola con el valor por kilo, que arriba de 50 kg es exacto porque la
   tarifa es lineal. Igual conviene confirmarlo con DHL antes de cotizar un envío así.)*
3. ~~**El PDF del MAS 50 KG trae un tarifario de IMPORTACIÓN completo** (páginas 6-10).~~
   **HECHO:** el 01/09 se comparó celda por celda contra `DHL_I_BIG`, que ya estaba cargada.
   **Coincide al centavo en las 1.500 celdas** — la de impo ya era esta.
4. ~~No está cargado en el sistema todavía.~~ **CARGADO el 01/09** — ver `TARIFA-DHL-MAS-50.md`.
