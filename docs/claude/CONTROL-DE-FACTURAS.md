# Control de facturas — guías sin envío y guías mal tipeadas

Estado al 29/07. Todo probado, en el repo. Las tablas de facturas están **vacías** en
producción: esto arranca a servir en la primera carga real, a fin de mes.

---

## 1. Pestaña "Sin envío" en Control de Facturas

**Qué muestra:** cada guía que el courier facturó y que no tiene envío cargado en el sistema.
Cada fila es una de dos cosas:

- un envío que **nunca se cargó** → nadie se lo facturó al cliente: plata pagada y no cobrada
- una guía **mal tipeada** al cargar el envío

**Por qué hacía falta:** el backend ya las venía guardando (`factura_guias.encontrada = 0`),
y hasta había una lista en pantalla — pero **solo aparecía en el resumen del momento de
cargar la factura**. Al salir de esa pantalla no se volvían a ver nunca. La información
estaba y nadie la miraba.

**Dónde está:** Control de Facturas → pestaña **Sin envío**. El número de guías pendientes
se ve en el rótulo de la pestaña sin necesidad de abrirla. Muestra guía, factura, país, peso,
costo, y el total de plata que representan.

### El "¿quisiste decir?"

Cuando una guía facturada no aparece, el sistema busca entre los envíos **sin factura cruzada**
uno con un número casi igual (hasta 2 caracteres de diferencia) y lo muestra al lado:

```
factura: 1Z327W096797411680
sistema: 1Z327W096797411689   ← 1 caracter de diferencia
```

Así, en vez de "esta guía no existe", la oficina ve directamente cuál envío corregir.
La comparación se corta apenas supera los 2 caracteres, así que no inventa parecidos: en la
prueba, las guías que no se parecen a nada quedan sin sugerencia.

**Es solo lectura.** No vincula ni modifica nada: la corrección la hace una persona editando
la guía del envío. Fue a propósito — tocar costos automáticamente a partir de una sospecha es
exactamente lo que no hay que hacer.

`npm run test-guias-sin-envio` (14 pruebas, carga la factura real contra una base preparada)
y `npm run test-pantalla-sin-envio` (8 pruebas en navegador).

---

## 2. Aviso de guía mal tipeada

Los números de guía llevan un **dígito verificador** calculado a partir del resto del número.
Si alguien se come un carácter, cambia uno o cruza dos, la cuenta no cierra. Se detecta al
instante, sin conexión y sin depender de ninguna API de UPS o DHL.

- **UPS**: 1Z + 16 caracteres. Los 15 del medio se convierten a número, se duplican los de
  posición par, se suman, y el último dígito es lo que falta para la decena.
- **DHL**: 10 dígitos; el último es el resto de dividir los 9 primeros por 7.

**Dónde se ve:** un ícono ámbar en el renglón de Salidas (con el motivo al pasar el mouse) y
un aviso debajo del campo en Cargar envío. **Avisa, nunca bloquea** — una guía con formato
raro puede ser legítima, y frenar la carga por una sospecha sería peor que el problema.

### Verificación

De las **142 guías UPS reales, 136 validan**. Las 6 que no son errores de tipeo comprobables:

```
1Z327W0970490762735   un caracter de mas    01/07  Reino Unido
1Z327W06792853864     un caracter de menos  15/07  Espana
1Z32W7096798445697    "32W7" en vez de "327W"  03/07  Sudafrica
1Z32W7096793613086    "32W7" en vez de "327W"  03/07  EE.UU.
1Z327W096795635137    un digito cambiado    15/07  EE.UU.
1Z327W096794195617    un digito cambiado    20/07  EE.UU.
```

Las 16 de DHL validan todas. **No se corrigió ninguna**: son datos de la oficina.

Las dos cosas se cruzan: cuando estas guías mal tipeadas aparezcan en la factura de UPS, van a
caer en la pestaña "Sin envío" con su "¿quisiste decir?" apuntando al envío correcto.

`npm run test-validar-guia` (22 pruebas) y `npm run test-aviso-guia` (8 en navegador).

---

## Dos tropiezos propios, anotados para no repetirlos

**El test corría contra la base equivocada.** La primera versión de `test-validar-guia`
barría la base de desarrollo del repo, que tiene guías inventadas (`1414141414141`), y las
contaba como errores. Esa parte pasó a ser un **informe**, no una prueba: lo que valida el
algoritmo son casos fijos escritos a mano.

**Los archivos `-wal` de SQLite sobrevivían entre corridas.** Al copiar la base de producción
a `/tmp` para una prueba, quedaban el `-wal` y el `-shm` de la corrida anterior y se
reaplicaban encima de la copia nueva. Resultado: filas fantasma y una prueba que fallaba con
un `409` inexplicable. **Al copiar una base SQLite hay que llevarse o borrar el `-wal` y el
`-shm`**, si no la copia no es lo que uno cree.
