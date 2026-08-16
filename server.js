const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '10mb' }));
app.use(cookieSession({
  name: 'ticketera_session',
  secret: process.env.COOKIE_SECRET || 'cambia-este-secreto',
  maxAge: 30 * 24 * 60 * 60 * 1000
}));
app.use(express.static(path.join(__dirname, 'public')));

const ESTADOS = ['Abierto', 'En progreso', 'Esperando al Cliente', 'Resuelto', 'Cerrado'];
const CATEGORIAS = ['Soporte Técnico', 'Infraestructura', 'Administración', 'Recursos Humanos', 'Otro'];
const PRIORIDADES = ['Baja', 'Media', 'Alta', 'Urgente'];
const CARGOS = ['Técnico', 'Encargado', 'Administrativo', 'Director'];
const ROLES_CLIENTE = ['Administración', 'Integrante de Comisión', 'Intendente', 'Edificio'];

/* ---------------- Helpers ---------------- */

function requireStaff(req, res, next) {
  if (!req.session || req.session.type !== 'staff') return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireCliente(req, res, next) {
  if (!req.session || req.session.type !== 'cliente') return res.status(401).json({ error: 'No autenticado' });
  next();
}
function ok(res, data) { res.json(data); }
function bad(res, msg, code) { res.status(code || 400).json({ error: msg }); }

async function nextTicketNumero() {
  const anio = new Date().getFullYear();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `insert into contadores(anio, valor) values ($1, 1)
       on conflict (anio) do update set valor = contadores.valor + 1
       returning valor`, [anio]
    );
    await client.query('COMMIT');
    return `T-${anio}-${String(r.rows[0].valor).padStart(4, '0')}`;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function ticketConMensajes(ticketId) {
  const t = (await pool.query('select * from tickets where id=$1', [ticketId])).rows[0];
  if (!t) return null;
  const mensajes = (await pool.query('select * from mensajes where ticket_id=$1 order by fecha asc', [ticketId])).rows;
  return { ...t, mensajes };
}

async function collectTicketCCs(ticketId) {
  const r = await pool.query(
    `select distinct unnest(cc) as email from mensajes where ticket_id=$1 and cc is not null`, [ticketId]
  );
  return r.rows.map(row => row.email);
}

// Aplica un cambio de estado y, si corresponde, dispara el correo automático de "Esperando al Cliente"
async function aplicarCambioEstado(ticketId, nuevoEstado) {
  const t = (await pool.query('select estado, remitente_email from tickets where id=$1', [ticketId])).rows[0];
  if (!t) return;
  await pool.query('update tickets set estado=$1, actualizado=now() where id=$2', [nuevoEstado, ticketId]);
  if (nuevoEstado === 'Esperando al Cliente' && t.estado !== 'Esperando al Cliente') {
    const ccs = await collectTicketCCs(ticketId);
    const destinatarios = [t.remitente_email, ...ccs];
    await pool.query(
      `insert into mensajes (ticket_id, tipo, autor, cuerpo, destinatarios)
       values ($1,'sistema','Notificación automática',$2,$3)`,
      [ticketId, 'El técnico ha respondido su consulta, estamos aguardando su respuesta para seguir con la gestión.', destinatarios]
    );
  }
}

function pasoCoincide(paso, texto) {
  if (paso.match_any) return true;
  const low = (texto || '').toLowerCase();
  return (paso.palabras || []).some(p => p && low.includes(p));
}

async function dispararPaso(ticketId, automatizacion, paso, index, totalPasos) {
  const resp = (await pool.query('select * from respuestas_predefinidas where id=$1', [paso.respuesta_id])).rows[0];
  if (!resp) return;
  await pool.query(
    `insert into mensajes (ticket_id, tipo, autor, cuerpo, automatico)
     values ($1,'saliente',$2,$3,true)`,
    [ticketId, `Automatización · ${automatizacion.nombre} (paso ${index + 1}/${totalPasos})`, resp.cuerpo]
  );
  if (paso.accion_estado && paso.accion_estado !== 'Sin cambio') {
    await aplicarCambioEstado(ticketId, paso.accion_estado);
  } else {
    const cur = (await pool.query('select estado from tickets where id=$1', [ticketId])).rows[0];
    if (cur && cur.estado === 'Abierto') {
      await pool.query('update tickets set estado=$1 where id=$2', ['En progreso', ticketId]);
    }
  }
  const activa = index < totalPasos - 1 ? { id: automatizacion.id, paso: index } : { id: null, paso: null };
  await pool.query(
    'update tickets set automatizacion_activa_id=$1, automatizacion_activa_paso=$2, actualizado=now() where id=$3',
    [activa.id, activa.paso, ticketId]
  );
}

// Motor de automatizaciones: continúa una cadena activa o dispara el primer paso que coincida
async function aplicarAutomatizacionSiCorresponde(ticketId, texto) {
  const t = (await pool.query('select automatizacion_activa_id, automatizacion_activa_paso from tickets where id=$1', [ticketId])).rows[0];
  if (t && t.automatizacion_activa_id) {
    const auto = (await pool.query('select * from automatizaciones where id=$1 and activo=true', [t.automatizacion_activa_id])).rows[0];
    if (auto) {
      const pasos = (await pool.query('select * from automatizacion_pasos where automatizacion_id=$1 order by orden asc', [auto.id])).rows;
      const nextIndex = t.automatizacion_activa_paso + 1;
      const paso = pasos[nextIndex];
      if (paso && pasoCoincide(paso, texto)) {
        await dispararPaso(ticketId, auto, paso, nextIndex, pasos.length);
        return true;
      }
    }
  }
  const activas = (await pool.query('select * from automatizaciones where activo=true')).rows;
  for (const auto of activas) {
    const pasos = (await pool.query('select * from automatizacion_pasos where automatizacion_id=$1 order by orden asc', [auto.id])).rows;
    if (pasos[0] && pasoCoincide(pasos[0], texto)) {
      await dispararPaso(ticketId, auto, pasos[0], 0, pasos.length);
      return true;
    }
  }
  return false;
}

/* ---------------- Auth ---------------- */

app.post('/api/auth/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!email || !password) return bad(res, 'Faltan datos');

  const staff = (await pool.query('select * from usuarios where lower(email)=$1', [email])).rows[0];
  if (staff && bcrypt.compareSync(password, staff.password_hash)) {
    req.session.type = 'staff';
    req.session.userId = staff.id;
    return ok(res, { type: 'staff' });
  }
  const cliente = (await pool.query('select * from clientes where lower(correo)=$1', [email])).rows[0];
  if (cliente && cliente.portal_password_hash && bcrypt.compareSync(password, cliente.portal_password_hash)) {
    req.session.type = 'cliente';
    req.session.clienteId = cliente.id;
    return ok(res, { type: 'cliente' });
  }
  bad(res, 'Correo o contraseña incorrectos.', 401);
});

