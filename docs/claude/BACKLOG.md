# BACKLOG — Nova Express Sistema

> Original de Felipe: `C:\Users\felid\Downloads\BACKLOG.md` (congelado al 29-jun-2026).
> **Esta copia es la viva.**
>
> **Tags:** `[GRANDE]` mucho trabajo · `[DELICADO]` toca pricing/DB · `[CHICO]` rápido
>
> Última actualización: **03-ago-2026**

---

## 🔴 Lo nuevo del 03/08 — "sobreescribir" una factura no reemplaza, duplica

**Análisis completo en `claude/PANEL-DE-SALUD.md`, sección 4.** Encontrado probando el panel de salud contra la base local.

- [ ] `[MEDIO]` **La carga de facturas duplica en vez de reemplazar.** Al subir una factura ya
  cargada, la app avisa y pide marcar *"sobreescribir"*. Pero `sobreescribir` **solo saltea el
  aviso**: no borra la carga anterior, inserta una segunda cabecera al lado. El nombre promete
  un reemplazo y lo que hace es un duplicado.
  **Estado real:** la factura UPS `0020-00074402` está cargada dos veces en la base local — 20
  filas de detalle para 10 guías. Toda suma sobre `factura_guias` cuenta esa plata dos veces:
  la pantalla de guías facturadas sin envío mostraba **8 guías por USD 3.077 cuando son 4 por
  USD 1.538**.
  **Ya mitigado:** el panel de salud lo detecta (chequeo 13) y el chequeo de guías sin envío
  ahora agrupa por guía, no por fila.
  **Falta decidir:** que "sobreescribir" borre de verdad la carga previa implica borrar datos,
  así que lo decide Felipe. Alternativa más conservadora: marcar la carga vieja como anulada
  en vez de borrarla.

---

## 🔴 Lo nuevo del 30/07 — la plata registrada no es la plata cobrada

**Análisis completo en `claude/IDEAS-COTIZACIONES-Y-BOT.md`, sección E.**

- [ ] `[GRANDE]` `[DELICADO]` **Registro de cotizaciones y precio acordado.** Caso real
  (Asaplast): se cotizó por 14 kg de volumen informados por el cliente, el cliente aceptó y
  **pagó** eso, y la caja terminó dando 10 kg. Administración cargó el envío en Salidas con
  las medidas reales usando el **cotizador automático**, que recalculó el precio hacia
  abajo. Resultado: en el sistema quedó guardado un precio distinto al que el cliente pagó,
  y **la liquidación estaba por salir con ese otro número**.
  **La raíz:** el envío tiene un solo campo de precio donde hacen falta dos —
  *precio acordado* (el de la cotización aceptada) y *precio recalculado* (el de las medidas
  reales). El cotizador automático de Salidas es lo que las separó; el proceso viejo no
  tenía este agujero. Pasa **para los dos lados** (también se registra de más cuando la caja
  da más de lo cotizado y se decide no reclamarlo).
  **Idea de Felipe:** guardar las cotizaciones con estado (aceptada / rechazada / vencida);
  si está aceptada, el envío toma **la plata** de ahí, y los pesos y medidas se pisan con
  los reales. **Propuesta a sumarle:** mostrar las dos cifras y la diferencia al cargar, y
  que la persona decida si la deja o la ajusta — el sistema nunca decide solo.
  **Preguntas abiertas antes de diseñar:** a qué clientes aplica (los de cuenta corriente se
  cotizan con la factura en mano, ahí no hay brecha), quién marca una cotización como
  aceptada, y si hay un umbral por debajo del cual ni se avisa.
  **Felipe pidió anotarlo para charlarlo, no para empezarlo.**

---

## 💡 Ideas nuevas de Felipe — para sentarse a diseñar prolijo

**Análisis completo en `claude/IDEAS-COTIZACIONES-Y-BOT.md`.** No están empezadas.

- [ ] `[GRANDE]` **Chatbot de cobranzas por WhatsApp** (modelo del aguatero: QR → WhatsApp → "cuánto debés y cómo pagar"). **El bloqueante no es el bot: es que el sistema hoy no sabe cuánto debe nadie.** Primero hace falta **cuenta corriente por cliente**; después el bot. Seguridad: el QR lleva un token por cliente; **nunca** que el bot pida un dato adivinable.
- [ ] `[MEDIO]` Estética de la cotización (logo Nova Express / Exportarlo, nombre del cliente) + botón "copiar como imagen" + **sacar la línea del profit de la tarjeta** (hoy se le puede estar mandando el margen al cliente en la captura; con la tarifa por kilo ahora también el precio por kilo).
- [ ] `[MEDIO]` Link de cotización autogestionada para el cliente.
- [ ] `[CHICO]` Cotizaciones en pesos con tipo de cambio cargado en Configuración.

