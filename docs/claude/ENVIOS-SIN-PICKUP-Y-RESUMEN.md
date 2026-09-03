# Envíos sin pickup + el resumen de Pickups

**Pedidos de Felipe (de operaciones y de la vista de Pickups), 26/08/2026.**
Entregado con `?v=20260826c` · tanda nueva `test-operaciones-sueltos` (22 controles).
⚠️ Al escribirse esto, el paquete estaba SIN COMMITEAR (el puente al dispositivo se cortó
justo al entregar; el .tgz quedó en la conversación). Verificar `git log` antes de asumir.

---

## 1. Envíos sin pickup (pedido de la gente de operaciones)

**El caso:** una importación no la pasa a buscar nadie, así que no existe en Pickups — pero
operaciones la necesita en su módulo para saber si están los datos, la guía y la proforma.

**Cómo quedó:** botón **"+ Envío sin pickup"** arriba de la lista de Operaciones. Cliente +
descripción, y la tarjeta aparece en el día con los cuatro checks de siempre y el arrastre
de rezagados. Cabecera gris *"📄 Sin pickup (impo / ya está acá)"*. Botón "✕ quitar" para
deshacer una cargada por error.

**Por dentro** es un pickup de `tipo_recoleccion='ninguna'`, estado `'sin_recoleccion'`
(terminal, como courier), `mostrar_en_operaciones=1`, dirección y horas neutras ('—',
00:00). Reusar la tabla fue a propósito: hereda checks, rezagados y el PATCH de operaciones
sin duplicar nada.

**La regla que lo sostiene:** el GET de la pantalla de **Pickups lo excluye SIEMPRE**
(`COALESCE(tipo_recoleccion,'normal') != 'ninguna'`). Ahí se organiza a los choferes, y
esto no lo mueve ningún chofer — si se filtrara mal, saldrían a buscar recolecciones que no
existen. Control rojo en el test.

Rutas: `POST /api/operaciones/sueltos` · `DELETE /api/operaciones/sueltos/:id` (**solo**
borra tipo 'ninguna': un pickup de verdad por esta puerta da 400).

## 2. El resumen de Pickups ya no confunde

**El caso:** un pickup "lo trae el cliente" o "lo levanta UPS/DHL" contaba como **"sin
confirmar"** en el resumen del día y la tarjeta decía **"Sin asignar"** — el día estaba
completo y la pantalla decía que faltaba alguien.

**Cómo quedó:** los contadores del resumen (`sin confirmar / Ricardo / camioneta /
depósito`) cuentan **solo los pickups con cadena de chofer**. Los cliente/courier tienen su
propia cuenta gris (`◼ N cliente/courier`) que solo aparece si hay alguno. Y la tira de la
tarjeta (y el chip de la vista semana) dice **quién lo mueve** — "Lo trae el cliente" /
"UPS/DHL" — en vez de "Sin asignar".

## También en este paquete (pedidos de la misma tarde, mismo estado)

- **Cargar envío:** el 🧮 cotizador automático va ARRIBA del panel 📄 de cotizaciones del
  cliente (el automático se usa más). Control de orden real en el DOM.
- **El seguro se tilda solo** con FOB ≥ 100 (el motor cobra desde 100 exacto) y se destilda
  abajo de 100. Si administración toca la tilde **a mano**, el automático no la pisa más
  (`seguroTocado`, mismo patrón que `profitTocado`). Al editar un envío existente, lo
  guardado manda.

**`npm run verificar`: 47 tandas · 1313 controles · 0 fallas** en el contenedor.