app.post('/api/auth/register', async (req, res) => {
  const { nombre, apellido, telefono, email, cargo, password } = req.body;
  if (!nombre || !apellido || !email || !password || !cargo) return bad(res, 'Completá todos los campos obligatorios.');
  if (password.length < 6) return bad(res, 'La contraseña debe tener al menos 6 caracteres.');
  const existe = (await pool.query('select id from usuarios where lower(email)=$1', [email.toLowerCase()])).rows[0];
  if (existe) return bad(res, 'Ya existe una cuenta registrada con ese correo.');
  const hash = bcrypt.hashSync(password, 10);
  const r = await pool.query(
    `insert into usuarios (nombre, apellido, telefono, email, password_hash, cargo)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [nombre, apellido, telefono || '', email.toLowerCase(), hash, cargo]
  );
  req.session.type = 'staff';
  req.session.userId = r.rows[0].id;
  ok(res, { type: 'staff' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  ok(res, { ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session || !req.session.type) return ok(res, { session: null });
  if (req.session.type === 'staff') {
    const u = (await pool.query('select id,nombre,apellido,telefono,email,cargo,firma_html from usuarios where id=$1', [req.session.userId])).rows[0];
    if (!u) return ok(res, { session: null });
    return ok(res, { session: { type: 'staff', usuario: u } });
  } else {
    const c = (await pool.query('select id,nombre,direccion,telefono,correo,rol from clientes where id=$1', [req.session.clienteId])).rows[0];
    if (!c) return ok(res, { session: null });
    return ok(res, { session: { type: 'cliente', cliente: c } });
  }
});

/* ---------------- Catálogos ---------------- */

app.get('/api/catalogos', requireStaff, (req, res) => {
  ok(res, { ESTADOS, CATEGORIAS, PRIORIDADES, CARGOS, ROLES_CLIENTE });
});

/* ---------------- Tickets (staff) ---------------- */

app.get('/api/tickets', requireStaff, async (req, res) => {
  const tickets = (await pool.query('select * from tickets order by actualizado desc')).rows;
  ok(res, tickets);
});

app.get('/api/tickets/:id', requireStaff, async (req, res) => {
  const t = await ticketConMensajes(req.params.id);
  if (!t) return bad(res, 'No encontrado', 404);
  ok(res, t);
});

app.post('/api/tickets', requireStaff, async (req, res) => {
  const { remitenteNombre, remitenteEmail, asunto, cuerpo } = req.body;
  if (!remitenteNombre || !remitenteEmail || !asunto || !cuerpo) return bad(res, 'Faltan datos');
  const numero = await nextTicketNumero();
  const r = await pool.query(
    `insert into tickets (numero, asunto, categoria, prioridad, estado, remitente_nombre, remitente_email)
     values ($1,$2,'Otro','Media','Abierto',$3,$4) returning id`,
    [numero, asunto, remitenteNombre, remitenteEmail]
  );
  const ticketId = r.rows[0].id;
  await pool.query(
    `insert into mensajes (ticket_id, tipo, autor, cuerpo) values ($1,'entrante',$2,$3)`,
    [ticketId, remitenteNombre, cuerpo]
  );
  const automatizado = await aplicarAutomatizacionSiCorresponde(ticketId, asunto + ' ' + cuerpo);
  const ticket = await ticketConMensajes(ticketId);
  ok(res, { ticket, automatizado });
});

app.patch('/api/tickets/:id', requireStaff, async (req, res) => {
  const { categoria, prioridad, estado, asignadoA, clienteId } = req.body;
  const id = req.params.id;
  if (categoria !== undefined) await pool.query('update tickets set categoria=$1, actualizado=now() where id=$2', [categoria, id]);
  if (prioridad !== undefined) await pool.query('update tickets set prioridad=$1, actualizado=now() where id=$2', [prioridad, id]);
  if (asignadoA !== undefined) await pool.query('update tickets set asignado_a=$1, actualizado=now() where id=$2', [asignadoA || null, id]);
  if (clienteId !== undefined) await pool.query('update tickets set cliente_id=$1, actualizado=now() where id=$2', [clienteId || null, id]);
  if (estado !== undefined) await aplicarCambioEstado(id, estado);
  const ticket = await ticketConMensajes(id);
  ok(res, ticket);
});

app.post('/api/tickets/:id/tomar', requireStaff, async (req, res) => {
  await pool.query('update tickets set asignado_a=$1, actualizado=now() where id=$2', [req.session.userId, req.params.id]);
  ok(res, await ticketConMensajes(req.params.id));
});

app.post('/api/tickets/:id/mensajes', requireStaff, async (req, res) => {
  const id = req.params.id;
  const { tipo, cuerpo, cc, adjuntos, incluirFirma } = req.body;
  if (!cuerpo || !cuerpo.trim()) return bad(res, 'El mensaje no puede estar vacío.');
  const t = (await pool.query('select * from tickets where id=$1', [id])).rows[0];
  if (!t) return bad(res, 'No encontrado', 404);

  if (tipo === 'entrante') {
    await pool.query(`insert into mensajes (ticket_id, tipo, autor, cuerpo) values ($1,'entrante',$2,$3)`, [id, t.remitente_nombre, cuerpo]);
    if (t.estado === 'Resuelto' || t.estado === 'Cerrado') await pool.query('update tickets set estado=$1 where id=$2', ['Abierto', id]);
    await aplicarAutomatizacionSiCorresponde(id, cuerpo);
  } else {
    const staff = (await pool.query('select * from usuarios where id=$1', [req.session.userId])).rows[0];
    const firmaHtml = (incluirFirma && staff.firma_html) ? staff.firma_html : '';
    await pool.query(
      `insert into mensajes (ticket_id, tipo, autor, cuerpo, cc, adjuntos, firma_html)
       values ($1,'saliente',$2,$3,$4,$5,$6)`,
      [id, `${staff.nombre} ${staff.apellido}`, cuerpo, cc || [], JSON.stringify(adjuntos || []), firmaHtml]
    );
    if (t.estado === 'Abierto') await pool.query('update tickets set estado=$1 where id=$2', ['En progreso', id]);
  }
  await pool.query('update tickets set actualizado=now() where id=$1', [id]);
  ok(res, await ticketConMensajes(id));
});

/* ---------------- Clientes ---------------- */

app.get('/api/clientes', requireStaff, async (req, res) => {
  const clientes = (await pool.query('select id,nombre,direccion,telefono,correo,rol,(portal_password_hash is not null) as tiene_portal from clientes order by nombre')).rows;
  ok(res, clientes);
});

app.get('/api/clientes/:id/tickets', requireStaff, async (req, res) => {
  const tickets = (await pool.query('select * from tickets where cliente_id=$1 order by actualizado desc', [req.params.id])).rows;
  ok(res, tickets);
});

app.post('/api/clientes', requireStaff, async (req, res) => {
  const { nombre, direccion, telefono, correo, rol, portalPassword } = req.body;
  if (!nombre) return bad(res, 'Falta el nombre del cliente.');
  const hash = portalPassword ? bcrypt.hashSync(portalPassword, 10) : null;
  const r = await pool.query(
    `insert into clientes (nombre, direccion, telefono, correo, rol, portal_password_hash)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [nombre, direccion || '', telefono || '', correo || '', rol || '', hash]
  );
  ok(res, { id: r.rows[0].id });
});