---

## ⚠️ Necesitan decisión de Felipe

1. **Thresholds del cotizador** — el backlog dice "DHL lado más largo 120→116", pero el código usa **100 / 80**. ¿Cuál es el bueno?
2. **Surge de Israel** — Felipe lo dio por NO hecho, pero está implementado (`pf × 3.30` para Israel/EAU). ¿El pendiente era revisar si 3.30 sigue vigente?
3. **Conciliación cargo por cargo** — el desglose por cargo ya existe y se muestra (chips "Extracargos compra"). Lo que **no** existe es el enfrentamiento **estimado vs. facturado cargo por cargo**. ¿La pregunta era esa comparación?
4. **Pintado del envío sin factura** — se dio por cerrado con la columna Revisión de `a730d84`. Confirmar que era eso.
5. **Fuel "con un valor mínimo"** *(nueva, 30/07)* — al pedir el fuel propio por cliente, Felipe mencionó *"un porcentaje fijo con un valor mínimo"*. No está claro si es un fuel mínimo en USD, un piso de ganancia, u otra cosa. Hoy el fuel propio quedó como porcentaje y nada más.
6. **Contorno UPS > 400 cm** — hoy solo advierte, **no cobra los $120**. ¿Se cobra?
7. **Manejo adicional + contorno UPS** — hoy se cobran los dos en el mismo bulto (27,65 + 120). La regla comercial de UPS es que el de bulto grande reemplaza al de manejo. ¿Cómo es tu contrato?
8. **Percepción de IIBB en las facturas UPS** *(28/07)* — el parser detecta que la suma de las guías no cuadra con el total de la factura: en la de ejemplo faltan **USD 91,22** de percepción de Ingresos Brutos. ¿Esa percepción forma parte del costo del envío, o va aparte por ser un crédito fiscal recuperable? Hoy se guarda el subtotal, que deja el margen inflado ~3% en toda guía UPS. *(Desde el 03/08 los totales de la factura se guardan y el panel de salud marca la diferencia — pero la decisión de qué hacer con esa plata sigue abierta.)*
9. **Qué hace "sobreescribir" al cargar una factura ya cargada** *(nueva, 03/08)* — ver la sección de arriba. ¿Borra la carga previa o la marca como anulada?

**RESUELTAS (29-30/07), ver `claude/DECISIONES-PRICING.md`:** sobrepeso DHL · seguro DHL · documentos DHL · redondeo del peso facturable sobre el total (es a propósito, **no tocar**) · el IPF y los recargos del courier pasan a costo, sin margen.

**RESUELTA — Tracking UPS en español:** verificado el 27/07, el código de producción es idéntico al repo. **No está hecho en ningún lado.** Vuelve a abiertos.

---

## Correcciones de las verificaciones del 27-jul

- *"Pintar el envío como estimado / sin factura"* decía sin rastros; **está implementado** en `a730d84` (17/07).
- La conciliación cargo por cargo estaba subestimada: el detalle ya está en pantalla.
- **`envios.pickup_id` NO EXISTE.** Se había marcado ✅ leyendo `pickup_id` en la línea 240 de `schema.sql`, pero esa línea está adentro de **`cuadrantes`**. **El ítem vuelve a ABIERTO.**
- **Backup automático:** no hace falta cron. Ya corre dentro de la app, verificado en los logs de producción.
- **Los dos `.env` del VPS:** confirmado, `backend/.env` nunca se lee.
- **El mail NO es el canal con clientes** (ver `claude/CANALES.md`). El campo `email` vacío **no es un limitador**.

---

## Arreglado entre el 27/07 y el 03/08

Detalle en `claude/CAMBIOS-27-07.md`, `claude/RECARGOS-UPS-DHL-VERIFICACION.md`,
`claude/TARIFAS-DHL-ARRIBA-10KG.md`, `claude/MOTOR-UNICO.md`, `claude/TARIFA-POR-KILO.md`
y `claude/PANEL-DE-SALUD.md`.

