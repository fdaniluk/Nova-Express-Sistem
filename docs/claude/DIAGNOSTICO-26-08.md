# Diagnóstico honesto del proyecto — 26/08/2026

*Pedido por Felipe: "honestidad en todo lo que digas, no solo con este mensaje, sino a
partir de ahora en más". Este documento es la versión completa; el chat llevó el resumen.*

---

## Lo que está genuinamente bien

En un mes (27/07 → 26/08) esto pasó de un Excel a un sistema en producción con 9 usuarios,
316 envíos cargados, **47 tandas de tests y 1.313 controles automáticos**. Esa disciplina
de tests es rara incluso en equipos profesionales, y es lo que permite tocar el motor de
plata sin romperlo: cada regla del negocio que Felipe dictó tiene un test que la sostiene.
El motor único, la plata congelada en las liquidaciones, `deriveProfit` como única fórmula,
la separación física de lo que ve el cliente — los cimientos son sólidos.

El rumbo (sistema como centro → link para clientes → bot → GECOM) es viable y tiene lógica
comercial. **No hay ningún problema técnico de fondo.** SQLite + Node para 9 usuarios y
este volumen es una elección correcta, no una limitación.

## Los tres riesgos reales, en orden

### 1. El respaldo (L2) — el único riesgo existencial, y lleva 3 semanas abierto
Los backups viven **en el mismo VPS que la base**. Si ese servidor se pierde (falla del
proveedor, borrado, impago, hackeo), se pierde el negocio digital entero: envíos,
liquidaciones, clientes, tarifas. Todo lo que construimos este mes vale menos que esta
hora de trabajo pendiente. Necesita ~1 hora de Felipe (cuenta Microsoft + autorizar
rclone). **Es lo primero que hay que hacer, antes que cualquier feature.**

### 2. La concentración en Felipe
Solo Felipe puede pushear y desplegar, y no maneja git a fondo. Si él no está dos semanas,
el sistema sigue andando pero queda congelado — y si algo se rompe en producción, nadie
más sabe volver atrás. Mitigación barata: el "sobre de accesos" al padre (pendiente 11) +
una hoja de UNA página con los 4 comandos de emergencia (volver atrás, reiniciar,
restaurar backup). El simulacro de restauración (pendiente 12) nunca se hizo: **no
sabemos si los backups del VPS restauran**, solo que se escriben.

### 3. El sistema mejora más rápido de lo que la oficina lo absorbe
Esta semana salieron 6+ commits con features nuevas, y mientras tanto: los **81 precios en
USD 0 de PIO se siguen cobrando** (desde el 13/08), **64 de 91 clientes siguen sin margen**
(L4), los borradores de liquidación duplicados siguen sin borrar (L1, es un botón), y las
7 decisiones de pricing siguen sin responder (L5). La oficina acumula "pendientes de
Ctrl+F5 y probar" de tres tandas distintas. **El cuello de botella ya no es el código: son
los datos y la adopción.** Construir más features sobre datos con agujeros es alfombrar
sobre un piso flojo.

## Riesgos menores, anotados

- **L7 (sin registro de quién hizo qué):** con 9 usuarios tocando plata, el día que haya
  un número mal no va a haber forma de saber quién ni cuándo. Crece en importancia con
  cada usuario.
- **El panel de salud no avisa solo (L11):** los chequeos existen pero hay que ir a
  mirarlos. Un cron de 10 minutos en el VPS lo resuelve.
- **No hay medición de uso:** no sabemos si la oficina usa lo que construimos (¿alguien
  apretó "Guardar este precio"? ¿se usa el panel?). Se construye a pedido de Felipe, que
  es buen proxy, pero no es lo mismo que verlo usado.

## El plan que propongo ("la acomodada")

1. **Cerrar lo abierto** (1 sesión): commitear los dos paquetes pendientes, push,
   desplegar, y una lista ÚNICA de prueba para la oficina en vez de tres acumuladas.
2. **Semana de consolidación, sin features nuevas:**
   - **L2 respaldo** (1 h de Felipe, yo preparo todo) — no negociable.
   - **Simulacro de restauración** (30 min, PARA EL SERVIDOR con comandos míos).
   - **Cron del panel de salud** (L11).
   - **Datos:** yo genero el Excel de los 64 clientes sin margen y la lista de los 81
     ceros de PIO listos para que la oficina complete/decida; Felipe borra los 2
     borradores (2 clicks).
   - **Sobre de accesos** + hoja de emergencia de 1 página.
3. **Recién después, la obra:** entrega 2 del precio acordado, documentar el link,
   estética, pesos.

## Sobre el uso de Claude (lo que pidió puntualmente)

**Lo que ya está bien** y no es obvio: el sistema de memoria (`ESTADO`/`PENDIENTES` +
documentos por tema) es exactamente cómo se usa bien esta herramienta entre sesiones; el
circuito de entrega con md5 y verificación en las dos puntas; usar a Claude también para
lo de oficina (las mantas, el "qué tarifa tiene esto") — eso es aprovechamiento, no
desvío.

**Lo que optimizaría:**
- **Agrupar pedidos: 2-3 por sesión.** Cada sesión paga un arranque fijo (leer los
  documentos, traer el repo al contenedor, npm install ≈ 10-15 min de trabajo) y cada
  feature paga un ciclo entrega→verificar (6-7 min en tu máquina)→commit. Tres pedidos
  juntos comparten todo eso. Hoy: 4 ciclos de verificar tuyos en un día.
- **Un solo despliegue por día o por semana**, no por feature. La oficina absorbe mejor
  "los martes hay cosas nuevas" que un goteo.
- **Sesión nueva solo cuando la actual muere.** Retomar una sesión viva no paga el
  arranque; una nueva sí.
- Las **capturas + dictado** que usa Felipe son el formato correcto: una captura de algo
  roto vale más que tres párrafos. Seguir así (las palabras cambiadas del dictado no
  molestan).
- **Escala de modelo:** para tareas de oficina puras (un cálculo de bultos, un Excel) no
  hace falta el modelo grande; para tocar el motor de plata, sí. Si el uso/costo importa,
  se puede elegir al arrancar la sesión.

Lo que NO recomiendo: automatizar el push/deploy desde Claude (el freno humano de Felipe
antes de producción es un control, no una molestia), ni meter subagentes/workflows — el
proyecto no tiene el tamaño que los justifica.