app.put('/api/clientes/:id', requireStaff, async (req, res) => {
  const { nombre, direccion, telefono, correo, rol, portalPassword } = req.body;
  if (portalPassword) {
    const hash = bcrypt.hashSync(portalPassword, 10);
    await pool.query(
      `update clientes set nombre=$1,direccion=$2,telefono=$3,correo=$4,rol=$5,portal_password_hash=$6 where id=$7`,
      [nombre, direccion || '', telefono || '', correo || '', rol || '', hash, req.params.id]
    );
  } else {
    await pool.query(
      `update clientes set nombre=$1,direccion=$2,telefono=$3,correo=$4,rol=$5 where id=$6`,
      [nombre, direccion || '', telefono || '', correo || '', rol || '', req.params.id]
    );
  }
  ok(res, { ok: true });
});

app.delete('/api/clientes/:id', requireStaff, async (req, res) => {
  await pool.query('update tickets set cliente_id=null where cliente_id=$1', [req.params.id]);
  await pool.query('delete from clientes where id=$1', [req.params.id]);
  ok(res, { ok: true });
});

/* ---------------- Usuarios (staff) ---------------- */

app.get('/api/usuarios', requireStaff, async (req, res) => {
  const usuarios = (await pool.query('select id,nombre,apellido,telefono,email,cargo from usuarios order by nombre')).rows;
  ok(res, usuarios);
});

