// Conexión con PostgreSQL: un único pool para todo el proceso.
// pg lee PGHOST, PGPORT, PGDATABASE, PGUSER y PGPASSWORD del entorno
// (Node los carga con --env-file=.env).
import pg from 'pg';

for (const clave of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  if (!process.env[clave]) throw new Error(`Falta la variable de entorno ${clave}`);
}
const puerto = Number(process.env.PGPORT);
if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
  throw new Error('PGPORT no es válido');
}

export const pool = new pg.Pool({
  max: 5,                        // conexiones máximas de este proceso
  connectionTimeoutMillis: 3000, // espera máxima para obtener conexión
  idleTimeoutMillis: 10000       // cierra conexiones ociosas
});

// Un cliente inactivo puede perder la conexión: sin este manejador el proceso caería.
// No se registra el objeto de error completo (podría contener datos).
pool.on('error', () => console.error('Fallo en una conexión inactiva del pool'));
