// Repositorio de equipos: todo el SQL de consulta y mantenimiento del inventario.
// Recibe el pool por parámetro: no depende de Express ni conoce códigos HTTP.
// TODOS los valores del cliente viajan como parámetros $1, $2...

const T = 'practica_prestamos';

// Error de dominio: lleva "codigo" (los errores de PostgreSQL llevan "code").
// server.mjs decide qué código HTTP corresponde a cada uno.
function fallo(codigo, mensaje) {
  return Object.assign(new Error(mensaje), { codigo });
}
const UNIQUE = '23505';      // SQLSTATE unique_violation
const FOREIGN_KEY = '23503'; // SQLSTATE foreign_key_violation

// Opciones de ordenación permitidas -> fragmento SQL FIJO escrito por el programador.
// Nunca se concatena un nombre de columna recibido en la petición.
// El "id" final es un desempate único que hace estable la paginación.
const ORDEN_SQL = Object.freeze({
  codigo: 'e.codigo, e.id',
  nombre: 'e.nombre, e.id'
});

// Escapa los comodines de LIKE para que la búsqueda sea literal:
// buscar "50%" no debe comportarse como "50<cualquier cosa>".
function patronLiteral(texto) {
  return '%' + texto.replace(/[\\%_]/g, c => '\\' + c) + '%';
}

// Fila de BD -> objeto del dominio (nombres en camelCase, solo campos públicos)
const aEquipo = f => ({
  id: f.id,
  codigo: f.codigo,
  nombre: f.nombre,
  categoria: f.categoria,
  disponible: f.disponible
});