app.put('/api/usuarios/me', requireStaff, async (req, res) => {
  const { nombre, apellido, telefono, cargo, password } = req.body;
  if (password) {
    if (password.length < 6) return bad(res, 'La contraseña debe tener al menos 6 caracteres.');
    const hash = bcrypt.hashSync(password, 10);
    await pool.query('update usuarios set nombre=$1,apellido=$2,telefono=$3,cargo=$4,password_hash=$5 where id=$6',
      [nombre, apellido, telefono || '', cargo, hash, req.session.userId]);
  } else {
    await pool.query('update usuarios set nombre=$1,apellido=$2,telefono=$3,cargo=$4 where id=$5',
      [nombre, apellido, telefono || '', cargo, req.session.userId]);
  }
  ok(res, { ok: true });
});

app.put('/api/usuarios/me/firma', requireStaff, async (req, res) => {
  await pool.query('update usuarios set firma_html=$1 where id=$2', [req.body.html || '', req.session.userId]);
  ok(res, { ok: true });
});

/* ---------------- Respuestas predefinidas ---------------- */

app.get('/api/respuestas', requireStaff, async (req, res) => {
  ok(res, (await pool.query('select * from respuestas_predefinidas order by titulo')).rows);
});
app.post('/api/respuestas', requireStaff, async (req, res) => {
  const { titulo, cuerpo } = req.body;
  if (!titulo || !cuerpo) return bad(res, 'Faltan datos');
  const r = await pool.query('insert into respuestas_predefinidas (titulo, cuerpo) values ($1,$2) returning id', [titulo, cuerpo]);
  ok(res, { id: r.rows[0].id });
});
app.put('/api/respuestas/:id', requireStaff, async (req, res) => {
  const { titulo, cuerpo } = req.body;
  await pool.query('update respuestas_predefinidas set titulo=$1, cuerpo=$2 where id=$3', [titulo, cuerpo, req.params.id]);
  ok(res, { ok: true });
});
app.delete('/api/respuestas/:id', requireStaff, async (req, res) => {
  await pool.query('delete from respuestas_predefinidas where id=$1', [req.params.id]);
  ok(res, { ok: true });
});

/* ---------------- Automatizaciones ---------------- */

app.get('/api/automatizaciones', requireStaff, async (req, res) => {
  const autos = (await pool.query('select * from automatizaciones order by nombre')).rows;
  for (const a of autos) {
    a.pasos = (await pool.query('select * from automatizacion_pasos where automatizacion_id=$1 order by orden asc', [a.id])).rows;
  }
  ok(res, autos);
});

