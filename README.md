
# Práctica DWES UD4 · Préstamos de material informático

Inventario de equipos con préstamos y devoluciones. Node.js 24, Express 5, pg 8, EJS 3 y PostgreSQL 18 en Docker.

## Estructura

```
compose.yaml   init.sql   .env.example   package.json   package-lock.json   pruebas.mjs
src/  server.mjs (Express y rutas) · db.mjs (pool) · equipos.repo.mjs (SQL equipos) · prestamos.service.mjs (transacciones)
views/  equipos.ejs (listado) · equipo.ejs (detalle)
```

## Instalación y arranque

```bash
cp .env.example .env                 # poner contraseñas propias (.env no se entrega)
docker compose up -d                 # PostgreSQL 18 en 127.0.0.1:15432, volumen datos_pg
docker compose exec db psql -U postgres -d dwes   # solo la primera vez:
#   CREATE ROLE dwes_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
#   \password dwes_app        (misma clave que PGPASSWORD)
#   GRANT CONNECT, CREATE ON DATABASE dwes TO dwes_app;
npm install
docker compose exec db psql -h 127.0.0.1 -U dwes_app -d dwes -W -f /practica/init.sql
npm start                            # http://127.0.0.1:3000/equipos
```

`init.sql` borra y recrea el esquema `practica_prestamos`. `docker compose down` conserva los datos; `down -v` los elimina.

## Modelo de datos

| Tabla | Restricciones principales |
|---|---|
| `equipos` | `id` IDENTITY PK · `codigo` UNIQUE, 1-20 caracteres · `nombre`, `categoria` no vacíos · `disponible` DEFAULT true |
| `usuarios` | `id` IDENTITY PK · `nombre` no vacío |
| `prestamos` | FK a equipos y usuarios **sin cascada** · `fecha_devolucion` NULL = activo · índice UNIQUE parcial `(equipo_id) WHERE fecha_devolucion IS NULL` |

Datos de ejemplo: 12 equipos (ids 1-12) y 3 usuarios. TAB-01 (id 4) está prestado; PORT-02 (id 2) tiene un préstamo ya devuelto.

## Rutas

| Ruta | Respuestas |
|---|---|
| `GET /equipos?q=&categoria=&estado=&orden=&pagina=` | Listado HTML de 5 en 5. Filtros combinables. `400` si los filtros no son válidos |
| `GET /equipos/:id` | Detalle con usuario actual e historial · `400` · `404` |
| `POST /api/equipos` | `201` + `Location` · `400` · `409` código repetido |
| `PUT /api/equipos/:id` | `200` · `400` · `404` · `409` (no modifica `disponible`) |
| `DELETE /api/equipos/:id` | `204` · `404` · `409` si tiene préstamos |
| `POST /api/prestamos` `{equipoId, usuarioId}` | `201` · `400` (usuario inexistente) · `404` · `409` ocupado |
| `POST /api/prestamos/:id/devolucion` | `200` · `404` · `409` ya devuelto |

## Decisiones de diseño

- Todo el SQL está parametrizado (`$1`, `$2`…). El orden se elige de una lista cerrada (`codigo`/`nombre`) y en la búsqueda se escapan `%` y `_`.
- Préstamo en una transacción con un único cliente: `UPDATE ... WHERE disponible = true`; si `rowCount = 0`, se responde `409`; después `INSERT` y `COMMIT`. Ante un error se hace `ROLLBACK` y el cliente se libera en `finally`.
- La simultaneidad se resuelve con el bloqueo de fila del `UPDATE` condicional y, como segunda barrera, el índice único parcial.
- Los errores de PostgreSQL (`23505`, `23503`) se traducen a errores de dominio y después a códigos HTTP. Nunca se muestra el mensaje técnico al cliente.

## Pruebas

`npm run pruebas` (con el servidor arrancado): reinicia los datos, lanza las peticiones con `fetch`, comprueba el estado de las tablas y genera `resultados-pruebas.md`.

| Caso | Petición | Esperado | Obtenido |
|---|---|---|---|
| Alta / modificación | `POST /api/equipos` · `PUT /api/equipos/13` | 201 · 200 | |
| Código repetido | `POST` con `PORT-01` | 409 | |
| Filtros y paginación | `?q=lenovo` · `?categoria=tableta&estado=disponible` · `?pagina=2` | resultados filtrados, filtros conservados | |
| Borrado | `DELETE /api/equipos/13` · `/2` | 204 · 409 | |
| Préstamo correcto | `POST /api/prestamos {1,1}` | 201, `disponible=false` | |
| Préstamo duplicado | `POST /api/prestamos {1,2}` | 409, sin filas nuevas | |
| Rollback | `POST /api/prestamos {3,999}` | 400, equipo 3 sigue disponible | |
| Devolución / repetida | `POST /api/prestamos/:id/devolucion` ×2 | 200 · 409 | |
| Simultaneidad | 2 préstamos del equipo 6 con `Promise.all` | un 201 y un 409, 1 activo | |

## Limitaciones

Sin autenticación ni gestión de usuarios desde la API. La paginación con `OFFSET` puede desplazar filas si los datos cambian entre páginas. `disponible` es redundante con los préstamos activos y solo se mantiene coherente a través de la aplicación.