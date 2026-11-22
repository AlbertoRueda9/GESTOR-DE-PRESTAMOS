-- =====================================================================
-- Práctica DWES UD4 · Gestión de préstamos de material informático
-- Inicializa (o REINICIA) el esquema practica_prestamos desde cero.
-- ¡Atención! Al repetirlo se pierden los datos de la práctica.
-- Ejecutar como dwes_app para que sea el propietario de las tablas.
-- =====================================================================
BEGIN;

DROP SCHEMA IF EXISTS practica_prestamos CASCADE;
CREATE SCHEMA practica_prestamos;

-- ---------------------------------------------------------------------
-- equipos: inventario
-- ---------------------------------------------------------------------
CREATE TABLE practica_prestamos.equipos (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo     text    NOT NULL
             CONSTRAINT equipos_codigo_unico UNIQUE
             CONSTRAINT equipos_codigo_longitud
               CHECK (char_length(codigo) BETWEEN 1 AND 20),
  nombre     text    NOT NULL
             CONSTRAINT equipos_nombre_no_vacio
               CHECK (char_length(btrim(nombre)) BETWEEN 1 AND 80),
  categoria  text    NOT NULL
             CONSTRAINT equipos_categoria_no_vacia
               CHECK (char_length(btrim(categoria)) BETWEEN 1 AND 40),
  disponible boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- usuarios: alumnado y personal (solo datos de prueba)
-- ---------------------------------------------------------------------
CREATE TABLE practica_prestamos.usuarios (
  id     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre text NOT NULL
         CONSTRAINT usuarios_nombre_no_vacio
           CHECK (char_length(btrim(nombre)) BETWEEN 1 AND 80)
);

-- ---------------------------------------------------------------------
-- prestamos: historial completo; fecha_devolucion NULL = préstamo activo
-- Las FK usan ON DELETE RESTRICT (sin CASCADE): no se puede borrar un
-- equipo ni un usuario que tenga préstamos, aunque estén finalizados.
-- ---------------------------------------------------------------------
CREATE TABLE practica_prestamos.prestamos (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipo_id        integer NOT NULL
                   CONSTRAINT prestamos_equipo_fk
                     REFERENCES practica_prestamos.equipos(id) ON DELETE RESTRICT,
  usuario_id       integer NOT NULL
                   CONSTRAINT prestamos_usuario_fk
                     REFERENCES practica_prestamos.usuarios(id) ON DELETE RESTRICT,
  fecha_prestamo   timestamptz NOT NULL DEFAULT now(),
  fecha_devolucion timestamptz,
  CONSTRAINT prestamos_fechas_coherentes
    CHECK (fecha_devolucion IS NULL OR fecha_devolucion >= fecha_prestamo)
);

-- Solo un préstamo ACTIVO por equipo (índice UNIQUE parcial).
-- Los préstamos devueltos no entran en el índice: se conserva el historial.
CREATE UNIQUE INDEX prestamos_un_activo_por_equipo
  ON practica_prestamos.prestamos (equipo_id)
  WHERE fecha_devolucion IS NULL;

-- Índice de apoyo para el historial de un equipo ordenado por fecha
CREATE INDEX prestamos_equipo_fecha
  ON practica_prestamos.prestamos (equipo_id, fecha_prestamo DESC);

-- ---------------------------------------------------------------------
-- Datos de ejemplo (12 equipos, 3 usuarios, 3 préstamos)
-- Al recrear el esquema las identidades empiezan en 1, así que los ids
-- son previsibles: equipo 1 = PORT-01, ..., equipo 12 = RED-01.
-- ---------------------------------------------------------------------
INSERT INTO practica_prestamos.equipos (codigo, nombre, categoria, disponible) VALUES
  ('PORT-01', 'Portátil Lenovo ThinkPad E14',     'portátil',   true),
  ('PORT-02', 'Portátil HP ProBook 450',          'portátil',   true),
  ('PORT-03', 'Portátil Dell Latitude 3540',      'portátil',   true),
  ('TAB-01',  'Tableta Samsung Galaxy Tab A9',    'tableta',    false),
  ('TAB-02',  'Tableta Apple iPad 10',            'tableta',    true),
  ('TAB-03',  'Tableta Lenovo Tab M10',           'tableta',    true),
  ('PROY-01', 'Proyector Epson EB-W51',           'proyector',  true),
  ('PROY-02', 'Proyector BenQ MW560',             'proyector',  true),
  ('CAM-01',  'Cámara de documentos IPEVO V4K',   'cámara',     true),
  ('CAM-02',  'Webcam Logitech C920',             'cámara',     true),
  ('PER-01',  'Kit de teclado y ratón inalámbrico','periférico', true),
  ('RED-01',  'Router Wi-Fi de viaje TP-Link',    'red',        true);

INSERT INTO practica_prestamos.usuarios (nombre) VALUES
  ('Ana García'),     -- id 1
  ('Luis Pérez'),     -- id 2
  ('Marta Ruiz');     -- id 3

-- Historial coherente con la columna disponible:
--  · PORT-02 (id 2) y PROY-01 (id 7): préstamos ya devueltos -> disponibles
--  · TAB-01  (id 4): préstamo activo de Luis -> disponible = false
INSERT INTO practica_prestamos.prestamos
  (equipo_id, usuario_id, fecha_prestamo, fecha_devolucion) VALUES
  (2, 1, now() - interval '10 days', now() - interval '7 days'),
  (7, 3, now() - interval '20 days', now() - interval '18 days'),
  (4, 2, now() - interval '2 days',  NULL);

COMMIT;
