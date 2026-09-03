# Las cotizaciones del cliente en la carga del envío

**Idea de Felipe, 25-26/08/2026 · commits `e09c117` → `19dc073` → `e3f5cca`.** Reemplaza a
"la vuelta de tuerca" que estaba anotada como pendiente 1 — que al final también se hizo,
pero por el motivo correcto (ver "la lista", abajo).

---

## De dónde salió

Veníamos con la lista de cotizaciones guardadas abajo del cotizador y la idea de mudarla al
perfil del cliente. Felipe cortó eso con una observación mejor:

> *"pocas veces uno va a volver al perfil de cliente para hacer una cotización, sino lo que
> estaría bueno es que a la hora de estar en la parte de la carga del envío haya alguna
> parte en la que uno pueda acceder a las últimas cotizaciones de ese cliente… acá veo que
> fueron a esta zona y tiene esta medida, entonces debe ser este envío."*

**El problema no era dónde guardar la lista, era cuándo se necesita.** Y se necesita en un
solo momento: cuando administración está cargando el envío y tiene que saber por cuánto se
le cotizó a esa persona.

De paso resuelve la parte difícil de la entrega 2 del precio acordado. Estaba pensada como
que el sistema adivinara qué cotización corresponde a cada envío; así es mejor: **el sistema
muestra las candidatas con los datos para reconocerlas y la oficina elige con el ojo**. No
decide nada, así que no se puede equivocar.

---

## Las decisiones de Felipe, en orden

| | Qué se eligió |
|---|---|
| **Al elegir una cotización** | *"solo escribe el precio como un sugerido, se debería de poder modificar sin problemas"*. El envío **no** queda atado a la cotización. |
| **Dónde** | En **Cargar envío**. En **Salidas** también, pero *"que no moleste — que solo aparezca parándose en el precio de venta"*. |
| **La marca** | Apagada por defecto; **por opción, no por cotización** (*"si lo pongo en el general me guarda tres innecesariamente"*). |
| **La ventana** | **30 días corridos**, textual: *"no mes calendario"*. |
| **El control** | **Un botón, no una casilla** (*"apenas se ve que está tildado"*), y **afuera de la tarjeta** (*"contamina la vista"*). |
| **El guardado** | **Directo**: el botón guarda, sin paso aparte. Y **fuera** el botón verde y la lista del cotizador. |

---

## La lección del 26/08: el guardado directo

Felipe probó el circuito y el panel le quedó vacío "sin motivo". El motivo era una trampa
de diseño: **marcar el botón no guardaba nada** hasta apretar un "Guardar cotización"
aparte. Un guardado que depende de acordarse de un segundo botón se va a olvidar siempre.

Ahora **"Guardar este precio" ES el guardado**: el primer click crea la cotización (entera,
con todas las opciones — es el respaldo) con esa opción marcada, y muestra el **CTZ-n**
abajo del botón como confirmación. Los clicks siguientes (marcar otra, desmarcar) **editan
las marcas de la misma cotización** vía `PATCH /api/cotizaciones/:id/marcas` — no una CTZ
nueva por cada dedo. Recotizar corta: la próxima marca abre otra. Si el guardado falla (o
cancelan el nombre del cliente), **el botón vuelve solo al estado anterior** — un botón
prendido con la base sin enterarse es exactamente la mentira que rompió el circuito.

Sin cliente elegido sigue pidiendo el nombre por prompt (se cotiza a gente que aún no es
cliente).

**Estados del botón:** sin marcar = borde punteado gris `+ Guardar este precio`; marcado =
violeta Nova lleno, ✓ naranja, `Guardado para el envío`. No verde: el verde de esa pantalla
ya significa ganancia. Vive en la **columna de oficina**, debajo del panel de compra, y hay
un test que exige `.result-card .btn-viaja` = 0 (nada nuestro adentro de la tarjeta, la
misma regla que sacó el profit el 20/08).

---

## La lista vive en el perfil del cliente