app.post('/api/automatizaciones', requireStaff, async (req, res) => {
  const { nombre, activo, pasos } = req.body;
  if (!nombre || !pasos || !pasos.length) return bad(res, 'Faltan datos');
  const r = await pool.query('insert into automatizaciones (nombre, activo) values ($1,$2) returning id', [nombre, !!activo]);
  const autoId = r.rows[0].id;
  for (let i = 0; i < pasos.length; i++) {
    const p = pasos[i];
    await pool.query(
      `insert into automatizacion_pasos (automatizacion_id, orden, match_any, palabras, respuesta_id, accion_estado)
       values ($1,$2,$3,$4,$5,$6)`,
      [autoId, i, !!p.matchAny, p.matchAny ? [] : p.palabras, p.respuestaId, p.accionEstado || 'Sin cambio']
    );
  }
  ok(res, { id: autoId });
});

app.put('/api/automatizaciones/:id', requireStaff, async (req, res) => {
  const { nombre, activo, pasos } = req.body;
  await pool.query('update automatizaciones set nombre=$1, activo=$2 where id=$3', [nombre, !!activo, req.params.id]);
  await pool.query('delete from automatizacion_pasos where automatizacion_id=$1', [req.params.id]);
  for (let i = 0; i < pasos.length; i++) {
    const p = pasos[i];
    await pool.query(
      `insert into automatizacion_pasos (automatizacion_id, orden, match_any, palabras, respuesta_id, accion_estado)
       values ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, i, !!p.matchAny, p.matchAny ? [] : p.palabras, p.respuestaId, p.accionEstado || 'Sin cambio']
    );
  }
  ok(res, { ok: true });
});

app.post('/api/automatizaciones/:id/toggle', requireStaff, async (req, res) => {
  await pool.query('update automatizaciones set activo = not activo where id=$1', [req.params.id]);
  ok(res, { ok: true });
});

app.delete('/api/automatizaciones/:id', requireStaff, async (req, res) => {
  await pool.query('delete from automatizaciones where id=$1', [req.params.id]);
  ok(res, { ok: true });
});

/* ---------------- Configuración ---------------- */

app.get('/api/configuracion', requireStaff, async (req, res) => {
  ok(res, (await pool.query('select * from configuracion where id=1')).rows[0]);
});
app.put('/api/configuracion', requireStaff, async (req, res) => {
  const { casillaEmail, casillaNombre } = req.body;
  await pool.query('update configuracion set casilla_email=$1, casilla_nombre=$2 where id=1', [casillaEmail || '', casillaNombre || '']);
  ok(res, { ok: true });
});

/* ---------------- Portal de cliente ---------------- */

app.get('/api/portal/tickets', requireCliente, async (req, res) => {
  const tickets = (await pool.query('select * from tickets where cliente_id=$1 order by actualizado desc', [req.session.clienteId])).rows;
  ok(res, tickets);
});

app.get('/api/portal/tickets/:id', requireCliente, async (req, res) => {
  const t = await ticketConMensajes(req.params.id);
  if (!t || t.cliente_id !== req.session.clienteId) return bad(res, 'No encontrado', 404);
  ok(res, t);
});

app.post('/api/portal/tickets/:id/mensajes', requireCliente, async (req, res) => {
  const id = req.params.id;
  const cuerpo = (req.body.cuerpo || '').trim();
  if (!cuerpo) return bad(res, 'El mensaje no puede estar vacío.');
  const t = (await pool.query('select * from tickets where id=$1', [id])).rows[0];
  if (!t || t.cliente_id !== req.session.clienteId) return bad(res, 'No encontrado', 404);
  const cliente = (await pool.query('select nombre from clientes where id=$1', [req.session.clienteId])).rows[0];
  await pool.query(`insert into mensajes (ticket_id, tipo, autor, cuerpo) values ($1,'entrante',$2,$3)`, [id, cliente.nombre, cuerpo]);
  if (['Resuelto', 'Cerrado', 'Esperando al Cliente'].includes(t.estado)) {
    await pool.query('update tickets set estado=$1 where id=$2', ['Abierto', id]);
  }
  await aplicarAutomatizacionSiCorresponde(id, cuerpo);
  await pool.query('update tickets set actualizado=now() where id=$1', [id]);
  ok(res, await ticketConMensajes(id));
});

/* ---------------- Fallback ---------------- */

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'No encontrado' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => console.log(`Ticketera escuchando en el puerto ${PORT}`));