- [x] Transacciones concurrentes serializadas · [x] "Recalcular" ya no borra el DDP · [x] Puerta trasera `forzar` eliminada
- [x] Cache busting unificado · [x] Fechas locales en frontend y backend · [x] 6 índices nuevos · [x] Purga de sesiones vencidas
- [x] **Parser de facturas UPS: los 6 bugs** — 44 tests en `npm run test-parser`
- [x] **Regla: los documentos solo se despachan por DHL**
- [x] **Recargos UPS/DHL verificados contra los PDF oficiales** — ISMEA a los 14 países que corresponden, China/HK/Macao, pieza no convencional DHL, Paquete de Mayor Tamaño UPS con el mínimo de 40 kg, área extendida vs. área remota
- [x] **Tarifas DHL arriba de 10 kg** — se reemplazó la fórmula por las tablas oficiales: 0 diferencias
- [x] **Motor único** — se eliminó el segundo motor de la liquidación y el `mkBultosProc` que no pasaba el peso facturable (era la divergencia de USD 102)
- [x] **Alarma de guía mal tipeada** — la celda se pinta en ámbar en Salidas
- [x] **Pantalla de guías facturadas sin envío**
- [x] **Pendientes de liquidar en orden alfabético** + se sacó el botón "Cotizar" por fila (recalculaba y nunca llegaba a la liquidación)
- [x] **Tarifa por kilo y fuel propio por cliente** *(30/07)* — ver `claude/TARIFA-POR-KILO.md`
- [x] **Los tests de pantalla pasaban de casualidad** *(30/07)* — 10 de ellos dependían de una base que quedaba en `/tmp` de la corrida anterior; en una máquina limpia fallaban todos. Arreglado con `backend/scripts/_base-test.js`.
- [x] **PANEL DE SALUD** *(03/08)* — 13 chequeos que corren solos + franja de aviso en el Dashboard. Ver `claude/PANEL-DE-SALUD.md`. 60 controles nuevos.
- [x] **Los totales de la factura UPS se guardan** *(03/08)* — `total_declarado`, `subtotal_factura` y `percepciones` en `facturas_cargadas`. El parser ya los calculaba y se perdían.
- [x] **`npm test` estaba en rojo desde el 30/07 sin que se notara** *(03/08)* — `test-motor-unico` exige una única versión del motor y `cotizador_courier_v8.html` se había quedado en `?v=20260730a`. Corregido.

---

## Pickups

- [ ] `[GRANDE]` Notificaciones push a Juanqui al teléfono — sin rastros. Ni siquiera hay refresco automático de pantalla. Telegram sería CHICO/MEDIO; WhatsApp Business oficial es GRANDE.
- [ ] Clasificación tamaño de caja (chico/mediano/grande) para Juanqui
- [ ] `[CHICO]` Duplicar un pickup recurrente — hoy los mismos clientes con los mismos horarios se cargan de a uno todas las semanas (~30-60 min/mes)
- [x] Checkbox "llevar plata" · "mostrar en Operaciones" · Estado "en camioneta" — ✅

## Cotizador

- [ ] `[CHICO]` Mostrar FOB / valor declarado en el desglose
- [ ] `[CHICO]` **El fuel del cotizador no sale de la base** — el campo no tiene valor por defecto ni llamada a configuración. Y `envios.js` arranca con un `39` hardcodeado. **Confirmado en producción: 4 envíos congelados en 39% cuando la config decía 33%.** *(Desde el 03/08 el panel de salud lo detecta solo, chequeo 5 — pero el hardcodeo sigue ahí.)*
- [ ] Evaluar API "Estimated Landed Cost Quoting" de UPS (paga)
- [x] Selector documento/mercadería — ✅ solo DHL y hasta 2 kg
- [x] El cartel de peso facturable por bulto ya no redondea a 0,5 — ✅ 29/07

## Salidas / Control de Facturas

- [ ] **Carga múltiple de PDF UPS** (~13 juntas a fin de mes) — de a uno hoy. *Felipe pidió dejarlo para más adelante.*
- [ ] `[GRANDE]` Soporte para facturas de DHL — el parser es 100% UPS. En junio fueron 16 UPS / 7 DHL: **un tercio de los envíos no se concilia contra nada.**
- [ ] `[MEDIO]` **"Sobreescribir" duplica en vez de reemplazar** — ver la sección de arriba (03/08).
- [ ] Flag "Balde B" para recargos inesperados — confirmado que NO está.
- [ ] **Bandeja de revisión: mostrar también las "pendiente"** — hoy filtra solo `a_revisar` y `reclamar`, así que la mayoría queda pendiente para siempre y no hay forma de cerrar un mes.
- [~] `[GRANDE]` Conciliación estimado vs. real cargo por cargo — ver decisión #3
- [x] Checkbox DDP en el modal de edición de Salidas — ✅ 29/07
- [x] Cartel de guía duplicada · Alertas configurables · Pintado del envío sin factura — ✅
- [x] **Parser de facturas: los 6 bugs** — ✅ 27-28/07
- [x] **Los totales de la factura se guardan** — ✅ 03/08

