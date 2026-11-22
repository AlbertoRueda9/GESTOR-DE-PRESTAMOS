// =====================================================================
// server.mjs · Arranque de Express: configuración, validación de
// entradas, rutas HTML (EJS), API JSON, traducción de errores a HTTP
// y arranque/cierre del servidor.
// El SQL NO está aquí: vive en equipos.repo.mjs y prestamos.service.mjs.
// =====================================================================
import express from 'express';
import { fileURLToPath } from 'node:url';
import { pool } from './db.mjs';
import { crearRepositorioEquipos } from './equipos.repo.mjs';
import { crearServicioPrestamos } from './prestamos.service.mjs';

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', fileURLToPath(new URL('../views/', import.meta.url)));

const equipos = crearRepositorioEquipos(pool);
const prestamos = crearServicioPrestamos(pool);

const TAMANO_PAGINA = 5;
const ID_MAXIMO = 2147483647; // máximo de integer en PostgreSQL

// ---------------------------------------------------------------------
// 1. VALIDACIÓN DE ENTRADAS
// Validar comprueba formato y reglas; parametrizar (en el repositorio)
// evita que un valor se convierta en SQL. Hacen falta las dos cosas.
// ---------------------------------------------------------------------

// Identificador recibido como texto en la URL (/equipos/:id)
function idDeTexto(texto) {
  if (typeof texto !== 'string' || !/^[1-9]\d*$/.test(texto)) return null;
  const id = Number(texto);
  return Number.isSafeInteger(id) && id <= ID_MAXIMO ? id : null;
}

// Identificador recibido como número en un JSON ({ "equipoId": 3 })
const idNumericoValido = v => Number.isInteger(v) && v > 0 && v <= ID_MAXIMO;

const esObjetoPlano = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const camposNoAdmitidos = (cuerpo, permitidos) =>
  Object.keys(cuerpo).filter(clave => !permitidos.includes(clave));

// Cuerpo de POST/PUT /api/equipos. "disponible" NO se admite:
// solo cambia al prestar o devolver.
function validarEquipo(cuerpo) {
  if (!esObjetoPlano(cuerpo)) return { errores: ['El cuerpo debe ser un objeto JSON'] };
  const errores = [];
  const extra = camposNoAdmitidos(cuerpo, ['codigo', 'nombre', 'categoria']);
  if (extra.length) errores.push(`Campos no admitidos: ${extra.join(', ')}`);

  const { codigo, nombre, categoria } = cuerpo;
  if (typeof codigo !== 'string' || !/^[A-Z0-9-]{1,20}$/.test(codigo)) {
    errores.push('codigo: texto de 1 a 20 caracteres (A-Z, 0-9 o guion)');
  }
  if (typeof nombre !== 'string' || nombre.trim().length < 1 || nombre.trim().length > 80) {
    errores.push('nombre: texto obligatorio de 1 a 80 caracteres');
  }
  if (typeof categoria !== 'string' || categoria.trim().length < 1 || categoria.trim().length > 40) {
    errores.push('categoria: texto obligatorio de 1 a 40 caracteres');
  }
  if (errores.length) return { errores };
  return {
    datos: {
      codigo,
      nombre: nombre.trim(),
      categoria: categoria.trim().toLowerCase() // categorías homogéneas para el filtro
    }
  };
}

// Cuerpo de POST /api/prestamos: { equipoId, usuarioId }
function validarPrestamo(cuerpo) {
  if (!esObjetoPlano(cuerpo)) return { errores: ['El cuerpo debe ser un objeto JSON'] };
  const errores = [];
  const extra = camposNoAdmitidos(cuerpo, ['equipoId', 'usuarioId']);
  if (extra.length) errores.push(`Campos no admitidos: ${extra.join(', ')}`);
  if (!idNumericoValido(cuerpo.equipoId)) errores.push('equipoId: entero positivo');
  if (!idNumericoValido(cuerpo.usuarioId)) errores.push('usuarioId: entero positivo');
  if (errores.length) return { errores };
  return { datos: { equipoId: cuerpo.equipoId, usuarioId: cuerpo.usuarioId } };
}

// Filtros de GET /equipos. Todos deben ser cadenas: un parámetro
// repetido (?q=a&q=b) llega como array y se rechaza.
function validarFiltros(query) {
  const q = query.q ?? '';
  const categoria = query.categoria ?? '';
  const estado = query.estado ?? '';
  const orden = query.orden ?? 'codigo';
  const pagina = query.pagina ?? '1';

  if ([q, categoria, estado, orden, pagina].some(v => typeof v !== 'string')) {
    return { errores: ['Parámetros repetidos o con formato no válido'] };
  }
  const errores = [];
  if (q.length > 80) errores.push('La búsqueda admite como máximo 80 caracteres');
  if (categoria.length > 40) errores.push('Categoría no válida');
  if (!['', 'disponible', 'prestado'].includes(estado)) errores.push('Estado no válido');
  if (!['codigo', 'nombre'].includes(orden)) errores.push('Orden no válido'); // opciones predefinidas
  if (!/^[1-9]\d{0,3}$/.test(pagina)) errores.push('Página no válida');
  if (errores.length) return { errores };
  return { filtros: { q: q.trim(), categoria, estado, orden, pagina: Number(pagina) } };
}

