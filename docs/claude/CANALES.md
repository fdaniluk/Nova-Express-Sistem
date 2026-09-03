# Canales de comunicación de Nova Express

> Aclarado por Felipe el 27/07/2026. **Corrige una suposición equivocada** de la auditoría, que había asumido que las liquidaciones se mandaban por mail.

## Cómo es en realidad

| Con quién | Canal | Para qué |
|---|---|---|
| **Clientes** | **WhatsApp** (casi siempre) | Liquidaciones, avisos, consultas, coordinación. Es *el* canal con el cliente. |
| **UPS y DHL** | **Mail** | Consultas, reclamos, trámites (ej. el retorno de impuestos), y por ahí llegan las facturas. |

El mail de la empresa **no es el canal con clientes**.

## Qué cambia esto

### 1. El campo `email` de clientes no es un limitador

La auditoría marcó "87 de 91 clientes sin email" como algo que bloqueaba automatizar el envío de liquidaciones. **No aplica**: ese envío no va por mail. El campo puede quedar vacío sin consecuencias.

Lo que **sí** sigue siendo limitador de esa tabla es otra cosa: **64 de 91 clientes sin margen configurado y solo 4 con matriz de profit**. Eso es real y bloquea el profit automático del cotizador.

### 2. WhatsApp deja de ser "una idea para más adelante"

En la primera lectura del proyecto, el bot de WhatsApp figuraba como una capa opcional a futuro. Con esta aclaración cambia de lugar: **es el canal por donde ya pasa la relación con el cliente, hoy, a mano.** Todo lo que se automatice hacia el cliente pasa por ahí o no pasa.

Eso reordena la evaluación de esfuerzo. Antes tenía sentido decir "empezá por Telegram, que es barato" — y para las notificaciones internas a Juanqui **sigue valiendo**, porque es comunicación puertas adentro. Pero para el cliente, Telegram no sirve: nadie va a instalarlo. Ahí la única opción real es WhatsApp Business API, con lo que implica (verificación de empresa, plantillas pre-aprobadas, un proveedor).

**Conclusión práctica:** dos canales distintos para dos usos distintos, y no compiten.

- **Interno (Juanqui, el equipo):** Telegram o similar. Barato, rápido de probar.
- **Externo (clientes):** WhatsApp. Más caro de montar, pero es donde ya está la conversación.

### 3. El mail abre otra automatización que no estaba en la lista

Si las facturas de UPS y los trámites llegan por mail, la carga de facturas —hoy manual, de a un PDF, 13 veces a fin de mes— podría empezar antes: leer la casilla, detectar los PDF de factura y dejarlos listos para procesar. No está evaluado todavía; queda anotado como idea.

## Riesgo a tener presente

Mandar liquidaciones automáticamente por WhatsApp es **exactamente** el tipo de automatización donde un error llega directo al cliente, sin que nadie lo vea antes. Hoy, si el sistema calcula algo mal, alguien lo mira antes de mandarlo. Automatizado, no.

Por eso, cuando se llegue a ese punto: botón explícito con vista previa del destinatario y del contenido, **nunca** como efecto automático de confirmar una liquidación.
