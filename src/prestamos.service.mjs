// Servicio de préstamos: operaciones de negocio con VARIAS escrituras que
// deben confirmarse juntas o revertirse juntas (transacciones).
// No recibe req/res ni conoce HTTP: recibe datos ya validados y lanza
// errores de dominio (con "codigo") que las rutas traducen a respuestas.

const T = 'practica_prestamos';

// Error de dominio: lleva "codigo" (los errores de PostgreSQL llevan "code")
function fallo(codigo, mensaje) {
  return Object.assign(new Error(mensaje), { codigo });
}
const UNIQUE = '23505';      // SQLSTATE unique_violation
const FOREIGN_KEY = '23503'; // SQLSTATE foreign_key_violation

const aPrestamo = f => ({
  id: f.id,
  equipoId: f.equipo_id,
  usuarioId: f.usuario_id,
  fechaPrestamo: f.fecha_prestamo,
  fechaDevolucion: f.fecha_devolucion
});

export function crearServicioPrestamos(pool) {
  // -------------------------------------------------------------------
  // Ayudante de transacción: UN ÚNICO cliente del pool para todo el bloque.
  // pool.query podría usar una conexión distinta en cada llamada, y BEGIN,
  // las escrituras y COMMIT tienen que ir por la misma conexión.
  // -------------------------------------------------------------------
  async function transaccion(trabajo) {
    const cliente = await pool.connect();
    let descartar = false;
    try {
      await cliente.query('BEGIN');
      const resultado = await trabajo(cliente);
      await cliente.query('COMMIT');
      return resultado;
    } catch (error) {
      try {
        await cliente.query('ROLLBACK');
      } catch {
        descartar = true; // conexión en estado incierto: no devolverla al pool
      }
      throw error;
    } finally {
      cliente.release(descartar); // SIEMPRE se libera, haya éxito o error
    }
  }

  return {
    // -----------------------------------------------------------------
    // Préstamo:
    //  1) UPDATE condicional: solo pasa a false si ahora es true.
    //     Si dos peticiones llegan a la vez, la segunda espera el bloqueo
    //     de la fila y, al reevaluar "disponible = true", afecta 0 filas.
    //  2) Si rowCount = 0 -> error controlado (no se inserta nada).
    //  3) INSERT del préstamo. Si el usuario no existe, la FK falla
    //     DESPUÉS de haber escrito el UPDATE -> ROLLBACK lo deshace.
    //  4) COMMIT solo si ambas escrituras terminan bien.
    // -----------------------------------------------------------------
    async prestar(equipoId, usuarioId) {
      try {
        return await transaccion(async cliente => {
          const cambio = await cliente.query(
            `UPDATE ${T}.equipos
                SET disponible = false
              WHERE id = $1 AND disponible = true`,
            [equipoId]
          );
          if (cambio.rowCount === 0) {
            // Distinguimos "no existe" (404) de "ya prestado" (409)
            const existe = await cliente.query(
              `SELECT 1 FROM ${T}.equipos WHERE id = $1`, [equipoId]);
            throw existe.rowCount === 0
              ? fallo('EQUIPO_INEXISTENTE', 'El equipo no existe')
              : fallo('EQUIPO_NO_DISPONIBLE', 'El equipo ya está prestado');
          }
          const r = await cliente.query(
            `INSERT INTO ${T}.prestamos (equipo_id, usuario_id)
             VALUES ($1, $2)
             RETURNING id, equipo_id, usuario_id, fecha_prestamo, fecha_devolucion`,
            [equipoId, usuarioId]
          );
          return aPrestamo(r.rows[0]);
        });
      } catch (error) {
        // Traducción de errores de PostgreSQL a errores del dominio
        if (error.code === FOREIGN_KEY && error.constraint === 'prestamos_usuario_fk') {
          throw fallo('USUARIO_INEXISTENTE', 'El usuario no existe');
        }
        if (error.code === UNIQUE && error.constraint === 'prestamos_un_activo_por_equipo') {
          // Red de seguridad: el índice parcial impide un 2.º préstamo activo
          throw fallo('EQUIPO_NO_DISPONIBLE', 'El equipo ya está prestado');
        }
        throw error;
      }
    },

    // -----------------------------------------------------------------
    // Devolución:
    //  1) UPDATE condicional del préstamo ACTIVO (fecha_devolucion IS NULL)
    //     registrando la fecha; RETURNING da el equipo_id.
    //  2) Si no afecta filas: no existe o ya estaba devuelto -> no se toca
    //     ningún equipo.
    //  3) En la misma transacción, el equipo vuelve a disponible = true.
    // -----------------------------------------------------------------
    async devolver(prestamoId) {
      return transaccion(async cliente => {
        const r = await cliente.query(
          `UPDATE ${T}.prestamos
              SET fecha_devolucion = now()
            WHERE id = $1 AND fecha_devolucion IS NULL
          RETURNING id, equipo_id, usuario_id, fecha_prestamo, fecha_devolucion`,
          [prestamoId]
        );
        if (r.rowCount === 0) {
          const existe = await cliente.query(
            `SELECT 1 FROM ${T}.prestamos WHERE id = $1`, [prestamoId]);
          throw existe.rowCount === 0
            ? fallo('PRESTAMO_INEXISTENTE', 'El préstamo no existe')
            : fallo('PRESTAMO_YA_DEVUELTO', 'El préstamo ya fue devuelto');
        }
        const prestamo = r.rows[0];
        await cliente.query(
          `UPDATE ${T}.equipos SET disponible = true WHERE id = $1`,
          [prestamo.equipo_id]
        );
        return aPrestamo(prestamo);
      });
    }
  };
}
