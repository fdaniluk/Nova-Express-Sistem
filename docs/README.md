# docs/ — la memoria del sistema, adentro del repo

Desde el 03/09/2026 la documentación del proyecto viaja con el código.

## Qué hay acá

- **`claude/`** — los documentos de trabajo: `ESTADO.md` (cómo se trabaja, las reglas, dónde
  está cada cosa), `PENDIENTES.md` (qué falta y qué se decidió), y un documento por cada
  tema grande (auditorías, tarifas, decisiones de pricing, manuales, recuperación, etc.).
  Son la explicación de POR QUÉ el sistema es como es. El código dice qué hace; esto dice
  por qué se decidió así y qué se descartó.
- **`manuales/`** — los manuales visuales para la oficina (Word) y la hoja de extracargos.

## De dónde salen y cómo se mantienen

La copia de trabajo de estos documentos vive en el proyecto "Sistema Nova" de claude.ai,
que es donde Claude los lee al arrancar cada sesión y los actualiza al cerrarla. **Esta
carpeta es la copia de resguardo**: hasta el 03/09 la memoria vivía solo en claude.ai, y
si se perdía la cuenta o el proyecto, se perdía entera. Ahora está también acá, y por lo
tanto en GitHub con cada push y en el VPS con cada deploy.

Regla de operativa: **cada vez que se actualiza un documento en el proyecto de claude.ai,
se vuelca también acá y se commitea.** Si alguna vez las dos copias difieren, la del
proyecto de claude.ai es la más nueva salvo que el commit diga lo contrario.

## Si un día no está Claude

Todo lo que hace falta para seguir está en este repo: el código con sus comentarios, las
62 tandas de prueba (`backend/scripts/test-*.js`, se corren con `npm run verificar`
dentro de `backend/`), y esta carpeta. Empezar por `claude/ESTADO.md`.