## Clientes

- [x] `[GRANDE]` Márgenes por courier y rango de peso — ✅ completo
- [x] `[GRANDE]` **Tarifa fija por kilo y fuel propio por cliente** — ✅ 30/07
- [ ] **Cargar los datos**: **64 de 91 clientes sin margen configurado** y solo **4** con matriz de profit. El profit automático del cotizador sirve para 4 clientes. *(El panel de salud lo cuenta solo desde el 03/08.)*
- [ ] `[CHICO]` **Unificar duplicados y prevenirlos**: `GERSCOVICH`/`Gerscovich` (36/37) y `OPEN POLO`/`Open Polo` (68/69). *(El panel los detecta; falta unificarlos y poner el candado.)*
- [ ] `[MEDIO]` **Cuenta corriente por cliente** — hoy no existe: `cobranzas` es un registro suelto sin vínculo con liquidaciones. Prerequisito del chatbot de cobranzas.

## Liquidaciones

- [ ] `[CHICO]` **Botón para borrar un borrador de liquidación** — hoy no existe endpoint de borrado. Es lo que obliga a que Felipe tenga que limpiar los borradores #12 y #30 a mano.

## Tracking UPS

- [ ] Traducir los estados al español — **confirmado que no está hecho**
- [ ] Tracking automático — hoy es 100% manual y no persiste nada. La infraestructura ya existe; falta un job y una columna.

## Dashboard

- [x] **Panel de salud** — ✅ **03/08**. 13 chequeos + franja de aviso. Ver `claude/PANEL-DE-SALUD.md`.
- [ ] **Que el panel de salud avise solo, sin abrir el sistema** — hoy se calcula cuando alguien entra. Falta un job diario que le mande el resumen a Felipe (Telegram sería lo más barato de probar).
- [ ] **Visibilidad del mes en curso** — 118 de 134 envíos de julio no tienen precio de venta (se carga al liquidar), así que el dashboard no muestra utilidad del mes en curso.
- [ ] Expansión de métricas (pendiente reunión)
- [x] Backup automático — ✅ ya corre solo

## Técnico / Infraestructura

- [ ] 🔴 **Limpiar los borradores de liquidación #12 y #30** — envíos 31 y 147 en un borrador y en una confirmada. Confirmar el #12 refactura **USD 2.225**. Después de limpiarlos, agregar el índice único que lo impida (no antes: haría fallar el arranque).
- [ ] 🔴 **Backups solo en el VPS** — 9 archivos, mismo disco, sin copia externa. *(Desde el 03/08 el panel avisa si el backup deja de correr o encoge — pero la copia externa sigue sin existir.)*
- [ ] **4 filas huérfanas en `envio_bultos`** (53-56), del script de vaciado del 30/06.
- [ ] **Deuda técnica: relación pickup↔envío** — **REABIERTO**. `envios.pickup_id` no existe. El vínculo se resuelve con un `UPDATE` por cliente + fecha, que marca de más si un cliente tiene dos envíos el mismo día. Además obliga a re-tipear ~20 campos que ya estaban en el pickup.
- [ ] **Registro de quién hizo qué** — 8 usuarios activos y ninguna auditoría.
- [ ] `[CHICO]` **Mover `cotizador_courier_v8.html` a un `_legacy/`** — el prototipo viejo de 24 KB convive con el motor real, y el 30/07 le costó al test suite una falla que estuvo cuatro días sin verse.
- [ ] `[CHICO]` **`test-guias-sin-envio.js` usa el puerto 3999** — que es un puerto de desarrollo plausible. Si hay un server local ahí, el test le habla a ese y falla con `no such table: usuarios`, que no tiene nada que ver.
- [ ] **Dos tests en rojo desde antes del 03/08**: `test-orden-pendientes` (3 pasan / 2 fallan) y `test-aviso-guia` (8 / 4). Verificado contra una copia limpia del repo: no son regresiones nuevas. Falta revisarlos.
- [ ] Sacar la base SQLite del sync de OneDrive (local) — el `-wal` tiene 1,15 MB sin checkpointear.
- [ ] Borrar `backend/.env` del VPS — copia muerta de las credenciales de UPS.
- [ ] Login sin límite de intentos ni bloqueo. Contraseña mínima de 6 caracteres sin requisitos.
- [ ] El frontend de Salidas pisa el profit real con el estimado en envíos ya conciliados.
- [ ] Campos de plata sin validar: tipear `1250,50` con coma guarda NULL y el profit salta solo. Una zona inválida guarda el envío con todos los costos en NULL.
- [ ] `salidas.js` tiene 2828 líneas en un solo bloque — propuesta de corte en 8 archivos en `claude/AUDITORIA.md`.
- [ ] Revisar el escalón de los 32 kg en el tarifario — hace falta que Felipe diga qué había que revisar
- [x] `NODE_ENV=production` en el VPS — ✅ 27/07
- [x] Editar el flete — ✅ está en `SALIDAS_EDITABLE`
- [x] **Envío editado no recalculaba el costo** (utilidad fantasma) y descartaba DDP / remota / asegurado / tipo_paquete — ✅ 29/07
- [x] **Tests del motor de pricing** — ✅ 385 controles automatizados, de los cuales ~200 sobre el cálculo

