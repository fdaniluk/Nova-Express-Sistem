# database/migrations/

**Esta carpeta está vacía a propósito.** Las migraciones de este proyecto no viven acá.

## Dónde viven realmente

En **`backend/src/db/index.js`**. Ahí hay una serie de funciones `migrate*()` que corren en
cada arranque del servidor y son idempotentes:

- columnas nuevas → un loop de `ALTER TABLE <tabla> ADD COLUMN <col> <def>` que primero
  chequea `PRAGMA table_info` y saltea las que ya existen;
- tablas nuevas → `CREATE TABLE IF NOT EXISTS` + sus `CREATE INDEX IF NOT EXISTS`.

Correr el servidor sobre una base vieja la lleva sola al estado actual. Por eso nunca hizo
falta un archivo de migración numerado, y por eso esta carpeta quedó vacía.

## El problema que eso genera (y cómo se controla)

Ese mecanismo **no toca `database/schema/schema.sql`**. El archivo se desincroniza en
silencio, y cuando eso pasa una instalación limpia desde `schema.sql` no reproduce la base
real. Ya pasó dos veces:

- `profit_overrides` (la matriz de márgenes por cliente) existía solo en la base;
- `envio_bultos.numero_guia` idem.

Para que no vuelva a pasar sin que nadie se entere:

```bash
cd backend && npm run check-schema
```

Compara la base viva contra `schema.sql` y lista tabla por tabla y columna por columna lo que
difiere. Sale con código 1 si hay desvío, así que sirve en un hook o en CI. Es de solo lectura.

## Regla

Al agregar una tabla o una columna: escribir la migración en `db/index.js` **y** reflejar el
cambio en `schema.sql`. `schema.sql` describe el estado real de la base, no al revés. Correr
`npm run check-schema` antes de commitear confirma que quedaron alineados.
