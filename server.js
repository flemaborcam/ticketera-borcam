const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const ENC_KEY = crypto.createHash('sha256').update(process.env.COOKIE_SECRET || 'cambia-este-secreto').digest();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET_ADJUNTOS = 'adjuntos';

async function subirArchivoStorage(path, buffer, contentType) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Falta configurar SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_ADJUNTOS}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) throw new Error('No se pudo subir el archivo a Storage (' + (await r.text()) + ')');
  return path;
}

async function descargarArchivoStorage(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_ADJUNTOS}/${path}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY }
  });
  if (!r.ok) throw new Error('No se pudo descargar el archivo.');
  return r;
}

/* ---------------- Google Calendar (cuenta de servicio) ---------------- */

function credencialesGoogle() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function obtenerTokenGoogle() {
  const creds = credencialesGoogle();
  if (!creds || !creds.client_email || !creds.private_key) throw new Error('Falta configurar GOOGLE_SERVICE_ACCOUNT_JSON.');
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: creds.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    creds.private_key, { algorithm: 'RS256' }
  );
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('No se pudo autenticar con Google: ' + JSON.stringify(data));
  return data.access_token;
}

async function crearEventoGoogle(calendarId, evento) {
  const token = await obtenerTokenGoogle();
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(evento)
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Error creando evento en Google Calendar: ' + JSON.stringify(data));
  return data;
}

async function eliminarEventoGoogle(calendarId, eventId) {
  if (!eventId) return;
  try {
    const token = await obtenerTokenGoogle();
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) { console.error('Error eliminando evento de Google Calendar:', e.message); }
}

async function probarCalendarioGoogle(calendarId) {
  const token = await obtenerTokenGoogle();
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'No se pudo acceder al calendario.');
  return data;
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(payload) {
  if (!payload) return '';
  try {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) { return ''; }
}

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '30mb' }));
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

async function getConfig() {
  return (await pool.query('select * from configuracion where id=1')).rows[0];
}

let smtpTransportCache = null;
function construirTransporteSmtp(cfg) {
  if (!cfg.smtp_host || !cfg.smtp_usuario || !cfg.smtp_pass_enc) return null;
  const pass = decrypt(cfg.smtp_pass_enc);
  if (!pass) return null;
  return nodemailer.createTransport({
    host: cfg.smtp_host, port: cfg.smtp_port || 465, secure: (cfg.smtp_port || 465) == 465,
    auth: { user: cfg.smtp_usuario, pass }
  });
}
// Para enviar correos reales: exige que la casilla esté activada.
async function getSmtpTransport(cfg) {
  cfg = cfg || await getConfig();
  if (!cfg.correo_activo) return null;
  return construirTransporteSmtp(cfg);
}

// Envía un correo real (si la casilla está activa y configurada); si no, no hace nada.
async function enviarEmailReal({ to, cc, subject, text, html, attachments }) {
  try {
    const cfg = await getConfig();
    const transport = await getSmtpTransport(cfg);
    if (!transport || !to) return false;
    await transport.sendMail({
      from: `"${cfg.casilla_nombre || 'Soporte'}" <${cfg.smtp_usuario}>`,
      to, cc: (cc && cc.length) ? cc.join(',') : undefined,
      subject, text, html: html || undefined,
      attachments: attachments && attachments.length ? attachments : undefined
    });
    return true;
  } catch (e) {
    console.error('Error enviando correo real:', e.message);
    return false;
  }
}
async function contextoTicket(ticketId) {
  const t = (await pool.query('select numero, asunto, remitente_email from tickets where id=$1', [ticketId])).rows[0];
  const ccs = await collectTicketCCs(ticketId);
  return { ...t, ccs };
}