Del cotizador **se fue** (el botón verde y la card "Cotizaciones guardadas", con sus
estilos y su JS). No podía desaparecer del sistema: **ahí vive el botón Aceptar**, el único
lugar donde se marca qué opción confirmó el cliente — el precio acordado del caso Asaplast.

Ahora es la card **"Cotizaciones"** del perfil del cliente (`card-cotizaciones`): filtro
por estado, Aceptar por opción / Rechazar / Desmarcar, y un **▸ que abre la tabla que se
le envió** (flete, surge, fuel, extras, total por servicio — sin nuestro costo), para
reenviarla. Las opciones no enviadas aparecen rotuladas "(no enviada)".

---

## El panel de Cargar envío y Salidas

Una fila por cotización: **CTZ-n · fecha · estado**, **destino · zona · expo/impo**, y
**peso facturable · medidas · FOB** en gris. A la derecha, un botón por servicio con su
precio; apretarlo escribe el número en el campo de venta como **sugerido**.

- **Cargar envío:** a la vista, arriba del cotizador automático. Sigue al cliente elegido.
- **Salidas:** cerrado; se abre al pararse en "Total cobrado" y se cierra al abrir otro
  envío. El precio entra por el camino de una edición a mano: profit y % se re-derivan.

El panel **nunca manda nuestro costo ni la ganancia**: se filtran en el servidor.

⚠️ **Compatibilidad:** las cotizaciones guardadas ANTES de la marca por opción quedaron con
`viaja_al_cliente=1` pero ninguna opción marcada — la primera versión las dejaba
**invisibles** (le pasó a Felipe probando el circuito). Regla: si ninguna opción conoce la
marca, viajan todas. Vive en `recientesDeCliente()` y espeja la de `crear()`.

---

## Lo que se tocó

**Base:** `cotizaciones.viaja_al_cliente` (0/1) + la marca `viaja` en cada opción del JSON.
**Backend:** `GET /cliente/:id/recientes?dias=30` · `PATCH /:id/marcas`
(`actualizarMarcas`, con historial `marcas_historial`) · modelo/controlador/rutas.
**Frontend:** `frontend/js/cotizaciones-recientes.js` (componente compartido) · `api.js` ·
`envios.js` · `salidas.js` · `clientes-perfil.js` + su HTML (la card nueva) ·
`cotizador.html` (guardado directo; fuera barra verde, lista y sus estilos).

⚠️ `main.css` pone todas las `<label>` en mayúsculas con espaciado: cualquier texto suelto
en una label necesita `text-transform:none`.

**Cache busting: `?v=20260826`** en las 17 páginas.

---

## Pruebas

- `test-cotizaciones-recientes` — **37 API + 25 navegador**: sin marcar no aparece; no se
  escapa el costo ni la ganancia; 30 días corridos; clientes no se mezclan; marca por
  opción; **compatibilidad con las migradas**; el botón fuera de la tarjeta; **un click
  guarda y muestra el CTZ-n**; Salidas no molesta; el precio se pisa.
- `test-pantalla-cotizaciones` — **26 controles, rehecho**: el cotizador quedó limpio (ni
  botón verde ni lista); **un solo click guarda** y lo guardado = lo que dicen las
  tarjetas; marcar otra opción edita la MISMA cotización y recotizar abre una nueva; **el
  circuito cierra** (la cotización aparece en el panel del cliente); la lista del perfil
  con Aceptar, precio acordado de la opción aceptada, desglose y filtro.
- **`npm run verificar`: 46 tandas · 1285 controles · 0 fallas**, contenedor y máquina de
  Felipe.

---

## Lo que quedó afuera, a propósito

- **El envío no queda atado a la cotización.** El precio es sugerido y nada más; la
  **diferencia acumulada por cliente** (*"tenés diez kilos a favor"*) sigue sin existir.
  Las columnas de `envios` (`cotizacion_id`, `precio_acordado`, …) siguen en NULL. Es la
  entrega 2.
- **Rechazar/desmarcar desde el cotizador.** El estado se maneja desde el perfil.
