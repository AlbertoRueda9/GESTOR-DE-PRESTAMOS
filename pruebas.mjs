// Comprobaciones mínimas de la práctica (apartado 7) con fetch.
// No es un framework de tests: lanza las peticiones, CONSULTA LAS TABLAS para
// verificar el estado real y genera resultados-pruebas.md para el README.
//
// Requisitos: servidor arrancado (npm start) en otra terminal.
// ¡Atención! Ejecuta init.sql al empezar: REINICIA los datos de la práctica.
// Uso: npm run pruebas   (equivale a node --env-file=.env pruebas.mjs)
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from './src/db.mjs';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const S = 'practica_prestamos';
const resultados = [];

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
async function peticion(metodo, ruta, cuerpo, { crudo } = {}) {
  const opciones = { method: metodo, headers: {} };
  if (cuerpo !== undefined) {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = crudo ? cuerpo : JSON.stringify(cuerpo);
  }
  const r = await fetch(BASE + ruta, opciones);
  const texto = await r.text(); // 204 no tiene cuerpo: no se intenta leer JSON
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* HTML o texto */ }
  return { estado: r.status, location: r.headers.get('location'), texto, json };
}

async function fila(sql, valores = []) {
  return (await pool.query(sql, valores)).rows[0];
}

function registrar(caso, peticionTxt, esperado, obtenido, ok) {
  resultados.push({ caso, peticion: peticionTxt, esperado, obtenido, ok: Boolean(ok) });
  console.log(`${ok ? 'OK  ' : 'FALLO'} | ${caso} | ${peticionTxt} | ${obtenido}`);
}

const estadoEquipo = id => fila(
  `SELECT e.disponible,
          (SELECT count(*)::int FROM ${S}.prestamos p WHERE p.equipo_id = e.id) AS prestamos,
          (SELECT count(*)::int FROM ${S}.prestamos p
            WHERE p.equipo_id = e.id AND p.fecha_devolucion IS NULL) AS activos
     FROM ${S}.equipos e WHERE e.id = $1`, [id]);