const formatoFecha = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid'
});
const fecha = d => (d ? formatoFecha.format(d) : null);

// ---------------------------------------------------------------------
// 2. PÁGINAS HTML (EJS): solo consulta
// ---------------------------------------------------------------------
const web = express.Router();

// Valida :id antes de cualquier ruta que lo use -> 400 si está mal formado
web.param('id', (req, res, next, texto) => {
  const id = idDeTexto(texto);
  if (id === null) return res.status(400).type('text').send('Identificador de equipo no válido');
  req.equipoId = id;
  next();
});

web.get('/', (req, res) => res.redirect('/equipos'));

// GET /equipos: búsqueda ILIKE, filtros, orden y paginación de 5 en 5
web.get('/equipos', async (req, res) => {
  const { filtros, errores } = validarFiltros(req.query);
  if (errores) return res.status(400).type('text').send('Filtros no válidos: ' + errores.join('; '));

  const [{ equipos: lista, haySiguiente }, categorias] = await Promise.all([
    equipos.listar(filtros, TAMANO_PAGINA),
    equipos.categorias()
  ]);

  // Enlaces de paginación que CONSERVAN los filtros (URLSearchParams codifica)
  const enlace = pagina => {
    const p = new URLSearchParams();
    if (filtros.q) p.set('q', filtros.q);
    if (filtros.categoria) p.set('categoria', filtros.categoria);
    if (filtros.estado) p.set('estado', filtros.estado);
    p.set('orden', filtros.orden);
    p.set('pagina', String(pagina));
    return '/equipos?' + p;
  };

  res.render('equipos', {
    equipos: lista,
    categorias,
    filtros,
    anterior: filtros.pagina > 1 ? enlace(filtros.pagina - 1) : null,
    siguiente: haySiguiente ? enlace(filtros.pagina + 1) : null
  });
});

// GET /equipos/:id: datos, usuario actual (LEFT JOIN) e historial (JOIN)
web.get('/equipos/:id', async (req, res) => {
  const equipo = await equipos.buscarDetalle(req.equipoId);
  if (!equipo) return res.status(404).type('text').send('El equipo no existe');

  const historial = await equipos.historial(req.equipoId);
  res.render('equipo', {
    equipo: {
      ...equipo,
      prestamoActivo: equipo.prestamoActivo && {
        ...equipo.prestamoActivo,
        fechaTexto: fecha(equipo.prestamoActivo.fechaPrestamo)
      }
    },
    historial: historial.map(p => ({
      id: p.id,
      usuario: p.usuario.nombre,
      prestado: fecha(p.fechaPrestamo),
      devuelto: fecha(p.fechaDevolucion) // null = préstamo activo
    }))
  });
});

// ---------------------------------------------------------------------
// 3. API JSON DE ESCRITURA (/api/...)
// ---------------------------------------------------------------------
const api = express.Router();
api.use(express.json({ limit: '10kb' }));

api.param('id', (req, res, next, texto) => {
  const id = idDeTexto(texto);
  if (id === null) return res.status(400).json({ error: 'ID_INVALIDO', mensaje: 'Identificador no válido' });
  req.recursoId = id;
  next();
});

const datosInvalidos = (res, errores) =>
  res.status(400).json({ error: 'DATOS_INVALIDOS', mensaje: 'Datos no válidos', detalles: errores });
const equipoInexistente = res =>
  res.status(404).json({ error: 'EQUIPO_INEXISTENTE', mensaje: 'El equipo no existe' });

// POST /api/equipos -> 201 + Location
api.post('/equipos', async (req, res) => {
  const { datos, errores } = validarEquipo(req.body);
  if (errores) return datosInvalidos(res, errores);
  const equipo = await equipos.crear(datos);
  res.status(201).location(`/equipos/${equipo.id}`).json(equipo);
});

// PUT /api/equipos/:id -> 200 | 404
api.put('/equipos/:id', async (req, res) => {
  const { datos, errores } = validarEquipo(req.body);
  if (errores) return datosInvalidos(res, errores);
  const equipo = await equipos.actualizar(req.recursoId, datos);
  if (!equipo) return equipoInexistente(res);
  res.json(equipo);
});