## Sin alcance cerrado

- [ ] `[GRANDE]` Integración GECOM — Felipe lo ve como **otro escalón**, no ahora.

---

## Decisiones tomadas (no re-abrir sin motivo)

- Salidas Excel DHL columna SEGURO mezcla seguro real + GoGreen (17,50 + 4,90 = 22,40). **Dejar como está.**
- Multi-bulto: una fila por bulto con medidas y peso individuales.
- **El redondeo del peso facturable se hace sobre el TOTAL del envío, no bulto por bulto.** Es a propósito y ya estaba corregido. **No tocar.**
- Cuadrantes de Operaciones: +/- manual, **no** enganchado a envíos reales.
- El tilde verde de revisión **lo pone solo un humano**, nunca el auto-marcado.
- Frontend **sin frameworks**, vanilla.
- **La liquidación no recotiza:** lee los valores congelados del envío. Por eso se sacó el botón "Cotizar" por fila.
- **Los recargos del courier (IPF, surge, DDP) pasan a costo**, sin margen ni fuel encima.
- Las migraciones viven en `db/index.js`, no en archivos numerados. Al agregar tabla, columna o índice: migración ahí **y** reflejarlo en `schema.sql`. `npm run check-schema` lo verifica.
- **Con clientes se habla por WhatsApp, no por mail.** El mail es el canal con UPS y DHL.
- **El panel de salud SOLO LEE.** Avisa; la corrección la hace una persona. Un chequeo que falla se reporta como roto, nunca desaparece. Cada alerta linkea a donde se arregla. *(03/08 — ver `claude/PANEL-DE-SALUD.md`, sección 3.)*
- **`ver_salud` es un permiso aparte de `ver_dashboard`**: el Dashboard muestra la plata que se hizo, el panel de salud muestra lo que está roto.

---

## Cerrado (referencia, no re-agregar)

**Antes del 29-jun:** fuel_pct por envío · DDP checkbox en Cargar envío · Clientes campo "nombre" · Operaciones carry-forward · Operaciones cuadrantes +/- · Salidas observaciones inline · Salidas scroll horizontal · Salidas dimensiones/peso por bulto · Liquidaciones reconstruido · Semáforo Salidas multi-bulto · Tracking UPS en producción · HTTPS + dominio · Cotizador unificado en `cotizador-core.js`.

**Entre el 29-jun y el 27-jul** (no figuraba en el backlog):

- **Cobranzas** — backend (`caf664c`) y frontend con totales por moneda (`2edef37`)
- **Área remota** — flag con recargo persistente (`7f97681`)
- **Profit automático por cliente** en el cotizador (`c5d05c1`), sobre la matriz en 3 etapas del 02/07
- **Permiso de editar configuración por usuario** (`bd69ca3`) y módulo Configuración unificado (`d82b180`)
- **Dashboard**: desvío de cotización y plata en disputa (`c2584b4`, `abb2622`), utilidad real contra costo facturado (`b9aec3a`), utilidad por envío con selector de mes (`25ad663`)
- **Salidas — bloque de julio**: columnas sticky (`76d4e65`), scroll flotante (`12e0c25`), fila expandible con desglose (`b34c0ba`), comparación contra lo facturado con semáforo por tolerancia (`3556937`) y por monto (`5639668`), bandeja de revisión (`a730d84`), franja UPS (`b91e18f`), sin paginado
- **Facturas**: detalle por guía en `factura_guias` (`fd84943`)