export function crearRepositorioEquipos(pool) {
  return {
    // -----------------------------------------------------------------
    // Listado con filtros combinables, orden y paginación (LIMIT/OFFSET)
    // -----------------------------------------------------------------
    async listar({ q, categoria, estado, orden, pagina }, tamano = 5) {
      const condiciones = [];
      const valores = [];

      if (q) {
        valores.push(patronLiteral(q));
        condiciones.push(`e.nombre ILIKE $${valores.length}`);
      }
      if (categoria) {
        valores.push(categoria);
        condiciones.push(`e.categoria = $${valores.length}`);
      }
      if (estado) {
        valores.push(estado === 'disponible'); // true o false como parámetro
        condiciones.push(`e.disponible = $${valores.length}`);
      }
      const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';
      const ordenSQL = ORDEN_SQL[orden] ?? ORDEN_SQL.codigo;

      // Se pide una fila más del tamaño de página para saber si hay "Siguiente"
      valores.push(tamano + 1);
      const marcadorLimite = `$${valores.length}`;
      valores.push((pagina - 1) * tamano);
      const marcadorDesplazamiento = `$${valores.length}`;

      const r = await pool.query(
        `SELECT e.id, e.codigo, e.nombre, e.categoria, e.disponible
           FROM ${T}.equipos AS e
           ${where}
          ORDER BY ${ordenSQL}
          LIMIT ${marcadorLimite} OFFSET ${marcadorDesplazamiento}`,
        valores
      );
      return {
        equipos: r.rows.slice(0, tamano).map(aEquipo),
        haySiguiente: r.rows.length > tamano
      };
    },

    // Categorías existentes para el desplegable del filtro
    async categorias() {
      const r = await pool.query(
        `SELECT DISTINCT categoria FROM ${T}.equipos ORDER BY categoria`
      );
      return r.rows.map(f => f.categoria);
    },

    // -----------------------------------------------------------------
    // Detalle: equipo + usuario que lo tiene AHORA (si lo hay).
    // LEFT JOIN conserva el equipo aunque no tenga préstamo activo.
    // La condición "fecha_devolucion IS NULL" va en el ON, no en el WHERE:
    // en el WHERE eliminaría los equipos sin préstamo activo.
    // -----------------------------------------------------------------
    async buscarDetalle(id) {
      const r = await pool.query(
        `SELECT e.id, e.codigo, e.nombre, e.categoria, e.disponible,
                p.id AS prestamo_id, p.fecha_prestamo,
                u.id AS usuario_id, u.nombre AS usuario_nombre
           FROM ${T}.equipos AS e
           LEFT JOIN ${T}.prestamos AS p
                  ON p.equipo_id = e.id AND p.fecha_devolucion IS NULL
           LEFT JOIN ${T}.usuarios AS u
                  ON u.id = p.usuario_id
          WHERE e.id = $1`,
        [id]
      );
      const f = r.rows[0];
      if (!f) return null;
      return {
        ...aEquipo(f),
        prestamoActivo: f.prestamo_id === null ? null : {
          id: f.prestamo_id,
          fechaPrestamo: f.fecha_prestamo,
          usuario: { id: f.usuario_id, nombre: f.usuario_nombre }
        }
      };
    },

    // Historial de préstamos del equipo con el nombre del usuario (JOIN)
    async historial(id) {
      const r = await pool.query(
        `SELECT p.id, p.fecha_prestamo, p.fecha_devolucion,
                u.id AS usuario_id, u.nombre AS usuario_nombre
           FROM ${T}.prestamos AS p
           JOIN ${T}.usuarios AS u ON u.id = p.usuario_id
          WHERE p.equipo_id = $1
          ORDER BY p.fecha_prestamo DESC, p.id DESC`,
        [id]
      );
      return r.rows.map(f => ({
        id: f.id,
        fechaPrestamo: f.fecha_prestamo,
        fechaDevolucion: f.fecha_devolucion,
        usuario: { id: f.usuario_id, nombre: f.usuario_nombre }
      }));
    },

    // -----------------------------------------------------------------
    // Alta: INSERT ... RETURNING evita una segunda consulta.
    // disponible no se envía: toma su DEFAULT true.
    // -----------------------------------------------------------------
    async crear({ codigo, nombre, categoria }) {
      try {
        const r = await pool.query(
          `INSERT INTO ${T}.equipos (codigo, nombre, categoria)
           VALUES ($1, $2, $3)
           RETURNING id, codigo, nombre, categoria, disponible`,
          [codigo, nombre, categoria]
        );
        return aEquipo(r.rows[0]);
      } catch (error) {
        if (error.code === UNIQUE) throw fallo('CODIGO_DUPLICADO', 'Ya existe un equipo con ese código');
        throw error;
      }
    },

    // -----------------------------------------------------------------
    // Modificación: WHERE id=$4 + rowCount para detectar ids inexistentes.
    // No toca "disponible": ese estado solo cambia al prestar o devolver.
    // -----------------------------------------------------------------
    async actualizar(id, { codigo, nombre, categoria }) {
      try {
        const r = await pool.query(
          `UPDATE ${T}.equipos
              SET codigo = $1, nombre = $2, categoria = $3
            WHERE id = $4
          RETURNING id, codigo, nombre, categoria, disponible`,
          [codigo, nombre, categoria, id]
        );
        return r.rowCount === 0 ? null : aEquipo(r.rows[0]);
      } catch (error) {
        if (error.code === UNIQUE) throw fallo('CODIGO_DUPLICADO', 'Ya existe un equipo con ese código');
        throw error;
      }
    },

    // -----------------------------------------------------------------
    // Borrado: la FK sin CASCADE rechaza (23503) el borrado si hay
    // préstamos, incluidos los ya devueltos. rowCount=0 -> no existe.
    // -----------------------------------------------------------------
    async borrar(id) {
      try {
        const r = await pool.query(`DELETE FROM ${T}.equipos WHERE id = $1`, [id]);
        return r.rowCount === 1;
      } catch (error) {
        if (error.code === FOREIGN_KEY) {
          throw fallo('EQUIPO_CON_PRESTAMOS', 'El equipo tiene préstamos registrados y no se puede borrar');
        }
        throw error;
      }
    }
  };
}