// DELETE /api/equipos/:id -> 204 | 404 | 409 (si tiene préstamos)
api.delete('/equipos/:id', async (req, res) => {
  const borrado = await equipos.borrar(req.recursoId);
  if (!borrado) return equipoInexistente(res);
  res.status(204).end();
});

// POST /api/prestamos -> 201 | 400 | 404 | 409
api.post('/prestamos', async (req, res) => {
  const { datos, errores } = validarPrestamo(req.body);
  if (errores) return datosInvalidos(res, errores);
  const prestamo = await prestamos.prestar(datos.equipoId, datos.usuarioId);
  res.status(201).json(prestamo);
});

// POST /api/prestamos/:id/devolucion -> 200 | 404 | 409
api.post('/prestamos/:id/devolucion', async (req, res) => {
  res.json(await prestamos.devolver(req.recursoId));
});

api.use((req, res) => res.status(404).json({ error: 'RUTA_INEXISTENTE', mensaje: 'Ruta no encontrada' }));

app.use('/api', api);
app.use(web);
app.use((req, res) => res.status(404).type('text').send('Página no encontrada'));

// ---------------------------------------------------------------------
// 4. MIDDLEWARE DE ERRORES (4 parámetros, después de las rutas)
// Express 5 envía aquí los rechazos de las rutas async.
// Nunca se envía al cliente el mensaje técnico de PostgreSQL.
// ---------------------------------------------------------------------
const ESTADO_POR_CODIGO = {
  CODIGO_DUPLICADO: 409,
  EQUIPO_CON_PRESTAMOS: 409,
  EQUIPO_NO_DISPONIBLE: 409,
  PRESTAMO_YA_DEVUELTO: 409,
  EQUIPO_INEXISTENTE: 404,
  PRESTAMO_INEXISTENTE: 404,
  USUARIO_INEXISTENTE: 400 // referencia inválida en el cuerpo de la petición
};

app.use((err, req, res, next) => {
  const esApi = req.originalUrl.startsWith('/api');
  const responder = (estado, error, mensaje) => esApi
    ? res.status(estado).json({ error, mensaje })
    : res.status(estado).type('text').send(mensaje);

  if (err.type === 'entity.parse.failed') return responder(400, 'JSON_INVALIDO', 'El cuerpo no es un JSON válido');
  if (err.type === 'entity.too.large') return responder(413, 'CUERPO_EXCESIVO', 'Cuerpo demasiado grande');

  // Errores de dominio lanzados por el repositorio o el servicio
  if (Object.hasOwn(ESTADO_POR_CODIGO, err.codigo ?? '')) {
    return responder(ESTADO_POR_CODIGO[err.codigo], err.codigo, err.message);
  }
  // Red de seguridad: restricciones no traducidas antes (por SQLSTATE)
  if (err.code === '23505') return responder(409, 'CONFLICTO', 'El dato ya existe');
  if (err.code === '23503') return responder(409, 'DATOS_RELACIONADOS', 'Operación no permitida por datos relacionados');
  if (err.code === '23502' || err.code === '23514') {
    return responder(400, 'DATOS_NO_ADMITIDOS', 'Los datos no cumplen las reglas');
  }

  // Fallo inesperado (p. ej. base de datos caída): se registra lo mínimo
  console.error(`Error ${req.method} ${req.originalUrl}: ${err.code ?? err.name}`);
  responder(500, 'ERROR_INTERNO', 'No se pudo completar la operación');
});

// ---------------------------------------------------------------------
// 5. ARRANQUE: comprobar PostgreSQL antes de aceptar peticiones
// ---------------------------------------------------------------------
const puertoHttp = Number(process.env.PORT ?? 3000);

try {
  const r = await pool.query('SELECT 1 AS comprobacion');
  console.log('Conexión con PostgreSQL comprobada:', r.rows[0].comprobacion);

  const servidor = app.listen(puertoHttp, '127.0.0.1', () => {
    console.log(`HTTP preparado en http://127.0.0.1:${puertoHttp}/equipos`);
  });
  servidor.on('error', async error => {
    console.error(error.code === 'EADDRINUSE'
      ? `El puerto ${puertoHttp} está ocupado: detén el otro servidor o cambia PORT`
      : 'No se pudo abrir el servidor HTTP');
    await pool.end();
    process.exitCode = 1;
  });

  // Deja de aceptar tráfico y después cierra el pool (no en cada petición)
  const cerrar = () => servidor.close(async () => { await pool.end(); });
  process.once('SIGINT', cerrar);
  process.once('SIGTERM', cerrar);
} catch {
  console.error('No se pudo conectar con PostgreSQL. Revisa Docker y el archivo .env');
  await pool.end();
  process.exitCode = 1;
}