// Aplica un cambio de estado y, si corresponde, dispara el correo automático de "Esperando al Cliente"
async function aplicarCambioEstado(ticketId, nuevoEstado) {
  const t = (await pool.query('select estado, remitente_email from tickets where id=$1', [ticketId])).rows[0];
  if (!t) return;
  await pool.query('update tickets set estado=$1, actualizado=now() where id=$2', [nuevoEstado, ticketId]);
  if (nuevoEstado === 'Esperando al Cliente' && t.estado !== 'Esperando al Cliente') {
    const ccs = await collectTicketCCs(ticketId);
    const destinatarios = [t.remitente_email, ...ccs];
    const cuerpo = 'El técnico ha respondido su consulta, estamos aguardando su respuesta para seguir con la gestión.';
    await pool.query(
      `insert into mensajes (ticket_id, tipo, autor, cuerpo, destinatarios)
       values ($1,'sistema','Notificación automática',$2,$3)`,
      [ticketId, cuerpo, destinatarios]
    );
    const ctx = await contextoTicket(ticketId);
    await enviarEmailReal({ to: t.remitente_email, cc: ccs, subject: `[${ctx.numero}] ${ctx.asunto}`, text: cuerpo });
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
  const ctx = await contextoTicket(ticketId);
  await enviarEmailReal({ to: ctx.remitente_email, cc: ctx.ccs, subject: `[${ctx.numero}] ${ctx.asunto}`, text: resp.cuerpo });
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
async function aplicarAutomatizacionSiCorresponde(ticketId, texto, esNuevoTicket = false) {
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
    if (!pasos[0]) continue;
    if (pasos[0].solo_nuevo_ticket && !esNuevoTicket) continue;
    if (!pasoCoincide(pasos[0], texto)) continue;

    // Esta automatización ya se disparó antes en este mismo ticket: no se repite,
    // aunque la palabra clave vuelva a aparecer en un mensaje posterior.
    const yaDisparada = await pool.query(
      `select 1 from mensajes where ticket_id=$1 and automatico=true and autor like $2 limit 1`,
      [ticketId, `Automatización · ${auto.nombre} (%`]
    );
    if (yaDisparada.rows.length) continue;

    await dispararPaso(ticketId, auto, pasos[0], 0, pasos.length);
    return true;
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
    const u = (await pool.query('select id,nombre,apellido,telefono,email,cargo,firma_html,es_superadmin from usuarios where id=$1', [req.session.userId])).rows[0];
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
  const automatizado = await aplicarAutomatizacionSiCorresponde(ticketId, asunto + ' ' + cuerpo, true);
  await aplicarAvisoFinDeSemana(ticketId);
  await aplicarAvisoFueraHorario(ticketId);
  await notificarTelegramNuevoTicket(
    { id: ticketId, numero, asunto, remitenteNombre, remitenteEmail, cuerpoResumen: cuerpo },
    `${req.protocol}://${req.get('host')}`
  );
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

app.delete('/api/tickets/:id', requireStaff, async (req, res) => {
  await pool.query('delete from tickets where id=$1', [req.params.id]);
  ok(res, { ok: true });
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
    await aplicarAvisoFinDeSemana(id);
    await aplicarAvisoFueraHorario(id);
  } else {
    const staff = (await pool.query('select * from usuarios where id=$1', [req.session.userId])).rows[0];
    const firmaHtml = (incluirFirma && staff.firma_html) ? staff.firma_html : '';

    const adjuntosProcesados = [];
    for (const a of (adjuntos || [])) {
      try {
        const base64 = (a.dataUrl || '').split(',')[1] || '';
        const mime = (a.dataUrl || '').match(/^data:(.*?);base64,/)?.[1] || 'application/octet-stream';
        const attId = a.id || crypto.randomUUID();
        const path = `${id}/${attId}-${a.nombre}`;
        await subirArchivoStorage(path, Buffer.from(base64, 'base64'), mime);
        adjuntosProcesados.push({ id: attId, nombre: a.nombre, tipo: a.tipo, mime, size: a.size, path });
      } catch (e) { console.error('Error subiendo adjunto:', e.message); }
    }

    await pool.query(
      `insert into mensajes (ticket_id, tipo, autor, cuerpo, cc, adjuntos, firma_html)
       values ($1,'saliente',$2,$3,$4,$5,$6)`,
      [id, `${staff.nombre} ${staff.apellido}`, cuerpo, cc || [], JSON.stringify(adjuntosProcesados), firmaHtml]
    );
    if (t.estado === 'Abierto') await pool.query('update tickets set estado=$1 where id=$2', ['En progreso', id]);

    const attachmentsForMail = (adjuntos || []).map(a => {
      const base64 = (a.dataUrl || '').split(',')[1] || '';
      return { filename: a.nombre, content: base64, encoding: 'base64' };
    });
    const htmlBody = `<div style="white-space:pre-wrap;font-family:sans-serif;">${cuerpo.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>${firmaHtml ? `<div style="margin-top:16px;">${firmaHtml}</div>` : ''}`;
    await enviarEmailReal({
      to: t.remitente_email, cc: cc || [], subject: `[${t.numero}] ${t.asunto}`,
      text: cuerpo, html: htmlBody, attachments: attachmentsForMail
    });
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

async function requireSuperadmin(req, res, next) {
  if (!req.session || req.session.type !== 'staff') return res.status(401).json({ error: 'No autenticado' });
  const u = (await pool.query('select es_superadmin from usuarios where id=$1', [req.session.userId])).rows[0];
  if (!u || !u.es_superadmin) return bad(res, 'Solo un Superadmin puede hacer esto.', 403);
  next();
}

app.get('/api/usuarios', requireStaff, async (req, res) => {
  const usuarios = (await pool.query('select id,nombre,apellido,telefono,email,cargo,es_superadmin from usuarios order by nombre')).rows;
  ok(res, usuarios);
});

// Solo un Superadmin puede dar de alta usuarios directamente (sin pasar por el registro)
app.post('/api/usuarios', requireStaff, requireSuperadmin, async (req, res) => {
  const { nombre, apellido, telefono, email, cargo, password, esSuperadmin } = req.body;
  if (!nombre || !apellido || !email || !password || !cargo) return bad(res, 'Completá todos los campos obligatorios.');
  if (password.length < 6) return bad(res, 'La contraseña debe tener al menos 6 caracteres.');
  const existe = (await pool.query('select id from usuarios where lower(email)=$1', [email.toLowerCase()])).rows[0];
  if (existe) return bad(res, 'Ya existe una cuenta registrada con ese correo.');
  const hash = bcrypt.hashSync(password, 10);
  const r = await pool.query(
    `insert into usuarios (nombre, apellido, telefono, email, password_hash, cargo, es_superadmin)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [nombre, apellido, telefono || '', email.toLowerCase(), hash, cargo, !!esSuperadmin]
  );
  ok(res, { id: r.rows[0].id });
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

// Solo un Superadmin puede editar los datos de otro usuario del sistema
app.put('/api/usuarios/:id', requireStaff, requireSuperadmin, async (req, res) => {
  const { nombre, apellido, telefono, cargo, esSuperadmin, password } = req.body;
  if (password) {
    if (password.length < 6) return bad(res, 'La contraseña debe tener al menos 6 caracteres.');
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      'update usuarios set nombre=$1,apellido=$2,telefono=$3,cargo=$4,es_superadmin=$5,password_hash=$6 where id=$7',
      [nombre, apellido, telefono || '', cargo, !!esSuperadmin, hash, req.params.id]
    );
  } else {
    await pool.query(
      'update usuarios set nombre=$1,apellido=$2,telefono=$3,cargo=$4,es_superadmin=$5 where id=$6',
      [nombre, apellido, telefono || '', cargo, !!esSuperadmin, req.params.id]
    );
  }
  ok(res, { ok: true });
});

// Solo un Superadmin puede eliminar usuarios, y nunca a sí mismo (evita quedarse sin acceso)
app.delete('/api/usuarios/:id', requireStaff, requireSuperadmin, async (req, res) => {
  if (req.params.id === req.session.userId) return bad(res, 'No podés eliminar tu propia cuenta.');
  await pool.query('update tickets set asignado_a=null where asignado_a=$1', [req.params.id]);
  await pool.query('delete from usuarios where id=$1', [req.params.id]);
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
      `insert into automatizacion_pasos (automatizacion_id, orden, match_any, palabras, respuesta_id, accion_estado, solo_nuevo_ticket)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [autoId, i, !!p.matchAny, p.matchAny ? [] : p.palabras, p.respuestaId, p.accionEstado || 'Sin cambio', !!p.soloNuevoTicket]
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
      `insert into automatizacion_pasos (automatizacion_id, orden, match_any, palabras, respuesta_id, accion_estado, solo_nuevo_ticket)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, i, !!p.matchAny, p.matchAny ? [] : p.palabras, p.respuestaId, p.accionEstado || 'Sin cambio', !!p.soloNuevoTicket]
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
  const c = await getConfig();
  ok(res, {
    casillaEmail: c.casilla_email, casillaNombre: c.casilla_nombre, correoActivo: c.correo_activo,
    imapHost: c.imap_host, imapPort: c.imap_port, imapUsuario: c.imap_usuario, tieneImapPassword: !!c.imap_pass_enc,
    smtpHost: c.smtp_host, smtpPort: c.smtp_port, smtpUsuario: c.smtp_usuario, tieneSmtpPassword: !!c.smtp_pass_enc,
    avisoFindeActivo: c.aviso_finde_activo !== false, avisoFindeMensaje: c.aviso_finde_mensaje,
    avisoFueraHorarioActivo: c.aviso_fuera_horario_activo !== false, avisoFueraHorarioMensaje: c.aviso_fuera_horario_mensaje,
    avisoFueraHorarioInicio: c.aviso_fuera_horario_inicio || '09:00', avisoFueraHorarioFin: c.aviso_fuera_horario_fin || '18:00',
    telegramActivo: !!c.telegram_activo, telegramChatId: c.telegram_chat_id || '',
    telegramConfiguradoServidor: !!process.env.TELEGRAM_BOT_TOKEN
  });
});

app.put('/api/configuracion', requireStaff, async (req, res) => {
  const b = req.body;
  const c = await getConfig();
  await pool.query(
    `update configuracion set casilla_email=$1, casilla_nombre=$2, correo_activo=$3,
       imap_host=$4, imap_port=$5, imap_usuario=$6,
       imap_pass_enc = case when $7 <> '' then $8 else imap_pass_enc end,
       smtp_host=$9, smtp_port=$10, smtp_usuario=$11,
       smtp_pass_enc = case when $12 <> '' then $13 else smtp_pass_enc end,
       aviso_finde_activo=$14, aviso_finde_mensaje=$15,
       aviso_fuera_horario_activo=$16, aviso_fuera_horario_mensaje=$17,
       aviso_fuera_horario_inicio=$18, aviso_fuera_horario_fin=$19,
       telegram_activo=$20, telegram_chat_id=$21
     where id=1`,
    [
      b.casillaEmail || '', b.casillaNombre || '', !!b.correoActivo,
      b.imapHost || '', b.imapPort || 993, b.imapUsuario || '',
      b.imapPassword || '', encrypt(b.imapPassword || ''),
      b.smtpHost || '', b.smtpPort || 465, b.smtpUsuario || '',
      b.smtpPassword || '', encrypt(b.smtpPassword || ''),
      !!b.avisoFindeActivo, b.avisoFindeMensaje || '',
      !!b.avisoFueraHorarioActivo, b.avisoFueraHorarioMensaje || '',
      b.avisoFueraHorarioInicio || '09:00', b.avisoFueraHorarioFin || '18:00',
      !!b.telegramActivo, b.telegramChatId || ''
    ]
  );
  ok(res, { ok: true });
});

// Prueba las credenciales guardadas sin activar el polling — para verificar antes de confiar en la conexión
app.post('/api/configuracion/probar-telegram', requireStaff, async (req, res) => {
  try {
    const c = await getConfig();
    await enviarTelegramForzado(c.telegram_chat_id, '✅ Prueba de conexión desde el sistema de tickets de Borcam. Si ves este mensaje, quedó todo bien configurado.');
    ok(res, { ok: true });
  } catch (e) { bad(res, e.message); }
});

app.post('/api/configuracion/probar', requireStaff, async (req, res) => {
  const c = await getConfig();
  const resultado = { imap: { ok: false, error: null }, smtp: { ok: false, error: null } };

  try {
    if (!c.imap_host || !c.imap_usuario || !c.imap_pass_enc) throw new Error('Faltan datos de IMAP.');
    const client = new ImapFlow({
      host: c.imap_host, port: c.imap_port || 993, secure: true,
      auth: { user: c.imap_usuario, pass: decrypt(c.imap_pass_enc) }, logger: false
    });
    await client.connect();
    await client.logout();
    resultado.imap.ok = true;
  } catch (e) { resultado.imap.error = e.message; }

  try {
    const transport = construirTransporteSmtp(c);
    if (!transport) throw new Error('Faltan datos de SMTP (servidor, usuario o contraseña).');
    await transport.verify();
    resultado.smtp.ok = true;
  } catch (e) { resultado.smtp.error = e.message; }

  ok(res, resultado);
});

/* ---------------- Agenda de instalaciones (calendario público) ---------------- */

const DIA_MAP = { Sun: 'domingo', Mon: 'lunes', Tue: 'martes', Wed: 'miercoles', Thu: 'jueves', Fri: 'viernes', Sat: 'sabado' };
function diaKeyMontevideo(date) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Montevideo', weekday: 'short' }).format(date);
  return DIA_MAP[wd];
}
function fechaMontevideoStr(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function generarSlotsDia(dateStr, horario, duracionMinutos) {
  const slots = [];
  if (!horario || !horario.activo || !horario.inicio || !horario.fin) return slots;
  const [hIni, mIni] = horario.inicio.split(':').map(Number);
  const [hFin, mFin] = horario.fin.split(':').map(Number);
  let cursor = hIni * 60 + mIni;
  const finMin = hFin * 60 + mFin;
  while (cursor + duracionMinutos <= finMin) {
    const hh = String(Math.floor(cursor / 60)).padStart(2, '0');
    const mm = String(cursor % 60).padStart(2, '0');
    slots.push(`${dateStr}T${hh}:${mm}:00-03:00`);
    cursor += duracionMinutos;
  }
  return slots;
}
// 1º, 2º, 3º... "viernes" (u otro día) que cae dentro del mes, para repartir la rotación
function ocurrenciaEnMes(date) {
  const dia = Number(fechaMontevideoStr(date).split('-')[2]);
  return Math.ceil(dia / 7);
}

app.get('/api/agenda/info', async (req, res) => {
  const c = await getConfig();
  const cfg = c.calendario_config || {};
  const edificios = c.calendario_edificios || [];
  if (!cfg.activo) return ok(res, { activo: false });

  const edificioSolicitado = (req.query.edificio || '').trim();
  const duracion = cfg.duracionMinutos || 60;
  if (!edificioSolicitado) return ok(res, { activo: true, duracionMinutos: duracion, edificios, slots: [] });

  const diasVisibles = cfg.diasVisibles || 21;
  const minNotice = cfg.minNoticeDays ?? 1;

  const filasCitas = (await pool.query(`select fecha_hora, edificio from citas where estado='confirmada' and fecha_hora >= now()`)).rows;
  const edificioPorFecha = {};
  filasCitas.forEach(r => { edificioPorFecha[fechaMontevideoStr(new Date(r.fecha_hora))] = r.edificio; });

  const candidatos = [];
  const hoy = new Date();
  for (let i = 0; i < diasVisibles; i++) {
    if (i < minNotice) continue;
    const d = new Date(hoy.getTime() + i * 24 * 60 * 60 * 1000);
    const dateStr = fechaMontevideoStr(d);
    const horario = (cfg.diasHorarios || {})[diaKeyMontevideo(d)];
    if (!horario || !horario.activo) continue;

    // Regla 1: asignación explícita por repetición del mes (1er/2do/3er/4to/5to de ese día)
    const asignacion = horario.asignacionOcurrencias || {};
    const asignado = asignacion[String(ocurrenciaEnMes(d))];
    if (asignado && asignado !== edificioSolicitado) continue;

    // Regla 2: si esa fecha puntual ya la tomó otro edificio, queda bloqueada para el resto
    const ocupante = edificioPorFecha[dateStr];
    if (ocupante && ocupante !== edificioSolicitado) continue;

    candidatos.push(...generarSlotsDia(dateStr, horario, duracion));
  }

  const ocupadas = new Set(filasCitas.map(r => new Date(r.fecha_hora).toISOString()));
  const libres = candidatos.filter(s => !ocupadas.has(new Date(s).toISOString()));

  ok(res, { activo: true, duracionMinutos: duracion, edificios, slots: libres });
});

app.post('/api/agenda/reservar', async (req, res) => {
  const { fechaHora, nombreCliente, correoCliente, telefono, tieneInternet, edificio, numeroUnidad } = req.body;
  if (!fechaHora || !nombreCliente || !correoCliente || !telefono || !edificio || !numeroUnidad || tieneInternet === undefined) {
    return bad(res, 'Completá todos los campos.');
  }
  const c = await getConfig();
  const cfg = c.calendario_config || {};
  if (!cfg.activo) return bad(res, 'La agenda no está activa en este momento.');

  const yaOcupado = await pool.query(`select 1 from citas where estado='confirmada' and fecha_hora=$1`, [fechaHora]);
  if (yaOcupado.rows.length) return bad(res, 'Ese horario ya no está disponible, elegí otro.', 409);

  const dateStr = fechaMontevideoStr(new Date(fechaHora));
  const otroEdificio = await pool.query(
    `select 1 from citas where estado='confirmada' and (fecha_hora at time zone 'America/Montevideo')::date = $1::date and edificio <> $2 limit 1`,
    [dateStr, edificio]
  );
  if (otroEdificio.rows.length) return bad(res, 'Esa fecha ya quedó asignada a otro edificio, elegí otra.', 409);

  const token = crypto.randomUUID();
  const duracion = cfg.duracionMinutos || 60;
  const r = await pool.query(
    `insert into citas (nombre_cliente, correo_cliente, telefono, tiene_internet, edificio, numero_unidad, fecha_hora, duracion_minutos, token_cancelacion)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [nombreCliente, correoCliente, telefono, !!tieneInternet, edificio, numeroUnidad, fechaHora, duracion, token]
  );
  const citaId = r.rows[0].id;

  if (cfg.googleCalendarId) {
    try {
      const inicio = new Date(fechaHora);
      const fin = new Date(inicio.getTime() + duracion * 60000);
      const evento = await crearEventoGoogle(cfg.googleCalendarId, {
        summary: `Instalación domótica — ${edificio} UD ${numeroUnidad}`,
        description: `Cliente: ${nombreCliente}\nTeléfono: ${telefono}\nCorreo: ${correoCliente}\nTiene internet: ${tieneInternet ? 'Sí' : 'No'}\nEdificio: ${edificio}\nUnidad: ${numeroUnidad}`,
        start: { dateTime: inicio.toISOString(), timeZone: 'America/Montevideo' },
        end: { dateTime: fin.toISOString(), timeZone: 'America/Montevideo' }
      });
      await pool.query('update citas set google_event_id=$1 where id=$2', [evento.id, citaId]);
    } catch (e) { console.error('Error creando evento de Google Calendar:', e.message); }
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const linkCancelar = `${baseUrl}/cancelar-cita/${token}`;
    const fechaFmt = new Date(fechaHora).toLocaleString('es-UY', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Montevideo' });
    const html = `<div style="font-family:sans-serif;max-width:480px;">
      <h2 style="color:#0F2A4D;">Turno confirmado</h2>
      <p>Hola ${nombreCliente}, tu turno para la instalación de domótica quedó agendado:</p>
      <p><strong>${fechaFmt}</strong><br>Edificio: ${edificio} · Unidad: ${numeroUnidad}</p>
      <p>Si necesitás cancelarlo, hacé click abajo:</p>
      <p><a href="${linkCancelar}" style="background:#1E56C7;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Cancelar turno</a></p>
    </div>`;
    await enviarEmailReal({
      to: correoCliente, subject: 'Confirmación de turno — Instalación de domótica',
      text: `Tu turno quedó agendado para ${fechaFmt}. Edificio: ${edificio}, Unidad: ${numeroUnidad}. Para cancelar: ${linkCancelar}`,
      html
    });
  } catch (e) { console.error('Error enviando confirmación de turno:', e.message); }

  ok(res, { ok: true });
});

app.post('/api/agenda/cancelar/:token', async (req, res) => {
  const cita = (await pool.query('select * from citas where token_cancelacion=$1', [req.params.token])).rows[0];
  if (!cita) return bad(res, 'Turno no encontrado.', 404);
  if (cita.estado === 'cancelada') return ok(res, { ok: true, yaCancelada: true });
  await pool.query('update citas set estado=$1 where id=$2', ['cancelada', cita.id]);
  const c = await getConfig();
  const cfg = c.calendario_config || {};
  if (cfg.googleCalendarId && cita.google_event_id) await eliminarEventoGoogle(cfg.googleCalendarId, cita.google_event_id);
  ok(res, { ok: true });
});

app.get('/agendar', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agendar.html'));
});

app.get('/cancelar-cita/:token', async (req, res) => {
  const cita = (await pool.query('select * from citas where token_cancelacion=$1', [req.params.token])).rows[0];
  if (!cita) return res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:60px;">Turno no encontrado</h1>');
  const fechaFmt = new Date(cita.fecha_hora).toLocaleString('es-UY', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Montevideo' });
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cancelar turno</title>
  <style>
    body{font-family:'IBM Plex Sans',sans-serif;background:#F3F7FC;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .card{background:#fff;border-radius:10px;padding:32px;max-width:420px;box-shadow:0 2px 10px rgba(15,42,77,.1);text-align:center;}
    h1{font-size:20px;color:#0F2A4D;margin:0 0 10px;} p{color:#48607F;line-height:1.5;}
    button{background:#C43D3D;color:#fff;border:none;padding:12px 20px;border-radius:6px;font-size:15px;cursor:pointer;margin-top:14px;}
    button:hover{background:#a83232;} #msg{margin-top:16px;font-weight:600;color:#0F2A4D;}
  </style></head>
  <body><div class="card">
    ${cita.estado === 'cancelada' ? `<h1>Este turno ya estaba cancelado</h1><p>${fechaFmt}</p>` : `
    <h1>¿Cancelar tu turno?</h1>
    <p><strong>${fechaFmt}</strong><br>${escapeHtmlSrv(cita.edificio)} · Unidad ${escapeHtmlSrv(cita.numero_unidad)}</p>
    <button onclick="cancelar()">Sí, cancelar mi turno</button>
    <div id="msg"></div>
    <script>
      async function cancelar(){
        document.getElementById('msg').textContent = 'Cancelando…';
        const r = await fetch('/api/agenda/cancelar/${cita.token_cancelacion}', { method:'POST' });
        const data = await r.json();
        document.getElementById('msg').textContent = data.ok ? 'Listo, tu turno fue cancelado.' : (data.error || 'Ocurrió un error.');
      }
    </script>`}
  </div></body></html>`);
});

/* ---------------- Calendario: configuración (staff) ---------------- */

app.get('/api/calendario-config', requireStaff, async (req, res) => {
  const c = await getConfig();
  const creds = credencialesGoogle();
  ok(res, { config: c.calendario_config || {}, edificios: c.calendario_edificios || [], googleServiceEmail: creds ? creds.client_email : null });
});

app.put('/api/calendario-config', requireStaff, async (req, res) => {
  await pool.query('update configuracion set calendario_config=$1 where id=1', [JSON.stringify(req.body.config || {})]);
  ok(res, { ok: true });
});

app.put('/api/calendario-edificios', requireStaff, async (req, res) => {
  await pool.query('update configuracion set calendario_edificios=$1 where id=1', [req.body.edificios || []]);
  ok(res, { ok: true });
});

app.post('/api/calendario-config/probar', requireStaff, async (req, res) => {
  try {
    const c = await getConfig();
    const cfg = c.calendario_config || {};
    if (!cfg.googleCalendarId) return bad(res, 'Falta configurar el ID del calendario.');
    const data = await probarCalendarioGoogle(cfg.googleCalendarId);
    ok(res, { ok: true, nombre: data.summary });
  } catch (e) { bad(res, e.message); }
});

app.get('/api/citas', requireStaff, async (req, res) => {
  const citas = (await pool.query(`select * from citas where fecha_hora >= now() - interval '1 day' order by fecha_hora asc`)).rows;
  ok(res, citas);
});

/* ---------------- Notificaciones a Telegram ---------------- */

async function enviarTelegramForzado(chatId, texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Falta configurar TELEGRAM_BOT_TOKEN en el servidor.');
  if (!chatId) throw new Error('Falta el Chat ID del grupo de Telegram.');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || 'Error desconocido al enviar a Telegram.');
  return data;
}

async function enviarTelegram(texto) {
  try {
    const c = await getConfig();
    if (!c.telegram_activo || !c.telegram_chat_id) return false;
    await enviarTelegramForzado(c.telegram_chat_id, texto);
    return true;
  } catch (e) {
    console.error('Error enviando a Telegram:', e.message);
    return false;
  }
}

async function notificarTelegramNuevoTicket(ticket, baseUrl) {
  const textoCompleto = `${ticket.asunto} ${ticket.cuerpoResumen || ''}`.toLowerCase();
  if (textoCompleto.includes('reserva')) return; // los tickets de reserva no se avisan por Telegram

  const link = baseUrl ? `${baseUrl}/?ticket=${ticket.id}` : '';
  const resumen = (ticket.cuerpoResumen || '').slice(0, 220);
  const mensaje =
    `🎫 <b>Nuevo ticket</b> #${escapeHtmlSrv(ticket.numero)}\n` +
    `<b>Asunto:</b> ${escapeHtmlSrv(ticket.asunto)}\n` +
    `<b>De:</b> ${escapeHtmlSrv(ticket.remitenteNombre)} (${escapeHtmlSrv(ticket.remitenteEmail)})\n\n` +
    `${escapeHtmlSrv(resumen)}${(ticket.cuerpoResumen || '').length > 220 ? '…' : ''}` +
    (link ? `\n\n👉 <a href="${link}">Abrir en el sistema</a>` : '');
  await enviarTelegram(mensaje);
}

function escapeHtmlSrv(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
  await aplicarAvisoFinDeSemana(id);
  await aplicarAvisoFueraHorario(id);
  await pool.query('update tickets set actualizado=now() where id=$1', [id]);
  ok(res, await ticketConMensajes(id));
});

/* ---------------- Recepción real de correo (IMAP) ---------------- */

function esFinDeSemanaUruguay() {
  const dia = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Montevideo', weekday: 'short' }).format(new Date());
  return dia === 'Sat' || dia === 'Sun';
}

async function aplicarAvisoFinDeSemana(ticketId) {
  if (!esFinDeSemanaUruguay()) return;
  const cfg = await getConfig();
  if (cfg.aviso_finde_activo === false) return;
  const yaEnviado = await pool.query(
    `select 1 from mensajes where ticket_id=$1 and autor='Aviso automático · Fin de semana'
     and (fecha at time zone 'America/Montevideo')::date = (now() at time zone 'America/Montevideo')::date
     limit 1`,
    [ticketId]
  );
  if (yaEnviado.rows.length) return;
  const mensaje = cfg.aviso_finde_mensaje || 'Estamos fuera de horario de atención (fin de semana).';
  await pool.query(
    `insert into mensajes (ticket_id, tipo, autor, cuerpo, automatico) values ($1,'saliente','Aviso automático · Fin de semana',$2,true)`,
    [ticketId, mensaje]
  );
  const ctx = await contextoTicket(ticketId);
  await enviarEmailReal({ to: ctx.remitente_email, cc: ctx.ccs, subject: `[${ctx.numero}] ${ctx.asunto}`, text: mensaje });
}

// Lunes a viernes, fuera del horario laboral configurado (ej: antes de las 09:00 o desde las 18:00)
function esFueraDeHorarioLaboral(cfg) {
  const dia = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Montevideo', weekday: 'short' }).format(new Date());
  if (dia === 'Sat' || dia === 'Sun') return false; // los fines de semana ya los cubre el otro aviso
  const horaActual = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const apertura = cfg.aviso_fuera_horario_inicio || '09:00';
  const cierre = cfg.aviso_fuera_horario_fin || '18:00';
  return horaActual < apertura || horaActual >= cierre;
}

async function aplicarAvisoFueraHorario(ticketId) {
  const cfg = await getConfig();
  if (cfg.aviso_fuera_horario_activo === false) return;
  if (!esFueraDeHorarioLaboral(cfg)) return;
  const yaEnviado = await pool.query(
    `select 1 from mensajes where ticket_id=$1 and autor='Aviso automático · Fuera de horario'
     and (fecha at time zone 'America/Montevideo')::date = (now() at time zone 'America/Montevideo')::date
     limit 1`,
    [ticketId]
  );
  if (yaEnviado.rows.length) return;
  const mensaje = cfg.aviso_fuera_horario_mensaje || 'Estamos fuera de nuestro horario de atención.';
  await pool.query(
    `insert into mensajes (ticket_id, tipo, autor, cuerpo, automatico) values ($1,'saliente','Aviso automático · Fuera de horario',$2,true)`,
    [ticketId, mensaje]
  );
  const ctx = await contextoTicket(ticketId);
  await enviarEmailReal({ to: ctx.remitente_email, cc: ctx.ccs, subject: `[${ctx.numero}] ${ctx.asunto}`, text: mensaje });
}

function extraerNumeroTicket(asunto) {
  const m = (asunto || '').match(/\[?(T-\d{4}-\d{4})\]?/i);
  return m ? m[1].toUpperCase() : null;
}

function recortarCitas(texto) {
  const lineas = texto.split('\n');
  let corte = -1;
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].trim();
    if (/^>{1,}/.test(l)) { corte = i; break; }
    if (/^-{3,}\s*(mensaje original|original message)/i.test(l)) { corte = i; break; }
    if (/^_{5,}$/.test(l)) { corte = i; break; }
    if (/^(el|on)\s.+(escribió|wrote)\s*:?\s*$/i.test(l)) { corte = i; break; }
    if (/^(de|from):\s*.+/i.test(l)) {
      const siguientes = lineas.slice(i + 1, i + 5).join('\n');
      if (/^(enviado|sent|fecha|date):/im.test(siguientes) && /^(para|to):/im.test(siguientes)) { corte = i; break; }
    }
  }
  if (corte === -1) return texto;
  let resultado = lineas.slice(0, corte);
  while (resultado.length && /^[-_]{3,}$/.test(resultado[resultado.length - 1].trim())) resultado.pop();
  return resultado.join('\n').trim();
}

async function procesarCorreoEntrante(parsed) {
  const fromAddr = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0] : null;
  if (!fromAddr) return;
  const remitenteEmail = fromAddr.address;
  const remitenteNombre = fromAddr.name || remitenteEmail;
  const asunto = parsed.subject || '(sin asunto)';
  const sinCitas = recortarCitas((parsed.text || '').trim());
  const textoLimpio = sinCitas.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let cuerpo = textoLimpio;
  let cuerpoHtml = null;
  if (!cuerpo && parsed.html) {
    cuerpoHtml = parsed.html;
    cuerpo = '(Este correo llegó con formato HTML — ver el contenido completo abajo)';
  } else if (!cuerpo) {
    cuerpo = '(mensaje sin texto)';
  }
  const numeroDetectado = extraerNumeroTicket(asunto);

  const adjuntosCrudos = [];
  for (const a of (parsed.attachments || [])) {
    if (a.size > 20 * 1024 * 1024) continue; // se omiten adjuntos muy pesados
    const tipo = a.contentType.startsWith('image/') ? 'imagen' : a.contentType.startsWith('video/') ? 'video' : a.contentType === 'application/pdf' ? 'pdf' : 'archivo';
    adjuntosCrudos.push({ id: crypto.randomUUID(), nombre: a.filename || 'adjunto', tipo, mime: a.contentType, size: a.size, buffer: a.content });
  }
  async function subirAdjuntosCrudos(ticketId) {
    const resultado = [];
    for (const a of adjuntosCrudos) {
      try {
        const path = `${ticketId}/${a.id}-${a.nombre}`;
        await subirArchivoStorage(path, a.buffer, a.mime);
        resultado.push({ id: a.id, nombre: a.nombre, tipo: a.tipo, mime: a.mime, size: a.size, path });
      } catch (e) { console.error('Error subiendo adjunto de correo real:', e.message); }
    }
    return resultado;
  }

  let ticket = null;
  if (numeroDetectado) {
    ticket = (await pool.query('select * from tickets where numero=$1', [numeroDetectado])).rows[0];
  }

  if (ticket) {
    const adjuntos = await subirAdjuntosCrudos(ticket.id);
    await pool.query(
      `insert into mensajes (ticket_id, tipo, autor, cuerpo, cuerpo_html, adjuntos) values ($1,'entrante',$2,$3,$4,$5)`,
      [ticket.id, remitenteNombre, cuerpo, cuerpoHtml, JSON.stringify(adjuntos)]
    );
    if (['Resuelto', 'Cerrado', 'Esperando al Cliente'].includes(ticket.estado)) {
      await pool.query('update tickets set estado=$1 where id=$2', ['Abierto', ticket.id]);
    }
    await aplicarAutomatizacionSiCorresponde(ticket.id, cuerpo);
    await aplicarAvisoFinDeSemana(ticket.id);
    await aplicarAvisoFueraHorario(ticket.id);
    await pool.query('update tickets set actualizado=now() where id=$1', [ticket.id]);
  } else {
    const numero = await nextTicketNumero();
    const r = await pool.query(
      `insert into tickets (numero, asunto, categoria, prioridad, estado, remitente_nombre, remitente_email)
       values ($1,$2,'Otro','Media','Abierto',$3,$4) returning id`,
      [numero, asunto, remitenteNombre, remitenteEmail]
    );
    const ticketId = r.rows[0].id;
    const adjuntos = await subirAdjuntosCrudos(ticketId);
    await pool.query(
      `insert into mensajes (ticket_id, tipo, autor, cuerpo, cuerpo_html, adjuntos) values ($1,'entrante',$2,$3,$4,$5)`,
      [ticketId, remitenteNombre, cuerpo, cuerpoHtml, JSON.stringify(adjuntos)]
    );
    await aplicarAutomatizacionSiCorresponde(ticketId, asunto + ' ' + cuerpo, true);
    await aplicarAvisoFinDeSemana(ticketId);
    await aplicarAvisoFueraHorario(ticketId);
    const baseUrlAuto = process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || '';
    await notificarTelegramNuevoTicket({ id: ticketId, numero, asunto, remitenteNombre, remitenteEmail, cuerpoResumen: cuerpo }, baseUrlAuto);
  }
}

let pollingEnCurso = false;
async function revisarCasillaReal() {
  if (pollingEnCurso) return;
  pollingEnCurso = true;
  try {
    const cfg = await getConfig();
    if (!cfg.correo_activo || !cfg.imap_host || !cfg.imap_usuario || !cfg.imap_pass_enc) return;
    const pass = decrypt(cfg.imap_pass_enc);
    if (!pass) return;

    const client = new ImapFlow({
      host: cfg.imap_host, port: cfg.imap_port || 993, secure: true,
      auth: { user: cfg.imap_usuario, pass }, logger: false
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let maxUid = cfg.imap_ultimo_uid || 0;
    try {
      const desde = maxUid + 1;
      for await (const msg of client.fetch(`${desde}:*`, { source: true, uid: true }, { uid: true })) {
        if (msg.uid <= maxUid) continue;
        try {
          const parsed = await simpleParser(msg.source);
          await procesarCorreoEntrante(parsed);
        } catch (e) { console.error('Error procesando un correo:', e.message); }
        if (msg.uid > maxUid) maxUid = msg.uid;
      }
    } finally {
      lock.release();
    }
    await client.logout();
    if (maxUid > (cfg.imap_ultimo_uid || 0)) {
      await pool.query('update configuracion set imap_ultimo_uid=$1 where id=1', [maxUid]);
    }
  } catch (e) {
    console.error('Error revisando la casilla real:', e.message);
  } finally {
    pollingEnCurso = false;
  }
}

// Revisa la casilla apenas arranca el servidor, y después cada 60 segundos
setTimeout(revisarCasillaReal, 8000);
setInterval(revisarCasillaReal, 60 * 1000);

/* ---------------- Descarga protegida de adjuntos (Supabase Storage) ---------------- */

app.get('/api/adjuntos/:ticketId/:mensajeId/:adjuntoId', async (req, res) => {
  if (!req.session || !req.session.type) return res.status(401).json({ error: 'No autenticado' });
  const { ticketId, mensajeId, adjuntoId } = req.params;
  const t = (await pool.query('select cliente_id from tickets where id=$1', [ticketId])).rows[0];
  if (!t) return res.status(404).json({ error: 'No encontrado' });
  if (req.session.type === 'cliente' && t.cliente_id !== req.session.clienteId) return res.status(403).json({ error: 'No autorizado' });

  const m = (await pool.query('select adjuntos from mensajes where id=$1 and ticket_id=$2', [mensajeId, ticketId])).rows[0];
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  const adj = (m.adjuntos || []).find(a => a.id === adjuntoId);
  if (!adj || !adj.path) return res.status(404).json({ error: 'Adjunto no encontrado' });

  try {
    const upstream = await descargarArchivoStorage(adj.path);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', adj.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(adj.nombre)}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