// ---------------------------------------------------------------------
try {
  // Estado inicial conocido
  await pool.query(await readFile(new URL('./init.sql', import.meta.url), 'utf8'));
  console.log('Datos reiniciados con init.sql\n');

  // ===== CONSULTA Y FILTROS (antes de crear equipos: datos conocidos) =====
  let r = await peticion('GET', '/equipos?q=LENOVO');
  registrar('Consulta y filtros', 'GET /equipos?q=LENOVO', '200; PORT-01 y TAB-03 (ILIKE)',
    `${r.estado}; PORT-01:${r.texto.includes('PORT-01')} TAB-03:${r.texto.includes('TAB-03')} PORT-02:${r.texto.includes('PORT-02')}`,
    r.estado === 200 && r.texto.includes('PORT-01') && r.texto.includes('TAB-03') && !r.texto.includes('PORT-02'));

  r = await peticion('GET', '/equipos?categoria=tableta');
  const tabletas = ['TAB-01', 'TAB-02', 'TAB-03'].every(c => r.texto.includes(c)) && !r.texto.includes('PORT-01');
  registrar('Consulta y filtros', 'GET /equipos?categoria=tableta', '200; solo TAB-01..03', `${r.estado}; solo tabletas:${tabletas}`,
    r.estado === 200 && tabletas);

  r = await peticion('GET', '/equipos?estado=prestado');
  registrar('Consulta y filtros', 'GET /equipos?estado=prestado', '200; solo TAB-01',
    `${r.estado}; TAB-01:${r.texto.includes('TAB-01')} otros:${r.texto.includes('PORT-01')}`,
    r.estado === 200 && r.texto.includes('TAB-01') && !r.texto.includes('PORT-01'));

  r = await peticion('GET', '/equipos?q=hp&categoria=' + encodeURIComponent('portátil') + '&estado=disponible');
  registrar('Consulta y filtros', 'GET /equipos?q=hp&categoria=portátil&estado=disponible', '200; solo PORT-02 (filtros combinados)',
    `${r.estado}; PORT-02:${r.texto.includes('PORT-02')} PORT-01:${r.texto.includes('PORT-01')}`,
    r.estado === 200 && r.texto.includes('PORT-02') && !r.texto.includes('PORT-01'));

  r = await peticion('GET', '/equipos?orden=nombre');
  const primero = r.texto.match(/href="\/equipos\/\d+">([^<]+)</)?.[1];
  registrar('Consulta y filtros', 'GET /equipos?orden=nombre', '200; primero CAM-01 (Cámara...)', `${r.estado}; primero ${primero}`,
    r.estado === 200 && primero === 'CAM-01');

  r = await peticion('GET', '/equipos?orden=codigo&pagina=2');
  const codigosP2 = [...r.texto.matchAll(/href="\/equipos\/\d+">([^<]+)</g)].map(m => m[1]);
  registrar('Consulta y filtros', 'GET /equipos?orden=codigo&pagina=2', '200; 5 filas, PORT-03 a TAB-01, enlaces a pág. 1 y 3',
    `${r.estado}; ${codigosP2.join(',')}; ant:${r.texto.includes('pagina=1')} sig:${r.texto.includes('pagina=3')}`,
    r.estado === 200 && codigosP2.length === 5 && codigosP2[0] === 'PORT-03' && codigosP2[4] === 'TAB-01'
      && r.texto.includes('pagina=1') && r.texto.includes('pagina=3'));

  r = await peticion('GET', '/equipos?estado=disponible&orden=nombre');
  registrar('Consulta y filtros', 'GET /equipos?estado=disponible&orden=nombre', 'El enlace Siguiente conserva estado y orden',
    `${r.estado}; enlace con filtros:${r.texto.includes('estado=disponible&amp;orden=nombre&amp;pagina=2')}`,
    r.estado === 200 && r.texto.includes('estado=disponible&amp;orden=nombre&amp;pagina=2'));

  r = await peticion('GET', '/equipos?q=zzzz');
  registrar('Consulta y filtros', 'GET /equipos?q=zzzz', '200 y mensaje de sin resultados',
    `${r.estado}; mensaje:${r.texto.includes('No hay equipos')}`, r.estado === 200 && r.texto.includes('No hay equipos'));

  r = await peticion('GET', '/equipos?q=_');
  registrar('Consulta y filtros', 'GET /equipos?q=_', '200; "_" literal, sin resultados',
    `${r.estado}; vacío:${r.texto.includes('No hay equipos')}`, r.estado === 200 && r.texto.includes('No hay equipos'));

  for (const ruta of ['/equipos?pagina=0', '/equipos?orden=precio', '/equipos?q=a&q=b']) {
    r = await peticion('GET', ruta);
    registrar('Consulta y filtros', `GET ${ruta}`, '400 filtros no válidos', String(r.estado), r.estado === 400);
  }

  // ===== DETALLE =====
  r = await peticion('GET', '/equipos/4');
  registrar('Detalle', 'GET /equipos/4', '200; prestado a Luis Pérez + historial',
    `${r.estado}; Luis:${r.texto.includes('Luis Pérez')} activo:${r.texto.includes('Activo')}`,
    r.estado === 200 && r.texto.includes('Luis Pérez') && r.texto.includes('Activo'));
  r = await peticion('GET', '/equipos/12');
  registrar('Detalle', 'GET /equipos/12', '200; sin préstamos (LEFT JOIN conserva el equipo)',
    `${r.estado}; sin historial:${r.texto.includes('no tiene préstamos')}`, r.estado === 200 && r.texto.includes('no tiene préstamos'));
  r = await peticion('GET', '/equipos/abc');
  registrar('Detalle', 'GET /equipos/abc', '400', String(r.estado), r.estado === 400);
  r = await peticion('GET', '/equipos/999');
  registrar('Detalle', 'GET /equipos/999', '404', String(r.estado), r.estado === 404);

  // ===== ALTA Y MODIFICACIÓN =====
  r = await peticion('POST', '/api/equipos', { codigo: 'PORT-04', nombre: 'Portátil Acer Aspire 5', categoria: 'Portátil' });
  const nuevoId = r.json?.id;
  registrar('Alta y modificación', 'POST /api/equipos {PORT-04}', '201, id y Location',
    `${r.estado}; id=${nuevoId}; Location=${r.location}; disponible=${r.json?.disponible}`,
    r.estado === 201 && Number.isInteger(nuevoId) && r.location === `/equipos/${nuevoId}`);

  r = await peticion('PUT', `/api/equipos/${nuevoId}`, { codigo: 'PORT-04', nombre: 'Portátil Acer Aspire 5 (revisado)', categoria: 'portátil' });
  registrar('Alta y modificación', `PUT /api/equipos/${nuevoId}`, '200 equipo actualizado',
    `${r.estado}; ${r.json?.nombre}`, r.estado === 200 && r.json?.nombre === 'Portátil Acer Aspire 5 (revisado)');

  r = await peticion('POST', '/api/equipos', { codigo: 'PORT-01', nombre: 'Repetido', categoria: 'portátil' });
  registrar('Alta y modificación', 'POST /api/equipos {codigo: PORT-01}', '409 código repetido (23505)', `${r.estado}; ${r.json?.error}`, r.estado === 409);

  r = await peticion('PUT', `/api/equipos/${nuevoId}`, { codigo: 'PORT-01', nombre: 'X', categoria: 'portátil' });
  registrar('Alta y modificación', `PUT /api/equipos/${nuevoId} {codigo: PORT-01}`, '409 código repetido', `${r.estado}; ${r.json?.error}`, r.estado === 409);

  r = await peticion('PUT', '/api/equipos/999', { codigo: 'X-1', nombre: 'X', categoria: 'x' });
  registrar('Alta y modificación', 'PUT /api/equipos/999', '404 (rowCount = 0)', String(r.estado), r.estado === 404);

  r = await peticion('PUT', `/api/equipos/${nuevoId}`, { codigo: 'PORT-04', nombre: 'X', categoria: 'portátil', disponible: false });
  registrar('Alta y modificación', 'PUT con "disponible"', '400: disponible no se modifica por PUT', String(r.estado), r.estado === 400);

  r = await peticion('POST', '/api/equipos', { codigo: '', nombre: '   ', categoria: 'x' });
  registrar('Alta y modificación', 'POST código vacío y nombre en blanco', '400 datos inválidos', `${r.estado}; ${r.json?.detalles?.length} errores`, r.estado === 400);

  r = await peticion('POST', '/api/equipos', '{"codigo": "MAL', { crudo: true });
  registrar('Alta y modificación', 'POST JSON mal formado', '400 JSON_INVALIDO', `${r.estado}; ${r.json?.error}`, r.estado === 400);

  // ===== BORRADO =====
  r = await peticion('DELETE', `/api/equipos/${nuevoId}`);
  registrar('Borrado', `DELETE /api/equipos/${nuevoId} (sin historial)`, '204 sin cuerpo', `${r.estado}; cuerpo vacío:${r.texto === ''}`, r.estado === 204 && r.texto === '');
  r = await peticion('DELETE', '/api/equipos/999');
  registrar('Borrado', 'DELETE /api/equipos/999', '404', String(r.estado), r.estado === 404);
  r = await peticion('DELETE', '/api/equipos/2');
  const sigue = await fila(`SELECT count(*)::int AS n FROM ${S}.equipos WHERE id = 2`);
  registrar('Borrado', 'DELETE /api/equipos/2 (historial devuelto)', '409 y el equipo sigue en la BD',
    `${r.estado}; ${r.json?.error}; filas=${sigue.n}`, r.estado === 409 && sigue.n === 1);

  // ===== PRÉSTAMO CORRECTO =====
  r = await peticion('POST', '/api/prestamos', { equipoId: 1, usuarioId: 1 });
  const prestamoId = r.json?.id;
  let e = await estadoEquipo(1);
  registrar('Préstamo correcto', 'POST /api/prestamos {equipoId:1, usuarioId:1}', '201; 1 activo; disponible=false',
    `${r.estado}; id=${prestamoId}; activos=${e.activos}; disponible=${e.disponible}`,
    r.estado === 201 && e.activos === 1 && e.disponible === false);

  // ===== PRÉSTAMO DUPLICADO =====
  const totalAntes = await fila(`SELECT count(*)::int AS n FROM ${S}.prestamos`);
  r = await peticion('POST', '/api/prestamos', { equipoId: 1, usuarioId: 2 });
  const totalDespues = await fila(`SELECT count(*)::int AS n FROM ${S}.prestamos`);
  registrar('Préstamo duplicado', 'POST /api/prestamos {equipoId:1, usuarioId:2}', '409 sin nuevas filas',
    `${r.estado}; ${r.json?.error}; filas ${totalAntes.n}->${totalDespues.n}`, r.estado === 409 && totalAntes.n === totalDespues.n);

  r = await peticion('POST', '/api/prestamos', { equipoId: 999, usuarioId: 1 });
  registrar('Préstamo duplicado', 'POST /api/prestamos {equipoId:999}', '404 equipo inexistente', `${r.estado}; ${r.json?.error}`, r.estado === 404);

  r = await peticion('POST', '/api/prestamos', { equipoId: '3', usuarioId: 1 });
  registrar('Préstamo duplicado', 'POST /api/prestamos {equipoId:"3"}', '400 tipo no válido', String(r.estado), r.estado === 400);

  // ===== ROLLBACK =====
  r = await peticion('POST', '/api/prestamos', { equipoId: 3, usuarioId: 999 });
  e = await estadoEquipo(3);
  registrar('Rollback', 'POST /api/prestamos {equipoId:3, usuarioId:999}', '400; disponible=true; 0 préstamos',
    `${r.estado}; ${r.json?.error}; disponible=${e.disponible}; préstamos=${e.prestamos}`,
    r.estado === 400 && e.disponible === true && e.prestamos === 0);

  // ===== DEVOLUCIÓN =====
  r = await peticion('POST', `/api/prestamos/${prestamoId}/devolucion`);
  e = await estadoEquipo(1);
  registrar('Devolución', `POST /api/prestamos/${prestamoId}/devolucion`, '200; fecha_devolucion; disponible=true',
    `${r.estado}; fechaDevolucion=${r.json?.fechaDevolucion ? 'sí' : 'no'}; disponible=${e.disponible}`,
    r.estado === 200 && r.json?.fechaDevolucion && e.disponible === true);

  // Para demostrar que la 2.ª devolución no toca el equipo, se vuelve a prestar
  // y se comprueba que sigue prestado tras repetir la devolución antigua.
  await peticion('POST', '/api/prestamos', { equipoId: 1, usuarioId: 2 });
  const fechaAntes = await fila(`SELECT fecha_devolucion FROM ${S}.prestamos WHERE id = $1`, [prestamoId]);
  r = await peticion('POST', `/api/prestamos/${prestamoId}/devolucion`);
  const fechaDespues = await fila(`SELECT fecha_devolucion FROM ${S}.prestamos WHERE id = $1`, [prestamoId]);
  e = await estadoEquipo(1);
  registrar('Devolución', `Repetir POST /api/prestamos/${prestamoId}/devolucion`, '409; nada cambia (fecha igual, equipo sigue prestado)',
    `${r.estado}; ${r.json?.error}; fecha igual:${+fechaAntes.fecha_devolucion === +fechaDespues.fecha_devolucion}; disponible=${e.disponible}`,
    r.estado === 409 && +fechaAntes.fecha_devolucion === +fechaDespues.fecha_devolucion && e.disponible === false);

  r = await peticion('POST', '/api/prestamos/999/devolucion');
  registrar('Devolución', 'POST /api/prestamos/999/devolucion', '404 préstamo inexistente', `${r.estado}; ${r.json?.error}`, r.estado === 404);

  // ===== SIMULTANEIDAD =====
  const respuestas = await Promise.all([
    peticion('POST', '/api/prestamos', { equipoId: 6, usuarioId: 1 }),
    peticion('POST', '/api/prestamos', { equipoId: 6, usuarioId: 2 })
  ]);
  const estados = respuestas.map(x => x.estado).sort();
  e = await estadoEquipo(6);
  registrar('Simultaneidad', 'Promise.all: 2 x POST /api/prestamos {equipoId:6}', 'Un 201 y un 409; 1 préstamo activo',
    `${estados.join(' y ')}; activos=${e.activos}; disponible=${e.disponible}`,
    estados[0] === 201 && estados[1] === 409 && e.activos === 1 && e.disponible === false);

  // Prueba más exigente: 10 peticiones simultáneas sobre el mismo equipo
  const diez = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    peticion('POST', '/api/prestamos', { equipoId: 8, usuarioId: (i % 3) + 1 })));
  const exitos = diez.filter(x => x.estado === 201).length;
  e = await estadoEquipo(8);
  registrar('Simultaneidad', 'Promise.all: 10 x POST /api/prestamos {equipoId:8}', '1 x 201, 9 x 409; 1 préstamo activo',
    `${exitos} x 201; activos=${e.activos}`, exitos === 1 && e.activos === 1);
} catch (error) {
  console.error('\nLas pruebas no pudieron completarse:', error.cause?.code ?? error.code ?? error.message);
  console.error('¿Está el servidor arrancado (npm start) y Docker en marcha?');
  process.exitCode = 1;
} finally {
  await pool.end();
}

// ---------------------------------------------------------------------
// Resumen en Markdown para copiar en el README
// ---------------------------------------------------------------------
const celda = t => String(t).replaceAll('|', '\\|');
const md = [
  '| Caso | Petición | Resultado esperado | Resultado obtenido | ✓ |',
  '|---|---|---|---|---|',
  ...resultados.map(x => `| ${celda(x.caso)} | \`${celda(x.peticion)}\` | ${celda(x.esperado)} | ${celda(x.obtenido)} | ${x.ok ? '✅' : '❌'} |`)
].join('\n');
await writeFile(new URL('./resultados-pruebas.md', import.meta.url),
  `# Resultados de las pruebas\n\nGenerado el ${new Date().toLocaleString('es-ES')}\n\n${md}\n`);
const fallos = resultados.filter(x => !x.ok).length;
console.log(`\n${resultados.length - fallos}/${resultados.length} comprobaciones correctas. Tabla en resultados-pruebas.md`);
if (fallos) process.exitCode = 1;
