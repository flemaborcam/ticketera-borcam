/* Ticketera — frontend conectado a la API real (reemplaza al prototipo de un solo archivo) */

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || 'Error de red');
  return data;
}

let session = null;
let cache = { tickets: [], usuarios: [], clientes: [], respuestas: [], automatizaciones: [], configuracion: {}, documentosEdificio: [], documentosCliente: [], perfilCliente: null, edificiosCliente: [], serviciosTecnicos: [], catalogoCostos: [], proveedores: [] };
let CAT = { ESTADOS: [], CATEGORIAS: [], PRIORIDADES: [], CARGOS: [], ROLES_CLIENTE: [], EDIFICIOS: [] };
let state = {
  view: 'login', authView: 'login', ticketId: null,
  filters: { estado: 'todos', categoria: 'todas', prioridad: 'todas', grupo: 'todos', agente: 'todos', fecha: '', search: '' },
  replyTab: 'saliente', authError: '', regError: '', modal: null, toast: null,
  pendingAttachments: [], editandoPasos: [], editAutomatizacionId: null, editGrupoId: null, selectedTickets: new Set(), paginaTickets: 1,
  filtersReservas: { estado: 'Abierto', prioridad: 'todas', search: '' }, paginaReservas: 1, paginaReservasAgendadas: 1,
  newsletterDestinatarios: [], newsletterAdjuntos: [],
  reportes: null, reportesCargando: false, reportesUsuario: 'todos', reportesRango: 'este-mes',
  reportesDesde: '', reportesHasta: ''
};

/* ---------------- Modo oscuro/claro ---------------- */
// Si el usuario ya eligió un modo a mano, se respeta esa elección (queda guardada). Si nunca lo
// tocó, sigue automáticamente el modo del sistema operativo (y lo actualiza si lo cambia mientras
// la página sigue abierta).
function temaDelSistema() {
  try { return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }
  catch (e) { return 'light'; }
}
function temaInicial() {
  try {
    const guardado = localStorage.getItem('tema');
    if (guardado === 'light' || guardado === 'dark') return guardado;
  } catch (e) {}
  return temaDelSistema();
}
function aplicarTema(tema, guardarEleccion) {
  document.documentElement.setAttribute('data-theme', tema);
  if (guardarEleccion) { try { localStorage.setItem('tema', tema); } catch (e) {} }
}
function toggleTema() {
  const actual = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  aplicarTema(actual === 'dark' ? 'light' : 'dark', true);
  render();
}
aplicarTema(temaInicial(), false);
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let elegidoAMano = null;
    try { elegidoAMano = localStorage.getItem('tema'); } catch (err) {}
    if (!elegidoAMano) { aplicarTema(e.matches ? 'dark' : 'light', false); render(); }
  });
} catch (e) {}

function uid() { return 'tmp-' + Math.random().toString(36).slice(2, 10); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDateTime(iso) { return new Date(iso).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
// Junta todas las direcciones que estuvieron en copia en el ticket para pre-cargar el campo "CC" al
// responder, sacando siempre la propia casilla de soporte: nunca tiene sentido ponerse en copia a uno
// mismo, y si quedó guardada en algún mensaje viejo (de antes de filtrarla en el ingreso), no la
// arrastramos al formulario para evitar que alguien la mande sin darse cuenta.
function ccSugeridoParaTicket(t) {
  const casilla = (cache.configuracion.casillaEmail || '').toLowerCase();
  return (t.mensajes || []).flatMap(m => m.cc || [])
    .filter((v, i, arr) => v && arr.indexOf(v) === i && v.toLowerCase() !== casilla)
    .join(', ');
}
function fmtRel(iso) { const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'ahora'; if (m < 60) return m + ' min'; const h = Math.floor(m / 60); if (h < 24) return h + ' h'; return Math.floor(h / 24) + ' d'; }
function slug(s) { return s.toLowerCase().replace(/\s+/g, '-'); }
function initials(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase(); }
function showToast(msg) { state.toast = msg; render(); setTimeout(() => { state.toast = null; render(); }, 2600); }

function mapTicket(row) {
  return {
    id: row.id, numero: row.numero, asunto: row.asunto, categoria: row.categoria, prioridad: row.prioridad, estado: row.estado,
    edificio: row.edificio || '',
    remitenteNombre: row.remitente_nombre, remitenteEmail: row.remitente_email,
    asignadoA: row.asignado_a, grupoId: row.cliente_id, edificioNombre: row.edificio_nombre || null, creado: row.creado, actualizado: row.actualizado,
    necesitaAtencion: !!row.necesita_atencion,
    mensajes: (row.mensajes || []).map(mapMensaje),
    mensajesTexto: row.mensajes_texto || (row.mensajes || []).map(m => m.cuerpo || '').join(' '),
    ultimoMensajeTipo: row.ultimo_msg_tipo || null,
    ultimoMensajeFecha: row.ultimo_msg_fecha || null,
    serviciosTecnicos: row.serviciosTecnicos || [],
    reservasCalendario: row.reservasCalendario || [],
    reservasPendientes: row.reservas_pendientes !== undefined ? Number(row.reservas_pendientes) || 0 : (row.reservasCalendario || []).filter(r => r.estado === 'pendiente').length,
    reservasTotal: row.reservas_total !== undefined ? Number(row.reservas_total) || 0 : (row.reservasCalendario || []).length,
    satisfaccion: row.satisfaccion || null,
    historialCliente: row.historialCliente || [],
    checklistEstado: row.checklist_estado || {}
  };
}
function mapMensaje(m) {
  return { id: m.id, tipo: m.tipo, autor: m.autor, cuerpo: m.cuerpo, cuerpoHtml: m.cuerpo_html || null, cc: m.cc || [], adjuntos: m.adjuntos || [], firmaHtml: m.firma_html || '', destinatarios: m.destinatarios || [], automatico: m.automatico, fecha: m.fecha };
}

/* ---------------- Bootstrap / sesión ---------------- */

async function boot() {
  try {
    const r = await api('GET', '/api/auth/me');
    if (r.session && r.session.type === 'staff') {
      session = r.session; state.view = 'dashboard'; await loadStaffData();
      iniciarSondeoDeNotificaciones();
      const idDesdeUrl = new URLSearchParams(window.location.search).get('ticket');
      if (idDesdeUrl) { state.view = 'ticket'; state.ticketId = idDesdeUrl; }
    } else if (r.session && r.session.type === 'cliente') {
      session = r.session; state.view = 'cliente-dashboard';
      // Se trae el perfil ya acá (no solo cuando entra a "Mi perfil") porque el rol del cliente
      // (Administración, Edificio, Apartamento…) decide qué pestañas del portal se le muestran.
      await Promise.all([loadClienteTickets(), api('GET', '/api/portal/perfil').then(p => { cache.perfilCliente = p; })]);
    }
  } catch (e) {}
  render();
  if (state.view === 'ticket' && state.ticketId) refreshTicket(state.ticketId).then(render);
}

/* ---------------- Aviso de tickets nuevos / respuestas del cliente ---------------- */
// Cada 60 segundos, mientras hay una sesión de staff abierta (aunque la pestaña esté en segundo
// plano), se fija si aparecieron tickets nuevos o si un cliente respondió uno existente, y si es
// así suena un aviso y muestra un toast. La primera vez que corre solo guarda la "foto" de cómo
// está todo, para no sonar apenas se abre la página con tickets que ya estaban ahí.
let notifSondeoIniciado = false;
let notifTicketsConocidos = null;
function iniciarSondeoDeNotificaciones() {
  if (notifSondeoIniciado) return;
  notifSondeoIniciado = true;
  notifTicketsConocidos = new Map(cache.tickets.filter(t => !esTicketDeReserva(t)).map(t => [t.id, t.necesitaAtencion]));
  setInterval(verificarTicketsNuevos, 60000);
}
// Evita pisar lo que el agente está escribiendo (una respuesta, un formulario) si justo en ese
// momento se dispara el chequeo automático: en ese caso los datos igual se actualizan, pero la
// pantalla no se refresca hasta la próxima acción del agente.
function puedeRefrescarSinInterrumpir() {
  const activo = document.activeElement;
  if (activo && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activo.tagName)) return false;
  if (state.modal) return false;
  return true;
}
function reproducirSonidoAviso() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const ahora = ctx.currentTime;
    [880, 1108].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ahora + i * 0.15;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.2, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.32);
    });
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch (e) {}
}
async function verificarTicketsNuevos() {
  if (!session || session.type !== 'staff') return;
  try {
    const filas = await api('GET', '/api/tickets');
    const nuevos = filas.map(mapTicket);
    if (!notifTicketsConocidos) {
      cache.tickets = nuevos;
      notifTicketsConocidos = new Map(nuevos.filter(t => !esTicketDeReserva(t)).map(t => [t.id, t.necesitaAtencion]));
      return;
    }
    let ticketsNuevos = 0, respuestasCliente = 0;
    nuevos.forEach(t => {
      if (esTicketDeReserva(t)) return;
      if (!notifTicketsConocidos.has(t.id)) ticketsNuevos++;
      else if (t.necesitaAtencion && !notifTicketsConocidos.get(t.id)) respuestasCliente++;
    });
    cache.tickets = nuevos;
    notifTicketsConocidos = new Map(nuevos.filter(t => !esTicketDeReserva(t)).map(t => [t.id, t.necesitaAtencion]));
    if (ticketsNuevos || respuestasCliente) {
      reproducirSonidoAviso();
      // showToast() hace un render() completo de la pantalla: si el agente está justo escribiendo
      // algo (una respuesta, un formulario), lo salteamos para no borrarle lo que tiene sin
      // guardar — el sonido ya le avisó, y la cantidad se va a actualizar sola en el próximo render.
      if (puedeRefrescarSinInterrumpir()) {
        const partes = [];
        if (ticketsNuevos) partes.push(`${ticketsNuevos} ticket${ticketsNuevos === 1 ? '' : 's'} nuevo${ticketsNuevos === 1 ? '' : 's'}`);
        if (respuestasCliente) partes.push(`${respuestasCliente} respuesta${respuestasCliente === 1 ? '' : 's'} de cliente`);
        showToast('🔔 ' + partes.join(' · '));
      }
    }
  } catch (e) {}
}

async function loadStaffData() {
  const [tickets, usuarios, clientes, respuestas, automatizaciones, configuracion, catalogos, documentosLegales, documentosEdificio] = await Promise.all([
    api('GET', '/api/tickets'), api('GET', '/api/usuarios'), api('GET', '/api/clientes'),
    api('GET', '/api/respuestas'), api('GET', '/api/automatizaciones'), api('GET', '/api/configuracion'),
    api('GET', '/api/catalogos'), api('GET', '/api/documentos-legales'), api('GET', '/api/documentos')
  ]);
  cache.tickets = tickets.map(mapTicket);
  cache.usuarios = usuarios;
  cache.clientes = clientes.map(c => ({ id: c.id, nombre: c.nombre, direccion: c.direccion, telefono: c.telefono, correo: c.correo, rol: c.rol, contactoNombre: c.contacto_nombre, rolCliente: c.rol_cliente, tienePortal: c.tiene_portal, administradoPorId: c.administrado_por_id, administradoPorNombre: c.administrado_por_nombre, esMantenimiento: c.es_mantenimiento }));
  cache.respuestas = respuestas;
  cache.automatizaciones = automatizaciones.map(a => ({ id: a.id, nombre: a.nombre, activo: a.activo, pasos: a.pasos.map(p => ({ id: p.id, matchAny: p.match_any, palabras: p.palabras || [], respuestaId: p.respuesta_id, accionEstado: p.accion_estado, soloNuevoTicket: !!p.solo_nuevo_ticket })) }));
  cache.configuracion = configuracion;
  cache.documentosLegales = documentosLegales;
  cache.documentosEdificio = documentosEdificio;
  CAT = catalogos;
}

async function refreshTicket(id) {
  const [t, aceptaciones] = await Promise.all([
    api('GET', '/api/tickets/' + id),
    api('GET', `/api/tickets/${id}/aceptaciones`)
  ]);
  const mapped = mapTicket(t);
  mapped.aceptaciones = aceptaciones;
  const idx = cache.tickets.findIndex(x => x.id === id);
  if (idx >= 0) cache.tickets[idx] = mapped; else cache.tickets.unshift(mapped);
  return mapped;
}

/* ---------------- Auth ---------------- */

function currentUser() { return session && session.type === 'staff' ? session.usuario : null; }
// Devuelve el contenido del círculo de avatar: la foto de perfil si el usuario ya subió una,
// o sus iniciales como antes. Se usa en el menú lateral, el chip del panel y "Mi perfil".
function avatarInner(u) {
  return u.foto_path ? `<img src="/api/usuarios/${u.id}/foto" alt="">` : escapeHtml(initials(u.nombre, u.apellido));
}
function currentGrupo() { return session && session.type === 'cliente' ? session.cliente : null; }

async function handleLogin(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    const r = await api('POST', '/api/auth/login', { email: fd.get('email'), password: fd.get('password') });
    const me = await api('GET', '/api/auth/me');
    session = me.session;
    state.authError = '';
    if (r.type === 'staff') { state.view = 'dashboard'; await loadStaffData(); iniciarSondeoDeNotificaciones(); }
    else { state.view = 'cliente-dashboard'; await loadClienteTickets(); }
  } catch (e) { state.authError = e.message; }
  render();
  return false;
}

async function handleRegister(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const password = fd.get('password'), password2 = fd.get('password2');
  if (password !== password2) { state.regError = 'Las contraseñas no coinciden.'; render(); return false; }
  try {
    await api('POST', '/api/auth/register', {
      nombre: fd.get('nombre'), apellido: fd.get('apellido'), telefono: fd.get('telefono'),
      email: fd.get('email'), cargo: fd.get('cargo'), password
    });
    const me = await api('GET', '/api/auth/me');
    session = me.session; state.regError = ''; state.view = 'dashboard';
    await loadStaffData();
    iniciarSondeoDeNotificaciones();
  } catch (e) { state.regError = e.message; }
  render();
  return false;
}

async function handleRegisterCliente(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const password = fd.get('password'), password2 = fd.get('password2');
  if (password !== password2) { state.regError = 'Las contraseñas no coinciden.'; render(); return false; }
  try {
    await api('POST', '/api/auth/register-cliente', {
      nombre: fd.get('nombre'), direccion: fd.get('direccion'), telefono: fd.get('telefono'),
      correo: fd.get('correo'), rol: fd.get('rol'), password
    });
    const me = await api('GET', '/api/auth/me');
    session = me.session; state.regError = ''; state.view = 'cliente-dashboard';
    await loadClienteTickets();
  } catch (e) { state.regError = e.message; }
  render();
  return false;
}

async function logout() {
  await api('POST', '/api/auth/logout');
  session = null; state.view = 'login'; state.authView = 'login'; state.clienteDocumentosCargados = false;
  cache = { tickets: [], usuarios: [], clientes: [], respuestas: [], automatizaciones: [], configuracion: {}, documentosEdificio: [], documentosCliente: [], perfilCliente: null, edificiosCliente: [], serviciosTecnicos: [], catalogoCostos: [] };
  notifTicketsConocidos = null; // para que el próximo login arranque con una foto nueva, no la de otra sesión
  render();
}
function goAuth(mode) { state.authView = mode; state.authError = ''; state.regError = ''; render(); }
function go(view) {
  if ((state.view === 'dashboard' || state.view === 'reservas') && view !== state.view) state.selectedTickets.clear();
  if (view === 'tags' && state.view !== 'tags') state.tagsPrecarga = null; // al entrar por el menú normal, sin datos precargados de un ticket
  state.view = view;
  render();
  if (view === 'estadisticas' && !state.reportes && !state.reportesCargando) cargarReportes();
}

function toggleSeleccionTicket(id, checked) {
  if (checked) state.selectedTickets.add(id); else state.selectedTickets.delete(id);
  render();
}
function limpiarSeleccion() { state.selectedTickets.clear(); render(); }

async function aplicarAccionMasivaEstado() {
  const val = document.getElementById('bulk-estado').value;
  if (!val) { showToast('Elegí un estado para aplicar.'); return; }
  const ids = Array.from(state.selectedTickets);
  for (const id of ids) { await api('PATCH', '/api/tickets/' + id, { estado: val }); }
  cache.tickets = (await api('GET', '/api/tickets')).map(mapTicket);
  showToast(`Estado actualizado en ${ids.length} ticket${ids.length === 1 ? '' : 's'}.`);
  limpiarSeleccion();
}
async function aplicarAccionMasivaAgente() {
  const val = document.getElementById('bulk-agente').value;
  if (!val) { showToast('Elegí una opción de asignación.'); return; }
  const asignadoA = val === 'ninguno' ? null : val;
  const ids = Array.from(state.selectedTickets);
  for (const id of ids) { await api('PATCH', '/api/tickets/' + id, { asignadoA }); }
  cache.tickets = (await api('GET', '/api/tickets')).map(mapTicket);
  showToast(`Agente actualizado en ${ids.length} ticket${ids.length === 1 ? '' : 's'}.`);
  limpiarSeleccion();
}

async function aplicarAccionMasivaEliminar() {
  const ids = Array.from(state.selectedTickets);
  if (!ids.length) return;
  if (!confirm(`¿Eliminar ${ids.length} ticket${ids.length === 1 ? '' : 's'} definitivamente? Esta acción no se puede deshacer.`)) return;
  for (const id of ids) { await api('DELETE', '/api/tickets/' + id); }
  cache.tickets = cache.tickets.filter(t => !state.selectedTickets.has(t.id));
  showToast(`${ids.length} ticket${ids.length === 1 ? '' : 's'} eliminado${ids.length === 1 ? '' : 's'}.`);
  limpiarSeleccion();
}

/* ---------------- Tickets (staff) ---------------- */

function fechaLocal(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hoyStr() { return fechaLocal(new Date().toISOString()); }

const SLA_HORAS = { Alta: 24, Media: 48, Baja: 72 };
const SLA_HORA_INICIO = 9, SLA_HORA_FIN = 18; // horario laboral: lunes a viernes de 9 a 18hs
function horasHabilesEntre(inicio, fin) {
  if (!(fin > inicio)) return 0;
  let horas = 0;
  let cursor = new Date(inicio);
  while (cursor < fin) {
    const dia = cursor.getDay(); // 0=domingo, 6=sábado
    if (dia === 0 || dia === 6) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
      continue;
    }
    const inicioDia = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), SLA_HORA_INICIO, 0, 0, 0);
    const finDia = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), SLA_HORA_FIN, 0, 0, 0);
    const tramoInicio = cursor < inicioDia ? inicioDia : cursor;
    const finVentana = fin < finDia ? fin : finDia;
    if (tramoInicio < finVentana) horas += (finVentana - tramoInicio) / 3600000;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
  }
  return horas;
}
function ticketVencido(t) {
  if (['Esperando al Cliente', 'Cerrado', 'Resuelto'].includes(t.estado)) return false;
  if (t.ultimoMensajeTipo !== 'entrante' || !t.ultimoMensajeFecha) return false;
  const horas = horasHabilesEntre(new Date(t.ultimoMensajeFecha), new Date());
  const umbral = SLA_HORAS[t.prioridad] || 48;
  return horas >= umbral;
}

function filteredTickets() {
  const f = state.filters;
  return cache.tickets
    .filter(t => !esTicketDeReserva(t))
    .filter(t => f.estado === 'todos' ? (t.estado !== 'Cerrado' && t.estado !== 'Resuelto') : t.estado === f.estado)
    .filter(t => f.categoria === 'todas' || t.categoria === f.categoria)
    .filter(t => f.prioridad === 'todas' || t.prioridad === f.prioridad)
    .filter(t => f.grupo === 'todos' || t.grupoId === f.grupo)
    .filter(t => f.agente === 'todos' ? true : (f.agente === 'sin-asignar' ? !t.asignadoA : t.asignadoA === f.agente))
    .filter(t => !f.fecha || fechaLocal(t.creado) === f.fecha)
    .filter(t => { if (!f.search) return true; const s = f.search.toLowerCase(); return t.asunto.toLowerCase().includes(s) || t.numero.toLowerCase().includes(s) || t.remitenteNombre.toLowerCase().includes(s) || t.remitenteEmail.toLowerCase().includes(s) || (t.edificio || '').toLowerCase().includes(s) || (t.mensajesTexto || '').toLowerCase().includes(s); })
    .sort((a, b) => new Date(b.actualizado) - new Date(a.actualizado));
}
function setFilter(k, v) { state.filters[k] = v; state.paginaTickets = 1; render(); }
const TICKETS_POR_PAGINA = 20;
function irAPagina(n) { state.paginaTickets = n; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

async function openTicket(id) {
  state.ticketId = id; state.view = 'ticket'; state.replyTab = 'saliente'; state.pendingAttachments = [];
  render();
  await refreshTicket(id);
  render();
}
function setReplyTab(tab) { state.replyTab = tab; state.pendingAttachments = []; render(); }

async function updateTicketField(id, field, value) {
  const body = {};
  body[field] = value === '' ? null : value;
  await api('PATCH', '/api/tickets/' + id, body);
  if (field === 'estado' && value === 'Esperando al Cliente') showToast('Correo automático enviado al cliente.');
  await refreshTicket(id);
  render();
}
async function tomarTicket(id) {
  try {
    await api('POST', '/api/tickets/' + id + '/tomar');
    await refreshTicket(id);
    render();
  } catch (e) {
    showToast(e.message);
    await refreshTicket(id);
    render();
  }
}

async function eliminarTicket(id) {
  const t = cache.tickets.find(x => x.id === id);
  if (!confirm(`¿Eliminar el ticket ${t ? t.numero : ''} definitivamente? Esta acción no se puede deshacer y borra toda la conversación.`)) return;
  try {
    await api('DELETE', '/api/tickets/' + id);
    cache.tickets = cache.tickets.filter(x => x.id !== id);
    showToast('Ticket eliminado.');
    go('dashboard');
  } catch (e) { showToast(e.message); }
}
function openFusionarTicketModal(id) { state.modal = 'fusionar-ticket'; state.fusionarTicketId = id; state.fusionarBusqueda = ''; render(); }
function refreshFusionarLista() {
  const el = document.getElementById('fusionar-lista');
  if (el) el.innerHTML = renderFusionarLista();
}
function onFusionarBusquedaChange(input) { state.fusionarBusqueda = input.value; refreshFusionarLista(); }
function renderFusionarLista() {
  const q = (state.fusionarBusqueda || '').trim().toLowerCase();
  const candidatos = cache.tickets
    .filter(t => t.id !== state.fusionarTicketId)
    .filter(t => !q || t.numero.toLowerCase().includes(q) || t.asunto.toLowerCase().includes(q) || (t.remitenteNombre || '').toLowerCase().includes(q) || (t.remitenteEmail || '').toLowerCase().includes(q))
    .slice(0, 30);
  if (!candidatos.length) return `<div class="empty-state" style="padding:20px;"><div class="big" style="font-size:14px;">Sin resultados</div></div>`;
  return candidatos.map(t => `
    <label class="stub" style="cursor:pointer;padding:10px 12px;">
      <input type="radio" name="fusionarOtroId" value="${t.id}" style="margin-right:10px;">
      <div class="stub-body" style="min-width:0;">
        <div class="stub-top"><div class="stub-asunto" style="font-size:13.5px;">${t.numero} · ${escapeHtml(t.asunto)}</div></div>
        <div class="stub-remitente" style="font-size:12px;">${escapeHtml(t.remitenteNombre)} · ${escapeHtml(t.remitenteEmail)}</div>
      </div>
    </label>`).join('');
}
function renderFusionarTicketModal() {
  const t = cache.tickets.find(x => x.id === state.fusionarTicketId);
  if (!t) return '';
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>Fusionar con otro ticket</h2>
    <p class="sub">Vas a fusionar <strong>${t.numero} · ${escapeHtml(t.asunto)}</strong> con el que elijas abajo. Todos los mensajes van a quedar juntos en este ticket, y el otro se elimina.</p>
    <form onsubmit="return submitFusionarTicket(event)">
      <div class="field"><label>Buscar ticket (número, asunto o remitente)</label><input type="text" oninput="onFusionarBusquedaChange(this)" placeholder="Escribí para buscar…"></div>
      <div id="fusionar-lista" style="max-height:280px;overflow-y:auto;border:1px solid var(--line);border-radius:10px;">${renderFusionarLista()}</div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">Fusionar</button></div>
    </form></div></div>`;
}
async function submitFusionarTicket(ev) {
  ev.preventDefault();
  const otroTicketId = document.querySelector('input[name="fusionarOtroId"]:checked')?.value;
  if (!otroTicketId) { showToast('Elegí con qué ticket fusionar.'); return false; }
  if (!confirm('¿Fusionar los dos tickets? Esta acción no se puede deshacer.')) return false;
  try {
    const destinoId = state.fusionarTicketId;
    await api('POST', `/api/tickets/${destinoId}/fusionar`, { otroTicketId });
    cache.tickets = (await api('GET', '/api/tickets')).map(mapTicket);
    state.modal = null;
    showToast('Tickets fusionados.');
    state.view = 'ticket'; state.ticketId = destinoId;
    render();
  } catch (e) { showToast(e.message); }
  return false;
}

function openNuevoCorreoModal() { state.modal = 'nuevo-correo'; render(); }
function closeModal() { state.modal = null; state.editandoPasos = []; state.editandoServicioTecnicoId = null; state.pendingAttachments = []; state.pendingPresupuestos = []; state.pendingCostosServicio = []; state.documentoEdificioArchivo = null; state.fusionarTicketId = null; state.fusionarBusqueda = ''; state.catalogoCostoEditId = null; render(); }

async function submitNuevoCorreo(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    const r = await api('POST', '/api/tickets', {
      remitenteNombre: fd.get('remitenteNombre'), remitenteEmail: fd.get('remitenteEmail'),
      asunto: fd.get('asunto'), cuerpo: fd.get('cuerpo')
    });
    const mapped = mapTicket(r.ticket);
    cache.tickets.unshift(mapped);
    state.modal = null;
    openTicket(mapped.id);
    if (!r.automatizado) showToast('Nuevo ticket creado: ' + mapped.numero);
  } catch (e) { showToast(e.message); }
  return false;
}

const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
function attachIcon(t) { return t === 'imagen' ? '&#128247;' : t === 'video' ? '&#127909;' : t === 'pdf' ? '&#128196;' : '&#128206;'; }
function fmtSize(b) { return b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / (1024 * 1024)).toFixed(1) + ' MB'; }
function tipoAdjunto(mime) { if (mime.startsWith('image/')) return 'imagen'; if (mime.startsWith('video/')) return 'video'; if (mime === 'application/pdf') return 'pdf'; return 'archivo'; }
function renderPendingChips() {
  if (!state.pendingAttachments.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">${state.pendingAttachments.map(a => `
    <span class="tag tag-cat" style="gap:6px;padding:6px 10px;">${attachIcon(a.tipo)} ${escapeHtml(a.nombre)} <span style="opacity:.7;">(${fmtSize(a.size)})</span>
    <button type="button" onclick="removePendingAttachment('${a.id}')" style="border:none;background:none;cursor:pointer;color:var(--stamp-red);font-weight:700;padding:0 0 0 4px;">&times;</button></span>`).join('')}</div>`;
}
function refreshPendingChips() { const el = document.getElementById('pending-attachments'); if (el) el.innerHTML = renderPendingChips(); }
function addPendingAttachments(input) {
  Array.from(input.files || []).forEach(file => {
    if (file.size > ATTACH_MAX_BYTES) { showToast(`"${file.name}" pesa demasiado (máx. 20 MB).`); return; }
    const reader = new FileReader();
    reader.onload = () => { state.pendingAttachments.push({ id: uid(), nombre: file.name, tipo: tipoAdjunto(file.type || ''), size: file.size, dataUrl: reader.result }); refreshPendingChips(); };
    reader.readAsDataURL(file);
  });
  input.value = '';
}
function removePendingAttachment(id) { state.pendingAttachments = state.pendingAttachments.filter(a => a.id !== id); refreshPendingChips(); }

async function submitReply(ev, ticketId) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const cuerpo = fd.get('cuerpo').trim();
  if (!cuerpo) return false;
  try {
    if (state.replyTab === 'saliente') {
      const ccRaw = (fd.get('cc') || '').trim();
      const cc = ccRaw ? ccRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      await api('POST', `/api/tickets/${ticketId}/mensajes`, {
        tipo: 'saliente', cuerpo, cc, adjuntos: state.pendingAttachments, incluirFirma: fd.get('incluirFirma') === 'on',
        documentoLegalId: fd.get('documentoLegalId') || null
      });
      state.pendingAttachments = [];
    } else if (state.replyTab === 'nota') {
      await api('POST', `/api/tickets/${ticketId}/mensajes`, { tipo: 'nota', cuerpo });
    } else {
      await api('POST', `/api/tickets/${ticketId}/mensajes`, { tipo: 'entrante', cuerpo });
    }
    await refreshTicket(ticketId);
    render();
  } catch (e) { showToast(e.message); }
  return false;
}

/* ---------------- Clientes ---------------- */

async function loadClienteDetalleTickets(id) {
  const rows = await api('GET', `/api/clientes/${id}/tickets`);
  return rows.map(mapTicket);
}
function openGrupoDetail(id) { state.view = 'grupo'; state.grupoId = id; render(); }
function openNuevoGrupoModal() { state.modal = 'nuevo-grupo'; state.editGrupoId = null; render(); }
function openEditarGrupoModal(id) { state.modal = 'editar-grupo'; state.editGrupoId = id; render(); }

async function submitGrupo(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const payload = { nombre: fd.get('nombre'), direccion: fd.get('direccion'), telefono: fd.get('telefono'), correo: fd.get('correo'), rol: fd.get('rol'), contactoNombre: fd.get('contactoNombre'), rolCliente: fd.get('rolCliente'), portalPassword: (fd.get('portalPassword') || '').trim(), administradoPorId: fd.get('administradoPorId') || null, esMantenimiento: fd.get('esMantenimiento') === 'on' };
  try {
    if (state.modal === 'editar-grupo') await api('PUT', '/api/clientes/' + state.editGrupoId, payload);
    else await api('POST', '/api/clientes', payload);
    cache.clientes = (await api('GET', '/api/clientes')).map(c => ({ id: c.id, nombre: c.nombre, direccion: c.direccion, telefono: c.telefono, correo: c.correo, rol: c.rol, contactoNombre: c.contacto_nombre, rolCliente: c.rol_cliente, tienePortal: c.tiene_portal, administradoPorId: c.administrado_por_id, administradoPorNombre: c.administrado_por_nombre, esMantenimiento: c.es_mantenimiento }));
    state.modal = null;
    render();
  } catch (e) { showToast(e.message); }
  return false;
}
async function deleteGrupo(id) {
  if (!confirm('¿Eliminar este cliente? Los tickets asignados quedarán sin cliente.')) return;
  await api('DELETE', '/api/clientes/' + id);
  cache.clientes = cache.clientes.filter(g => g.id !== id);
  cache.tickets.forEach(t => { if (t.grupoId === id) t.grupoId = null; });
  go('grupos');
}

/* ---------------- Respuestas predefinidas ---------------- */

function openNuevaRespuestaModal() { state.modal = 'nueva-respuesta'; state.editRespuestaId = null; render(); }
function openEditarRespuestaModal(id) { state.modal = 'editar-respuesta'; state.editRespuestaId = id; render(); }
async function submitRespuesta(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const titulo = fd.get('titulo').trim(), cuerpo = fd.get('cuerpo').trim();
  if (!titulo || !cuerpo) return false;
  if (state.modal === 'editar-respuesta') await api('PUT', '/api/respuestas/' + state.editRespuestaId, { titulo, cuerpo });
  else await api('POST', '/api/respuestas', { titulo, cuerpo });
  cache.respuestas = await api('GET', '/api/respuestas');
  state.modal = null; render();
  return false;
}
async function deleteRespuesta(id) {
  if (!confirm('¿Eliminar esta respuesta predefinida?')) return;
  await api('DELETE', '/api/respuestas/' + id);
  cache.respuestas = cache.respuestas.filter(r => r.id !== id);
  render();
}
function insertCanned(selectEl) {
  const id = selectEl.value; if (!id) return;
  const c = cache.respuestas.find(x => x.id === id);
  const textarea = selectEl.closest('form').querySelector('textarea[name="cuerpo"]');
  if (c && textarea) { textarea.value = c.cuerpo; textarea.focus(); }
  selectEl.value = '';
}

/* ---------------- Documentos legales (firma electrónica) ---------------- */

function openNuevoDocumentoModal() { state.modal = 'nuevo-documento'; state.editDocumentoId = null; render(); }
function openEditarDocumentoModal(id) { state.modal = 'editar-documento'; state.editDocumentoId = id; render(); }
async function submitDocumento(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const nombre = fd.get('nombre').trim(), texto = fd.get('texto').trim(), activo = fd.get('activo') === 'on';
  if (!nombre || !texto) return false;
  if (state.modal === 'editar-documento') await api('PUT', '/api/documentos-legales/' + state.editDocumentoId, { nombre, texto, activo });
  else await api('POST', '/api/documentos-legales', { nombre, texto });
  cache.documentosLegales = await api('GET', '/api/documentos-legales');
  state.modal = null; render();
  return false;
}
async function deleteDocumento(id) {
  if (!confirm('¿Eliminar este documento? No afecta a las aceptaciones ya firmadas (quedan igual con su copia guardada).')) return;
  await api('DELETE', '/api/documentos-legales/' + id);
  cache.documentosLegales = cache.documentosLegales.filter(d => d.id !== id);
  render();
}
function renderDocumentos() {
  const rows = cache.documentosLegales.map(d => `
    <div class="card" style="margin-bottom:12px;opacity:${d.activo ? '1' : '.55'};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-weight:600;font-size:14.5px;">${escapeHtml(d.nombre)}</span>
            <span class="tag ${d.activo ? 'tag-resuelto' : 'tag-cerrado'}">${d.activo ? 'Activo' : 'Pausado'}</span>
          </div>
          <div style="font-size:13px;color:var(--ink-soft);white-space:pre-wrap;max-height:80px;overflow:hidden;">${escapeHtml(d.texto.slice(0, 220))}${d.texto.length > 220 ? '…' : ''}</div>
        </div>
        <div style="display:flex;gap:8px;flex:none;">
          <button class="btn btn-ghost" onclick="openEditarDocumentoModal('${d.id}')">Editar</button>
          <button class="btn btn-danger" onclick="deleteDocumento('${d.id}')">Eliminar</button>
        </div>
      </div>
    </div>`).join('');
  const list = cache.documentosLegales.length ? rows : `<div class="empty-state"><div class="big">Todavía no hay documentos cargados</div></div>`;
  return `<div class="page-head"><div><h1>Documentos</h1><div class="sub">Descargos u otros textos que el cliente puede leer y aceptar con firma electrónica al responder un ticket</div></div><button class="btn btn-primary" onclick="openNuevoDocumentoModal()">+ Nuevo documento</button></div>${list}`;
}

/* ---------------- Documentos del edificio (actas, manuales, contratos) ---------------- */
const CATEGORIAS_DOCUMENTO_EDIFICIO = ['Acta de servicio', 'Manual', 'Contrato', 'Reglamento', 'Otro'];
function renderDocumentosEdificio() {
  const rows = cache.documentosEdificio.map(d => `
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:14.5px;">${escapeHtml(d.nombre)}</span>
            <span class="tag">${escapeHtml(d.categoria)}</span>
          </div>
          <div style="font-size:13px;color:var(--ink-soft);">${d.cliente_nombre ? `Edificio: ${escapeHtml(d.cliente_nombre)}` : 'Visible para todos los clientes'} · Subido por ${escapeHtml(d.subido_por || '—')} · ${fmtDateTime(d.creado)}</div>
        </div>
        <div style="display:flex;gap:8px;flex:none;">
          <a class="btn btn-ghost" href="/api/documentos/${d.id}/descargar" target="_blank" rel="noopener">Ver</a>
          <button class="btn btn-danger" onclick="deleteDocumentoEdificio('${d.id}')">Eliminar</button>
        </div>
      </div>
    </div>`).join('');
  const list = cache.documentosEdificio.length ? rows : `<div class="empty-state"><div class="big">Todavía no subiste documentos</div></div>`;
  return `<div class="page-head"><div><h1>Documentos edificio</h1><div class="sub">Actas de servicio, manuales o contratos que el cliente puede ver y descargar desde su portal</div></div><button class="btn btn-primary" onclick="openNuevoDocumentoEdificioModal()">+ Subir documento</button></div>${list}`;
}
function openNuevoDocumentoEdificioModal() { state.modal = 'nuevo-documento-edificio'; state.documentoEdificioArchivo = null; render(); }
function onDocumentoEdificioFileChange(input) {
  const file = (input.files || [])[0];
  if (!file) return;
  if (file.size > ATTACH_MAX_BYTES) { showToast('El archivo pesa demasiado (máx. 20 MB).'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    state.documentoEdificioArchivo = { nombre: file.name, size: file.size, dataUrl: reader.result };
    const nombreInput = document.querySelector('#nuevo-documento-edificio-form [name="nombre"]');
    if (nombreInput && !nombreInput.value) nombreInput.value = file.name;
    const info = document.getElementById('documento-edificio-archivo-info');
    if (info) info.textContent = `Archivo elegido: ${file.name}`;
  };
  reader.readAsDataURL(file);
}
function renderNuevoDocumentoEdificioModal() {
  // Los apartamentos no tienen documentos propios: siempre ven los del Edificio del que dependen.
  // Por eso no aparecen acá como destino — subir algo "a" un apartamento no tendría efecto.
  const clientesOpts = cache.clientes.filter(c => c.rolCliente !== 'Apartamento').map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('');
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>Subir documento</h2><p class="sub">El cliente lo va a ver en su portal, en la sección Documentos.</p>
    <form id="nuevo-documento-edificio-form" onsubmit="return submitNuevoDocumentoEdificio(event)">
      <div class="field"><label>Archivo</label><input type="file" accept="image/*,application/pdf" onchange="onDocumentoEdificioFileChange(this)" required><div class="hint-text" id="documento-edificio-archivo-info">PDF o imagen, máx. 20 MB.</div></div>
      <div class="field"><label>Nombre</label><input name="nombre" placeholder="Ej: Acta de asamblea marzo 2026" required></div>
      <div class="field"><label>Categoría</label><select name="categoria">${CATEGORIAS_DOCUMENTO_EDIFICIO.map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
      <div class="field"><label>Edificio / cliente</label><select name="clienteId"><option value="">Todos los clientes</option>${clientesOpts}</select></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">Subir</button></div>
    </form></div></div>`;
}
async function submitNuevoDocumentoEdificio(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const nombre = fd.get('nombre').trim();
  const categoria = fd.get('categoria');
  const clienteId = fd.get('clienteId') || null;
  if (!nombre) return false;
  if (!state.documentoEdificioArchivo) { showToast('Elegí un archivo.'); return false; }
  try {
    await api('POST', '/api/documentos', { nombre, categoria, clienteId, dataUrl: state.documentoEdificioArchivo.dataUrl });
    cache.documentosEdificio = await api('GET', '/api/documentos');
    state.documentoEdificioArchivo = null;
    closeModal();
    showToast('Documento subido.');
  } catch (e) { showToast(e.message); }
  return false;
}
async function deleteDocumentoEdificio(id) {
  if (!confirm('¿Eliminar este documento? El cliente ya no va a poder verlo.')) return;
  try {
    await api('DELETE', '/api/documentos/' + id);
    cache.documentosEdificio = cache.documentosEdificio.filter(d => d.id !== id);
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Automatizaciones ---------------- */

function openNuevaAutomatizacionModal() {
  state.modal = 'nueva-automatizacion'; state.editAutomatizacionId = null;
  state.editandoPasos = [{ id: uid(), matchAny: false, palabras: '', respuestaId: cache.respuestas[0] ? cache.respuestas[0].id : '', accionEstado: 'Sin cambio', soloNuevoTicket: false }];
  render();
}
function openEditarAutomatizacionModal(id) {
  const a = cache.automatizaciones.find(x => x.id === id);
  state.modal = 'editar-automatizacion'; state.editAutomatizacionId = id;
  state.editandoPasos = a ? a.pasos.map(p => ({ id: p.id, matchAny: !!p.matchAny, palabras: (p.palabras || []).join(', '), respuestaId: p.respuestaId, accionEstado: p.accionEstado || 'Sin cambio', soloNuevoTicket: !!p.soloNuevoTicket })) : [];
  render();
}
function leerPasosDesdeDom() {
  return Array.from(document.querySelectorAll('.paso-row')).map(row => ({
    id: row.dataset.pasoId, matchAny: row.querySelector('[data-field="matchAny"]').checked,
    palabras: row.querySelector('[data-field="palabras"]').value, respuestaId: row.querySelector('[data-field="respuestaId"]').value,
    accionEstado: row.querySelector('[data-field="accionEstado"]').value,
    soloNuevoTicket: row.querySelector('[data-field="soloNuevoTicket"]') ? row.querySelector('[data-field="soloNuevoTicket"]').checked : false
  }));
}
function refreshPasosEditor() { const el = document.getElementById('pasos-container'); if (el) el.innerHTML = renderPasosEditor(); }
function agregarPasoEditor() {
  state.editandoPasos = leerPasosDesdeDom();
  state.editandoPasos.push({ id: uid(), matchAny: true, palabras: '', respuestaId: cache.respuestas[0] ? cache.respuestas[0].id : '', accionEstado: 'Sin cambio', soloNuevoTicket: false });
  refreshPasosEditor();
}
function quitarPasoEditor(id) { state.editandoPasos = leerPasosDesdeDom().filter(p => p.id !== id); refreshPasosEditor(); }
function onPasoMatchAnyChange(id, checked) {
  const row = document.querySelector(`.paso-row[data-paso-id="${id}"]`); if (!row) return;
  const wrap = row.querySelector('[data-field-wrap="palabras"]'); if (wrap) wrap.style.display = checked ? 'none' : '';
}
async function submitAutomatizacion(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const nombre = fd.get('nombre').trim(), activo = fd.get('activo') === 'on';
  if (!nombre) return false;
  const pasosRaw = leerPasosDesdeDom();
  if (!pasosRaw.length) { showToast('Agregá al menos un paso.'); return false; }
  const pasos = [];
  for (const p of pasosRaw) {
    if (!p.respuestaId) { showToast('Elegí una respuesta predefinida en cada paso.'); return false; }
    if (!p.matchAny && !p.palabras.trim()) { showToast('Completá palabras clave o marcá "cualquier respuesta".'); return false; }
    pasos.push({ matchAny: p.matchAny, palabras: p.matchAny ? [] : p.palabras.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), respuestaId: p.respuestaId, accionEstado: p.accionEstado, soloNuevoTicket: p.soloNuevoTicket });
  }
  try {
    if (state.modal === 'editar-automatizacion') await api('PUT', '/api/automatizaciones/' + state.editAutomatizacionId, { nombre, activo, pasos });
    else await api('POST', '/api/automatizaciones', { nombre, activo, pasos });
    const autos = await api('GET', '/api/automatizaciones');
    cache.automatizaciones = autos.map(a => ({ id: a.id, nombre: a.nombre, activo: a.activo, pasos: a.pasos.map(p => ({ id: p.id, matchAny: p.match_any, palabras: p.palabras || [], respuestaId: p.respuesta_id, accionEstado: p.accion_estado, soloNuevoTicket: !!p.solo_nuevo_ticket })) }));
    state.modal = null; state.editandoPasos = [];
    render();
  } catch (e) { showToast(e.message); }
  return false;
}
async function deleteAutomatizacion(id) {
  if (!confirm('¿Eliminar esta automatización?')) return;
  await api('DELETE', '/api/automatizaciones/' + id);
  cache.automatizaciones = cache.automatizaciones.filter(a => a.id !== id);
  render();
}
async function toggleAutomatizacion(id) {
  await api('POST', '/api/automatizaciones/' + id + '/toggle');
  const a = cache.automatizaciones.find(x => x.id === id); if (a) a.activo = !a.activo;
  render();
}

/* ---------------- Perfil / firma ---------------- */

async function submitPerfil(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    await api('PUT', '/api/usuarios/me', { nombre: fd.get('nombre'), apellido: fd.get('apellido'), telefono: fd.get('telefono'), cargo: fd.get('cargo'), password: fd.get('password') || undefined });
    const me = await api('GET', '/api/auth/me');
    session = me.session;
    showToast('Perfil actualizado.');
    render();
  } catch (e) { showToast(e.message); }
  return false;
}
function signCmd(cmd) { const e = document.getElementById('firma-editor'); e.focus(); document.execCommand(cmd, false, null); }
function insertFirmaImage(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) { showToast('La imagen es muy pesada (máx. 1.5 MB).'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { const e = document.getElementById('firma-editor'); e.focus(); document.execCommand('insertImage', false, reader.result); };
  reader.readAsDataURL(file); input.value = '';
}
function clearFirma() { const e = document.getElementById('firma-editor'); e.innerHTML = ''; e.focus(); }
async function subirFotoPerfil(input) {
  const file = input.files[0]; if (!file) return;
  if (!file.type.startsWith('image/')) { showToast('Elegí un archivo de imagen.'); input.value = ''; return; }
  if (file.size > 5 * 1024 * 1024) { showToast('La imagen no puede pesar más de 5 MB.'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const r = await api('PUT', '/api/usuarios/me/foto', { dataUrl: reader.result });
      session.usuario.foto_path = r.fotoPath;
      showToast('Foto de perfil actualizada.');
      render();
    } catch (e) { showToast(e.message); }
  };
  reader.readAsDataURL(file); input.value = '';
}
async function quitarFotoPerfil() {
  if (!confirm('¿Quitar tu foto de perfil?')) return;
  try {
    await api('DELETE', '/api/usuarios/me/foto');
    session.usuario.foto_path = null;
    showToast('Foto de perfil eliminada.');
    render();
  } catch (e) { showToast(e.message); }
}
async function saveFirma() {
  const html = document.getElementById('firma-editor').innerHTML.trim();
  await api('PUT', '/api/usuarios/me/firma', { html });
  session.usuario.firma_html = html;
  showToast('Firma guardada.');
  render();
}

async function generarCodigoTelegram() {
  const el = document.getElementById('codigo-telegram');
  try {
    const r = await api('POST', '/api/usuarios/me/telegram/generar-codigo');
    if (el) el.innerHTML = `
      <div class="hint-text">Abrí Telegram, entrá a la conversación con nuestro bot y mandale por privado este código:</div>
      <div style="font-family:monospace;font-size:20px;font-weight:700;letter-spacing:2px;background:var(--brand-tint);color:var(--brand);padding:10px 14px;border-radius:8px;text-align:center;margin-top:8px;">${r.codigo}</div>
      <div class="hint-text" style="margin-top:8px;">En cuanto lo recibamos, se vincula solo (puede tardar hasta 1 minuto).</div>`;
  } catch (e) { showToast(e.message); }
}
async function desvincularTelegram() {
  if (!confirm('¿Desvincular tu Telegram? Vas a dejar de recibir recordatorios privados hasta que lo vuelvas a vincular.')) return;
  await api('POST', '/api/usuarios/me/telegram/desvincular');
  session.usuario.telegram_chat_id = null;
  showToast('Telegram desvinculado.');
  render();
}

/* ---------------- Calendario de instalaciones ---------------- */

const DIAS_SEMANA = [['lunes', 'Lunes'], ['martes', 'Martes'], ['miercoles', 'Miércoles'], ['jueves', 'Jueves'], ['viernes', 'Viernes'], ['sabado', 'Sábado'], ['domingo', 'Domingo']];

async function renderCalendarioAsync() {
  const [cfgData, citas, serviciosTecnicos] = await Promise.all([api('GET', '/api/calendario-config'), api('GET', '/api/citas'), api('GET', '/api/servicios-tecnicos')]);
  cache.calendarioConfig = cfgData.config || {};
  cache.calendarioEdificios = cfgData.edificios || [];
  cache.googleServiceEmail = cfgData.googleServiceEmail;
  cache.citas = citas;
  cache.serviciosTecnicos = serviciosTecnicos;
  return renderCalendarioHtml();
}

function generarVistaPreviaCalendario() {
  const form = document.getElementById('form-calendario');
  const fd = new FormData(form);
  const mapaIngles = { lunes: 'Mon', martes: 'Tue', miercoles: 'Wed', jueves: 'Thu', viernes: 'Fri', sabado: 'Sat', domingo: 'Sun' };
  const bloques = [];

  DIAS_SEMANA.forEach(([key, label]) => {
    if (fd.get('activo_' + key) !== 'on') return;
    const asign = {};
    [1, 2, 3, 4, 5].forEach(n => { const v = fd.get(`oc_${key}_${n}`); if (v) asign[n] = v; });

    const filas = [];
    const hoy = new Date();
    for (let i = 0; i < 90 && filas.length < 8; i++) {
      const d = new Date(hoy.getTime() + i * 86400000);
      const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Montevideo', weekday: 'short' }).format(d);
      if (wd !== mapaIngles[key]) continue;
      const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      const ocurrencia = Math.ceil(Number(dateStr.split('-')[2]) / 7);
      const fechaLegible = d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Montevideo' });
      filas.push({ fechaLegible, ocurrencia, asignado: asign[ocurrencia] || null });
    }
    bloques.push({ label, filas });
  });

  const el = document.getElementById('vista-previa-calendario');
  if (!bloques.length) { el.innerHTML = `<div class="hint-text">No hay ningún día activo para mostrar.</div>`; return; }

  el.innerHTML = bloques.map(b => `
    <div style="margin-bottom:14px;">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:6px;">${b.label}</div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        ${b.filas.map(f => `
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 10px;background:var(--paper);border-radius:6px;">
            <span>${f.fechaLegible} <span style="color:var(--ink-soft);">(${f.ocurrencia}° del mes)</span></span>
            <strong style="color:${f.asignado ? 'var(--brand)' : 'var(--ink-soft)'};">${f.asignado ? escapeHtml(f.asignado) : 'Sin restricción'}</strong>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

async function submitCalendarioConfig(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const diasHorarios = {};
  DIAS_SEMANA.forEach(([key]) => {
    const asignacionOcurrencias = {};
    [1, 2, 3, 4, 5].forEach(n => {
      const v = (fd.get(`oc_${key}_${n}`) || '').trim();
      if (v) asignacionOcurrencias[n] = v;
    });
    diasHorarios[key] = { activo: fd.get('activo_' + key) === 'on', inicio: fd.get('inicio_' + key) || '09:00', fin: fd.get('fin_' + key) || '18:00', asignacionOcurrencias };
  });
  const config = {
    activo: fd.get('agendaActiva') === 'on',
    duracionMinutos: Number(fd.get('duracionMinutos')) || 60,
    minNoticeDays: Number(fd.get('minNoticeDays')),
    diasVisibles: Number(fd.get('diasVisibles')) || 21,
    googleCalendarId: fd.get('googleCalendarId').trim(),
    diasHorarios
  };
  const edificios = fd.get('edificios').split('\n').map(s => s.trim()).filter(Boolean);
  try {
    await api('PUT', '/api/calendario-config', { config });
    await api('PUT', '/api/calendario-edificios', { edificios });
    showToast('Configuración de agenda guardada.');
    render();
  } catch (e) { showToast(e.message); }
  return false;
}

async function probarGoogleCalendar() {
  const el = document.getElementById('resultado-google');
  el.innerHTML = 'Probando…';
  try {
    const r = await api('POST', '/api/calendario-config/probar');
    el.innerHTML = `<span style="color:var(--stamp-green);font-weight:600;">Conectado a: ${escapeHtml(r.nombre)} ✓</span>`;
  } catch (e) { el.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`; }
}

function copiarEnlaceAgenda() {
  const url = window.location.origin + '/agendar';
  navigator.clipboard.writeText(url).then(() => showToast('Enlace copiado.'));
}

function renderCalendarioHtml() {
  const c = cache.calendarioConfig || {};
  const horarios = c.diasHorarios || {};
  const edificiosDisponibles = cache.calendarioEdificios || [];
  const filasDias = DIAS_SEMANA.map(([key, label]) => {
    const h = horarios[key] || {};
    const asign = h.asignacionOcurrencias || {};
    const selectsOcurrencia = [1, 2, 3, 4, 5].map(n => `
      <div>
        <label style="font-size:10.5px;color:var(--ink-soft);display:block;margin-bottom:2px;">${n}° del mes</label>
        <select name="oc_${key}_${n}" style="width:100%;padding:6px 4px;font-size:12px;border:1px solid var(--line-strong);border-radius:6px;">
          <option value="">Sin restricción</option>
          ${edificiosDisponibles.map(e => `<option value="${escapeHtml(e)}" ${asign[n] === e ? 'selected' : ''}>${escapeHtml(e)}</option>`).join('')}
        </select>
      </div>`).join('');
    return `<div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:10px;">
      <div class="field-row" style="align-items:center;margin-bottom:8px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;width:110px;flex:none;text-transform:none;letter-spacing:0;font-weight:500;">
          <input type="checkbox" name="activo_${key}" ${h.activo ? 'checked' : ''}> ${label}
        </label>
        <input type="time" name="inicio_${key}" value="${h.inicio || '09:00'}" style="max-width:110px;">
        <span style="color:var(--ink-soft);">a</span>
        <input type="time" name="fin_${key}" value="${h.fin || '18:00'}" style="max-width:110px;">
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;">${selectsOcurrencia}</div>
    </div>`;
  }).join('');

  const subTab = state.calendarioSubTab || 'config';
  const subTabsHtml = [
    { v: 'config', label: 'Configuración' },
    { v: 'domotica', label: '🏠 Domótica' }
  ].map(s => `<button class="reply-tab ${subTab === s.v ? 'active' : ''}" type="button" onclick="cambiarCalendarioSubTab('${s.v}')">${s.label}</button>`).join('');

  const tab = state.calendarioTab || 'turnos';
  const tabsHtml = [
    { v: 'turnos', label: 'Próximos turnos' },
    { v: 'realizados', label: 'Agenda realizada' }
  ].map(t => `<button class="reply-tab ${tab === t.v ? 'active' : ''}" type="button" onclick="cambiarCalendarioTab('${t.v}')">${t.label}</button>`).join('');

  let contenido;
  if (subTab === 'config') {
    contenido = renderCalendarioConfigTab(c, filasDias);
  } else {
    contenido = `
      <div class="reply-tabs">${tabsHtml}</div>
      ${tab === 'turnos' ? renderCalendarioListaCitas(ci => ci.estado !== 'realizada', 'No hay turnos próximos ni pendientes.') : ''}
      ${tab === 'realizados' ? renderCalendarioListaCitas(ci => ci.estado === 'realizada', 'Todavía no hay ninguna instalación marcada como realizada.') : ''}`;
  }

  return `
    <div class="page-head"><div><h1>Calendario</h1><div class="sub">Configuración general y agenda de instalaciones (domótica). El servicio técnico ahora tiene su propia sección.</div></div></div>
    <div class="reply-tabs" style="margin-bottom:14px;">${subTabsHtml}</div>
    ${contenido}`;
}
function cambiarCalendarioSubTab(t) { state.calendarioSubTab = t; render(); }
function cambiarCalendarioTab(t) { state.calendarioTab = t; render(); }
/* ---------------- Servicio Técnico (módulo propio del panel lateral) ----------------
   Turnos que se cargan desde el botón "📅 Agendar servicio técnico" de un ticket, o desde
   "+ Nuevo turno" acá mismo (sin ticket). Cada turno puede llevar costos (catálogo o puntuales,
   en pesos o dólares, sin conversión entre monedas) y presupuestos adjuntos que el cliente ve y
   aprueba desde el portal antes de que se pueda avanzar con la tarea. */
async function renderServicioTecnicoModuloAsync() {
  const [servicios, catalogo] = await Promise.all([api('GET', '/api/servicios-tecnicos'), api('GET', '/api/catalogo-costos')]);
  cache.serviciosTecnicos = servicios;
  cache.catalogoCostos = catalogo;
  return renderServicioTecnicoTab();
}
function refrescarVistaServicioTecnico() {
  const el = document.querySelector('.content');
  if (el && state.view === 'servicio-tecnico') el.innerHTML = renderServicioTecnicoTab();
}
function renderServicioTecnicoTab() {
  const tab = state.servicioTecnicoTab || 'turnos';
  const tabsHtml = [
    { v: 'turnos', label: 'Próximos turnos' },
    { v: 'realizados', label: 'Servicios Realizados' },
    { v: 'reporte', label: '📊 Reporte mensual' },
    { v: 'catalogo', label: '💲 Costos precargados' },
    { v: 'plantillas', label: '🔧 Plantillas de mantenimiento' }
  ].map(t => `<button class="reply-tab ${tab === t.v ? 'active' : ''}" type="button" onclick="cambiarServicioTecnicoTab('${t.v}')">${t.label}</button>`).join('');
  let contenido;
  if (tab === 'catalogo') {
    contenido = renderCatalogoCostosTab();
  } else if (tab === 'reporte') {
    contenido = renderReporteMensualDashboardTab();
  } else if (tab === 'plantillas') {
    contenido = renderPlantillasMantenimientoTab();
  } else {
    const filtro = tab === 'realizados' ? (s => s.estado === 'realizado') : (s => s.estado !== 'realizado');
    const mensajeVacio = tab === 'realizados' ? 'Todavía no hay ningún servicio técnico marcado como realizado.' : 'No hay turnos de servicio técnico próximos ni pendientes.';
    contenido = renderServicioTecnicoLista(filtro, mensajeVacio);
  }
  return `
    <div class="page-head"><div><h1>Servicio Técnico</h1><div class="sub">Agenda de visitas, costos y presupuestos para tareas de servicio técnico.</div></div>
      <div style="display:flex;gap:8px;">
        ${tab !== 'catalogo' && tab !== 'reporte' && tab !== 'plantillas' ? `<button type="button" class="btn btn-primary" onclick="openNuevoServicioTecnicoModal()">+ Nuevo turno</button>` : ''}
      </div>
    </div>
    <div class="reply-tabs" style="margin-bottom:14px;">${tabsHtml}</div>
    ${contenido}`;
}
function cambiarServicioTecnicoTab(t) {
  state.servicioTecnicoTab = t;
  render();
  if (t === 'reporte') cargarReporteMensualDashboard();
  if (t === 'plantillas') cargarPlantillasMantenimiento();
}
// --- Plantillas de mantenimiento: una por sistema, con secciones e ítems editables. Se copian tal
// cual al generar cada turno de mantenimiento, así una edición posterior no afecta visitas ya hechas.
async function cargarPlantillasMantenimiento() {
  if (cache.plantillasMantenimiento) { refrescarVistaServicioTecnico(); return; }
  try { cache.plantillasMantenimiento = await api('GET', '/api/plantillas-mantenimiento'); }
  catch (e) { cache.plantillasMantenimiento = []; }
  refrescarVistaServicioTecnico();
}
function renderPlantillasMantenimientoTab() {
  const plantillas = cache.plantillasMantenimiento;
  if (!plantillas) return '<div class="empty-state">Cargando…</div>';
  return `<div class="page-head" style="margin-top:0;"><div></div><button type="button" class="btn btn-ghost" onclick="abrirNuevaPlantillaMantenimiento()">+ Nueva plantilla</button></div>
    <div class="stub-list">${plantillas.map(p => `
    <div class="user-row" style="border:1px solid var(--line);">
      <div class="avatar" style="cursor:pointer;" onclick="abrirEditarPlantillaMantenimiento('${escapeHtml(p.sistema)}')">🔧</div>
      <div style="flex:1;cursor:pointer;" onclick="abrirEditarPlantillaMantenimiento('${escapeHtml(p.sistema)}')"><div class="u-name">${escapeHtml(p.sistema)}</div>
        <div class="u-sub">${(p.secciones || []).length} sección${(p.secciones || []).length === 1 ? '' : 'es'} · ${(p.secciones || []).reduce((n, s) => n + (s.items || []).length, 0)} ítems</div></div>
      <button type="button" class="btn btn-ghost" onclick="event.stopPropagation(); duplicarPlantillaMantenimiento('${escapeHtml(p.sistema)}')">Duplicar</button>
      <button type="button" class="btn btn-ghost" onclick="abrirEditarPlantillaMantenimiento('${escapeHtml(p.sistema)}')">Editar</button>
    </div>`).join('')}</div>`;
}
function abrirEditarPlantillaMantenimiento(sistema) {
  state.editandoPlantillaSistema = sistema;
  state.plantillaEditorSecciones = null;
  state.modal = 'plantilla-mantenimiento';
  render();
}
// Para un sistema nuevo que no está en la lista (por ejemplo, uno específico de un solo cliente,
// como el sensor de cable perimetral de Canarias): se pide el nombre y arranca con una sección vacía
// para completar a mano.
function abrirNuevaPlantillaMantenimiento() {
  const nombre = (prompt('Nombre del sistema (ej: Intrepid MicroPoint II)') || '').trim();
  if (!nombre) return;
  if ((cache.plantillasMantenimiento || []).some(p => p.sistema === nombre)) { showToast('Ya existe una plantilla con ese nombre.'); return; }
  state.editandoPlantillaSistema = nombre;
  state.plantillaEditorSecciones = [{ nombre: '', items: [''] }];
  state.modal = 'plantilla-mantenimiento';
  render();
}
function agregarSeccionPlantillaEditor() {
  state.plantillaEditorSecciones.push({ nombre: '', items: [''] });
  render();
}
function quitarSeccionPlantillaEditor(idx) {
  state.plantillaEditorSecciones.splice(idx, 1);
  render();
}
// El textarea de ítems guarda un texto por línea; se separa recién al guardar (así no se pierden
// líneas vacías mientras se está escribiendo o pegando un bloque grande).
function actualizarItemsPlantillaEditorDesdeTextarea(secIdx, texto) {
  state.plantillaEditorSecciones[secIdx].itemsTexto = texto;
}
function renderPlantillaMantenimientoModal() {
  const sistema = state.editandoPlantillaSistema;
  if (!state.plantillaEditorSecciones) {
    const p = (cache.plantillasMantenimiento || []).find(x => x.sistema === sistema);
    state.plantillaEditorSecciones = JSON.parse(JSON.stringify((p && p.secciones) || []));
  }
  const secciones = state.plantillaEditorSecciones;
  return `<div class="modal-backdrop" onclick="if(event.target===this) cerrarPlantillaMantenimientoModal()"><div class="modal" style="max-width:620px;">
    <h2>🔧 Plantilla: ${escapeHtml(sistema)}</h2>
    <p class="sub">Estos son los puntos que se copian a cada visita de mantenimiento que use este sistema. En "Ítems" va uno por línea — podés pegar una lista entera de una sola vez.</p>
    <form onsubmit="return guardarPlantillaMantenimiento(event)">
      <div style="display:flex;flex-direction:column;gap:14px;margin-bottom:14px;">
        ${secciones.map((sec, secIdx) => `
          <div style="border:1px solid var(--line);border-radius:10px;padding:10px;">
            <div class="field-row" style="align-items:center;">
              <input type="text" value="${escapeHtml(sec.nombre)}" placeholder="Nombre de la sección" oninput="state.plantillaEditorSecciones[${secIdx}].nombre=this.value" style="flex:1;">
              <button type="button" class="btn btn-ghost" onclick="quitarSeccionPlantillaEditor(${secIdx})">Quitar sección</button>
            </div>
            <textarea rows="${Math.min(Math.max((sec.items || []).length, 3), 14)}" placeholder="Un ítem por línea" style="width:100%;margin-top:8px;font-family:inherit;font-size:13px;" oninput="actualizarItemsPlantillaEditorDesdeTextarea(${secIdx}, this.value)">${escapeHtml((sec.itemsTexto !== undefined ? sec.itemsTexto : (sec.items || []).join('\n')))}</textarea>
          </div>`).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-block" style="margin-bottom:16px;" onclick="agregarSeccionPlantillaEditor()">+ Agregar sección</button>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="cerrarPlantillaMantenimientoModal()">Cancelar</button><button type="submit" class="btn btn-primary">Guardar plantilla</button></div>
    </form></div></div>`;
}
function cerrarPlantillaMantenimientoModal() {
  state.modal = null;
  state.plantillaEditorSecciones = null;
  render();
}
async function guardarPlantillaMantenimiento(ev) {
  ev.preventDefault();
  const secciones = state.plantillaEditorSecciones.map(sec => ({
    nombre: sec.nombre,
    items: (sec.itemsTexto !== undefined ? sec.itemsTexto.split('\n') : (sec.items || [])).map(x => x.trim()).filter(Boolean)
  }));
  try {
    const actualizado = await api('PUT', `/api/plantillas-mantenimiento/${encodeURIComponent(state.editandoPlantillaSistema)}`, { secciones });
    const idx = (cache.plantillasMantenimiento || []).findIndex(x => x.sistema === actualizado.sistema);
    if (idx >= 0) cache.plantillasMantenimiento[idx] = actualizado; else cache.plantillasMantenimiento.push(actualizado);
    cerrarPlantillaMantenimientoModal();
  } catch (e) { showToast(e.message); }
  return false;
}
// Duplica una plantilla entera con otro nombre (por ejemplo, para armar la Torre D copiando la C) —
// se puede ajustar lo que cambie desde el editor una vez creada.
async function duplicarPlantillaMantenimiento(sistemaOrigen) {
  const nombre = (prompt(`Nombre de la nueva plantilla (copia de "${sistemaOrigen}")`) || '').trim();
  if (!nombre) return;
  if ((cache.plantillasMantenimiento || []).some(p => p.sistema === nombre)) { showToast('Ya existe una plantilla con ese nombre.'); return; }
  const origen = (cache.plantillasMantenimiento || []).find(p => p.sistema === sistemaOrigen);
  if (!origen) return;
  try {
    const actualizado = await api('PUT', `/api/plantillas-mantenimiento/${encodeURIComponent(nombre)}`, { secciones: origen.secciones });
    cache.plantillasMantenimiento.push(actualizado);
    showToast(`Plantilla "${nombre}" creada como copia de "${sistemaOrigen}".`);
    render();
  } catch (e) { showToast(e.message); }
}
// --- Reporte mensual de servicios técnicos realizados (control interno, no es factura DGI) ---
// Se puede ver como dashboard acá en la sección (tab "Reporte mensual") o bajar en PDF desde ese
// mismo dashboard, o desde el modal rápido que se abre con abrirReporteMensualServicios().
function mesActualDefault() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
}
function rangoDelMes(mes) {
  const [anio, mesNum] = mes.split('-').map(Number);
  const desde = `${mes}-01T00:00:00-03:00`;
  const siguiente = mesNum === 12 ? `${anio + 1}-01` : `${anio}-${String(mesNum + 1).padStart(2, '0')}`;
  const hasta = `${siguiente}-01T00:00:00-03:00`;
  return { desde, hasta };
}
// Agrupa las filas del reporte por cliente/edificio y calcula subtotales y total general por
// moneda, respetando si cada servicio tenía tildado o no el IVA. La usan tanto el dashboard en
// pantalla como el PDF, para no duplicar la lógica.
function agruparServiciosParaReporte(filas) {
  const porCliente = {};
  const totalGeneral = {};
  filas.forEach(s => {
    const nombre = s.cliente_nombre || 'Sin cliente';
    if (!porCliente[nombre]) porCliente[nombre] = { servicios: [], totales: {} };
    const subtotalesServicio = {};
    (s.costos || []).forEach(c => { subtotalesServicio[c.moneda] = (subtotalesServicio[c.moneda] || 0) + Number(c.cantidad) * Number(c.precio_unitario); });
    Object.entries(subtotalesServicio).forEach(([m, sub]) => {
      const total = Math.round(s.aplica_iva !== false ? sub * (1 + IVA_RATE) : sub);
      porCliente[nombre].totales[m] = (porCliente[nombre].totales[m] || 0) + total;
      totalGeneral[m] = (totalGeneral[m] || 0) + total;
    });
    porCliente[nombre].servicios.push(s);
  });
  return { porCliente, totalGeneral };
}
async function cargarReporteMensualDashboard(mesNuevo) {
  const mes = mesNuevo || state.reporteMensualMes || mesActualDefault();
  state.reporteMensualMes = mes;
  cache.reporteMensualDatos = null;
  refrescarVistaServicioTecnico();
  try {
    const { desde, hasta } = rangoDelMes(mes);
    const filas = await api('GET', `/api/servicios-tecnicos/reporte?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
    cache.reporteMensualDatos = { mes, filas };
  } catch (e) {
    cache.reporteMensualDatos = { mes, filas: [], error: e.message };
  }
  refrescarVistaServicioTecnico();
}
function cambiarMesReporteMensualDashboard(mes) {
  if (!mes) return;
  cargarReporteMensualDashboard(mes);
}
async function descargarPdfReporteMensualDashboard() {
  const mes = state.reporteMensualMes || mesActualDefault();
  try {
    let filas;
    if (cache.reporteMensualDatos && cache.reporteMensualDatos.mes === mes && !cache.reporteMensualDatos.error) {
      filas = cache.reporteMensualDatos.filas;
    } else {
      const { desde, hasta } = rangoDelMes(mes);
      filas = await api('GET', `/api/servicios-tecnicos/reporte?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
    }
    await cargarJsPdf();
    construirPdfReporteMensualServicios(filas, mes);
  } catch (e) { showToast(e.message); }
}
function renderReporteMensualDashboardTab() {
  const mes = state.reporteMensualMes || mesActualDefault();
  const datos = cache.reporteMensualDatos;
  const cabecera = `
    <div class="page-head" style="margin-top:6px;align-items:center;">
      <div>
        <h1 style="font-size:18px;">Reporte mensual</h1>
        <div class="sub">Servicios marcados como realizados en el mes elegido, agrupados por cliente/edificio.</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="month" value="${mes}" onchange="cambiarMesReporteMensualDashboard(this.value)">
        <button type="button" class="btn btn-ghost" onclick="descargarPdfReporteMensualDashboard()">📄 Bajar PDF</button>
      </div>
    </div>`;

  if (!datos || datos.mes !== mes) {
    return `${cabecera}<div class="hint-text">Cargando reporte…</div>`;
  }
  if (datos.error) {
    return `${cabecera}<div class="hint-text">No se pudo cargar el reporte: ${escapeHtml(datos.error)}</div>`;
  }
  const filas = datos.filas || [];
  if (!filas.length) {
    return `${cabecera}<div class="hint-text">No hubo servicios técnicos marcados como realizados en este mes.</div>`;
  }
  const { porCliente, totalGeneral } = agruparServiciosParaReporte(filas);
  const clientesOrdenados = Object.entries(porCliente).sort((a, b) => b[1].servicios.length - a[1].servicios.length);

  const tarjetasTotales = Object.entries(totalGeneral).map(([m, total]) => `
    <div class="stat-card">
      <div class="stat-card-label">Total del mes (${escapeHtml(m)})</div>
      <div class="stat-card-value">${escapeHtml(m)} ${total}</div>
    </div>`).join('');

  const filasClientes = clientesOrdenados.map(([nombre, d]) => `
    <div class="user-row" style="border:1px solid var(--line);align-items:flex-start;">
      <div class="avatar">🏢</div>
      <div style="flex:1;">
        <div class="u-name">${escapeHtml(nombre)}</div>
        <div class="u-sub">${d.servicios.length} servicio${d.servicios.length === 1 ? '' : 's'} realizado${d.servicios.length === 1 ? '' : 's'}</div>
      </div>
      <div style="text-align:right;font-weight:600;">
        ${Object.entries(d.totales).map(([m, total]) => `<div>${escapeHtml(m)} ${total}</div>`).join('')}
      </div>
    </div>`).join('');

  return `${cabecera}
    <div class="stat-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin:14px 0 18px;">${tarjetasTotales}</div>
    <div class="page-head" style="margin-top:6px;"><div><h1 style="font-size:15px;">${filas.length} servicio${filas.length === 1 ? '' : 's'} realizado${filas.length === 1 ? '' : 's'} en ${clientesOrdenados.length} cliente${clientesOrdenados.length === 1 ? '' : 's'}</h1></div></div>
    <div class="user-list" style="display:flex;flex-direction:column;gap:8px;">${filasClientes}</div>`;
}
function abrirReporteMensualServicios() {
  state.modal = 'reporte-mensual-servicios';
  render();
}
function renderReporteMensualServiciosModal() {
  const hoy = new Date();
  const mesDefault = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>📊 Reporte mensual de servicios técnicos</h2>
    <div class="field"><label>Mes</label><input type="month" id="reporte-servicios-mes" value="${mesDefault}"></div>
    <div class="hint-text">Incluye los servicios marcados como realizados en ese mes, agrupados por cliente/edificio.</div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn-primary" onclick="generarReporteMensualServicios()">📄 Generar PDF</button>
    </div>
  </div></div>`;
}
async function generarReporteMensualServicios() {
  const mes = document.getElementById('reporte-servicios-mes').value;
  if (!mes) { showToast('Elegí un mes.'); return; }
  const [anio, mesNum] = mes.split('-').map(Number);
  const desde = `${mes}-01T00:00:00-03:00`;
  const siguiente = mesNum === 12 ? `${anio + 1}-01` : `${anio}-${String(mesNum + 1).padStart(2, '0')}`;
  const hasta = `${siguiente}-01T00:00:00-03:00`;
  try {
    const filas = await api('GET', `/api/servicios-tecnicos/reporte?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
    await cargarJsPdf();
    construirPdfReporteMensualServicios(filas, mes);
    closeModal();
  } catch (e) { showToast(e.message); }
}
function construirPdfReporteMensualServicios(filas, mes) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 15;
  let y = 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`Reporte mensual de Servicio Técnico — ${mes}`, marginX, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text('Control interno de Borcam — no reemplaza la facturación oficial ante DGI.', marginX, y);
  doc.setTextColor(0);
  y += 10;

  if (!filas.length) {
    doc.setFontSize(11);
    doc.text('No hubo servicios técnicos marcados como realizados en este mes.', marginX, y);
    doc.save(`Reporte servicio tecnico ${mes}.pdf`);
    return;
  }

  // Agrupa por cliente y suma los totales (con o sin IVA según lo que tenía tildado cada servicio).
  const { porCliente, totalGeneral } = agruparServiciosParaReporte(filas);

  doc.setFontSize(10);
  Object.entries(porCliente).forEach(([nombre, datos]) => {
    if (y > pageHeight - 40) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold');
    doc.text(nombre, marginX, y);
    y += 5.5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    datos.servicios.forEach(s => {
      if (y > pageHeight - 25) { doc.addPage(); y = 20; }
      const fecha = new Date(s.fecha_hora).toLocaleDateString('es-UY', { timeZone: 'America/Montevideo' });
      doc.text(`${fecha} — ${s.titulo}${s.comprobante_numero ? ' (' + s.comprobante_numero + ')' : ''}${s.aplica_iva === false ? ' [sin IVA]' : ''}`, marginX + 4, y);
      y += 5;
    });
    doc.setFont('helvetica', 'bold');
    Object.entries(datos.totales).forEach(([m, total]) => {
      doc.text(`Subtotal ${nombre}: ${m} ${total}`, marginX + 4, y);
      y += 5.5;
    });
    doc.setFontSize(10);
    y += 3;
  });

  if (y > pageHeight - 30) { doc.addPage(); y = 20; }
  doc.setDrawColor(180);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 7;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Total del mes', marginX, y);
  y += 6;
  doc.setFontSize(10);
  Object.entries(totalGeneral).forEach(([m, total]) => {
    doc.text(`${m} ${total}`, marginX, y);
    y += 6;
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text('BORCAM EQUIPAMIENTOS S.R.L — Av 8 de Octubre 2956, Montevideo — Tel.: 598+ 24878281 — administracion@borcam.com.uy', pageWidth / 2, pageHeight - 12, { align: 'center' });

  doc.save(`Reporte servicio tecnico ${mes}.pdf`);
}
function nombreClientePorId(id) { const c = cache.clientes.find(x => x.id === id); return c ? c.nombre : '—'; }
function renderServicioTecnicoLista(filtro, mensajeVacio) {
  const turnos = (cache.serviciosTecnicos || []).filter(filtro);
  const html = turnos.length ? turnos.map(s => `
    <button type="button" class="user-row" style="width:100%;text-align:left;border:1px solid var(--line);cursor:pointer;" onclick="abrirDetalleServicioTecnico('${s.id}')">
      <div class="avatar">🛠️</div>
      <div><div class="u-name">${escapeHtml(s.titulo)}${s.contrato_mantenimiento_id ? ' <span class="tag" style="margin-left:6px;">🔧 Mantenimiento</span>' : ''}${s.estado === 'realizado' ? ' <span class="tag tag-resuelto" style="margin-left:6px;">Realizado</span>' : s.estado === 'en_curso' ? ' <span class="tag tag-cat" style="margin-left:6px;">🚗 En curso</span>' : ''}${s.presupuesto_enviado ? (s.presupuesto_aprobado ? ' <span class="tag tag-resuelto" style="margin-left:6px;">Presupuesto aprobado</span>' : ' <span class="tag tag-cat" style="margin-left:6px;">Presupuesto enviado</span>') : ''}</div>
      <div class="u-sub">${escapeHtml(nombreClientePorId(s.cliente_id))} · ${s.todo_el_dia ? new Date(s.fecha_hora).toLocaleDateString('es-UY', { dateStyle: 'medium', timeZone: 'America/Montevideo' }) + ' · Todo el día' : new Date(s.fecha_hora).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' })}${s.ticket_numero ? ` · Ticket ${escapeHtml(s.ticket_numero)}` : ''}</div></div>
    </button>`).join('') : `<div class="hint-text">${mensajeVacio}</div>`;
  return `<div class="page-head" style="margin-top:6px;"><div><h1 style="font-size:18px;">${turnos.length} turno${turnos.length === 1 ? '' : 's'}</h1></div></div>
    <div class="user-list">${html}</div>`;
}
/* ---- Nuevo turno sin partir de un ticket (siempre pide cliente/edificio) ---- */
// Editor de costos reutilizado en los modales de "Nuevo turno" (con o sin ticket): permite dejar
// cargado desde el arranque el costo de la visita (del catálogo o puntual), sin tener que entrar
// después al detalle del turno ya creado. Los ítems quedan en state.pendingCostosServicio y recién
// se mandan al servidor cuando se confirma la creación del turno.
async function asegurarCatalogoCostosCargado() {
  if (!cache.catalogoCostos || !cache.catalogoCostos.length) {
    try { cache.catalogoCostos = await api('GET', '/api/catalogo-costos'); } catch (e) { cache.catalogoCostos = cache.catalogoCostos || []; }
  }
}
// Al elegir un ítem del catálogo, completa Descripción/Precio/Moneda con lo que tiene cargado ese
// ítem (igual se pueden pisar a mano antes de agregar el costo). "prefijo" es 'pendiente' (turno nuevo)
// o 'costo' (servicio ya existente), porque los ids de los inputs no se llaman igual en cada editor.
function autocompletarCostoDesdeCatalogo(prefijo) {
  const ids = prefijo === 'pendiente'
    ? { select: 'pendiente-costo-catalogo', desc: 'pendiente-costo-descripcion', precio: 'pendiente-costo-precio', moneda: 'pendiente-costo-moneda' }
    : { select: 'costo-catalogo-select', desc: 'costo-descripcion', precio: 'costo-precio', moneda: 'costo-moneda' };
  const catalogoItemId = document.getElementById(ids.select).value;
  const descInput = document.getElementById(ids.desc);
  const precioInput = document.getElementById(ids.precio);
  const monedaInput = document.getElementById(ids.moneda);
  if (!catalogoItemId) { descInput.value = ''; precioInput.value = ''; monedaInput.value = 'UYU'; return; }
  const item = (cache.catalogoCostos || []).find(c => String(c.id) === String(catalogoItemId));
  if (!item) return;
  descInput.value = item.nombre;
  precioInput.value = Number(item.precio);
  monedaInput.value = item.moneda;
}
function renderCostosPendientesEditor() {
  const items = state.pendingCostosServicio || [];
  const catalogoOptions = (cache.catalogoCostos || []).filter(c => c.activo).map(c => `<option value="${c.id}">${escapeHtml(c.nombre)} (${c.moneda} ${Math.round(Number(c.precio))} + IVA)</option>`).join('');
  return `<div style="border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:14px 0;margin-bottom:14px;">
    <div style="font-weight:600;font-size:14px;margin-bottom:8px;">💲 Costos (opcional)</div>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:${items.length ? '10px' : '0'};">
      ${items.map((c, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;">
          <div style="font-size:13px;">${escapeHtml(c.descripcion)} x${c.cantidad} — <strong>${c.moneda} ${Math.round(Number(c.cantidad) * Number(c.precioUnitario))}</strong> <span style="color:var(--ink-soft);">+ IVA</span></div>
          <button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;" onclick="quitarCostoPendiente(${i})">Quitar</button>
        </div>`).join('')}
    </div>
    <div class="field-row" style="align-items:flex-end;flex-wrap:wrap;">
      <div class="field" style="flex:1.4;min-width:180px;"><label>Del catálogo</label><select id="pendiente-costo-catalogo" onchange="autocompletarCostoDesdeCatalogo('pendiente')"><option value="">— Costo puntual (libre) —</option>${catalogoOptions}</select></div>
      <div class="field" style="flex:0.7;min-width:90px;"><label>Cant.</label><input type="number" id="pendiente-costo-cantidad" value="1" min="0.01" step="0.01"></div>
    </div>
    <div class="field-row" style="flex-wrap:wrap;">
      <div class="field" style="flex:1.6;min-width:160px;"><label style="display:block;min-height:28px;">Descripción</label><input type="text" id="pendiente-costo-descripcion" placeholder="Ej: Mano de obra"></div>
      <div class="field" style="flex:1;min-width:120px;"><label style="display:block;min-height:28px;">Precio (sin IVA)</label><input type="number" id="pendiente-costo-precio" min="0" step="0.01"></div>
      <div class="field" style="flex:0.6;min-width:100px;"><label style="display:block;min-height:28px;">Moneda</label><select id="pendiente-costo-moneda"><option value="UYU">$ UYU</option><option value="USD">US$</option></select></div>
    </div>
    <button type="button" class="btn btn-ghost" onclick="agregarCostoPendiente()">+ Agregar costo</button>
  </div>`;
}
function agregarCostoPendiente() {
  const catalogoItemId = document.getElementById('pendiente-costo-catalogo').value || null;
  const cantidad = document.getElementById('pendiente-costo-cantidad').value || 1;
  let descripcion = document.getElementById('pendiente-costo-descripcion').value;
  let precioUnitario = document.getElementById('pendiente-costo-precio').value;
  let moneda = document.getElementById('pendiente-costo-moneda').value;
  if (catalogoItemId) {
    const item = (cache.catalogoCostos || []).find(c => String(c.id) === String(catalogoItemId));
    if (!item) { showToast('Ese costo del catálogo ya no existe.'); return; }
    descripcion = descripcion && descripcion.trim() ? descripcion : item.nombre;
    precioUnitario = precioUnitario !== '' ? precioUnitario : item.precio;
    moneda = moneda || item.moneda;
  }
  if (!descripcion || !descripcion.trim()) { showToast('Escribí una descripción, o elegí un costo del catálogo.'); return; }
  if (precioUnitario === '' || isNaN(Number(precioUnitario))) { showToast('Escribí un precio.'); return; }
  state.pendingCostosServicio = state.pendingCostosServicio || [];
  state.pendingCostosServicio.push({ catalogoItemId, descripcion: descripcion.trim(), cantidad: Number(cantidad) || 1, precioUnitario: Number(precioUnitario), moneda: moneda === 'USD' ? 'USD' : 'UYU' });
  render();
}
function quitarCostoPendiente(i) {
  state.pendingCostosServicio = (state.pendingCostosServicio || []).filter((_, idx) => idx !== i);
  render();
}
// Aplica, después de crear el turno, los costos que se hayan dejado cargados en el modal.
async function aplicarCostosPendientes(servicioId) {
  const items = state.pendingCostosServicio || [];
  for (const c of items) {
    try { await api('POST', `/api/servicios-tecnicos/${servicioId}/costos`, c); } catch (e) { showToast(`No se pudo cargar el costo "${c.descripcion}": ${e.message}`); }
  }
  state.pendingCostosServicio = [];
}
function openNuevoServicioTecnicoModal() {
  state.modal = 'nuevo-servicio-tecnico';
  state.nuevoServicioTicketBusqueda = '';
  state.nuevoServicioTicketId = '';
  state.pendingCostosServicio = [];
  render();
  asegurarCatalogoCostosCargado().then(() => { if (state.modal === 'nuevo-servicio-tecnico') render(); });
}
function renderNuevoServicioTecnicoModal() {
  const ahora = new Date(Date.now() + 60 * 60000);
  const fechaDefault = ahora.toISOString().slice(0, 10);
  const horaDefault = ahora.toTimeString().slice(0, 5);
  const busqueda = (state.nuevoServicioTicketBusqueda || '').toLowerCase();
  const ticketsFiltrados = busqueda ? cache.tickets.filter(t => !esTicketDeReserva(t) && (t.numero.toLowerCase().includes(busqueda) || t.asunto.toLowerCase().includes(busqueda))).slice(0, 8) : [];
  const ticketElegido = cache.tickets.find(t => t.id === state.nuevoServicioTicketId);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>🛠️ Nuevo turno de servicio técnico</h2>
    <div class="field"><label>Cliente / edificio</label>
      <select id="nuevo-servicio-cliente">
        <option value="">Elegí un cliente…</option>
        ${cache.clientes.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Ticket asociado (opcional)</label>
      ${ticketElegido
        ? `<div style="display:flex;align-items:center;gap:8px;"><span class="tag tag-cat">${escapeHtml(ticketElegido.numero)} — ${escapeHtml(ticketElegido.asunto)}</span><button type="button" class="btn btn-ghost" onclick="state.nuevoServicioTicketId='';render();">Quitar</button></div>`
        : `<input type="text" placeholder="Buscar por número o asunto…" value="${escapeHtml(state.nuevoServicioTicketBusqueda || '')}" oninput="state.nuevoServicioTicketBusqueda=this.value;refrescarBusquedaTicketNuevoServicio();">
           <div id="nuevo-servicio-ticket-resultados">${renderResultadosTicketNuevoServicio(ticketsFiltrados)}</div>`}
    </div>
    <div class="field"><label>Título del evento</label><input type="text" id="nuevo-servicio-titulo" placeholder="Ej: Revisión de cámaras"></div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" id="nuevo-servicio-todo-el-dia" onchange="toggleTodoElDiaIcs('nuevo-servicio')"> Todo el día</label>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="nuevo-servicio-fecha" value="${fechaDefault}"></div>
      <div class="field" id="nuevo-servicio-hora-wrap"><label>Hora</label><input type="time" id="nuevo-servicio-hora" value="${horaDefault}"></div>
    </div>
    <div class="field" id="nuevo-servicio-duracion-wrap"><label>Duración (minutos)</label><input type="number" id="nuevo-servicio-duracion" min="15" step="15" value="60"></div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" id="nuevo-servicio-aplica-iva" checked> Aplicar IVA (22%)</label>
    ${renderCostosPendientesEditor()}
    <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="button" class="btn btn-primary" onclick="guardarNuevoServicioTecnico()">📅 Agendar</button></div>
  </div></div>`;
}
function renderResultadosTicketNuevoServicio(lista) {
  if (!state.nuevoServicioTicketBusqueda) return '';
  if (!lista.length) return `<div class="hint-text">Sin resultados.</div>`;
  return `<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;max-height:160px;overflow-y:auto;">
    ${lista.map(t => `<button type="button" class="user-row" style="width:100%;text-align:left;border:1px solid var(--line);cursor:pointer;padding:6px 10px;" onclick="state.nuevoServicioTicketId='${t.id}';state.nuevoServicioTicketBusqueda='';render();">
      <div style="font-size:13px;"><strong>${escapeHtml(t.numero)}</strong> — ${escapeHtml(t.asunto)}</div>
    </button>`).join('')}</div>`;
}
function refrescarBusquedaTicketNuevoServicio() {
  const el = document.getElementById('nuevo-servicio-ticket-resultados');
  if (!el) return;
  const busqueda = (state.nuevoServicioTicketBusqueda || '').toLowerCase();
  const lista = busqueda ? cache.tickets.filter(t => !esTicketDeReserva(t) && (t.numero.toLowerCase().includes(busqueda) || t.asunto.toLowerCase().includes(busqueda))).slice(0, 8) : [];
  el.innerHTML = renderResultadosTicketNuevoServicio(lista);
}
async function guardarNuevoServicioTecnico() {
  const clienteId = document.getElementById('nuevo-servicio-cliente').value;
  const titulo = document.getElementById('nuevo-servicio-titulo').value;
  const fecha = document.getElementById('nuevo-servicio-fecha').value;
  const hora = document.getElementById('nuevo-servicio-hora').value;
  const duracion = document.getElementById('nuevo-servicio-duracion').value;
  const todoElDia = document.getElementById('nuevo-servicio-todo-el-dia').checked;
  const aplicaIva = document.getElementById('nuevo-servicio-aplica-iva').checked;
  if (!clienteId) { showToast('Elegí un cliente/edificio.'); return; }
  if (!titulo || !titulo.trim()) { showToast('Escribí un título para el evento.'); return; }
  if (!fecha) { showToast('Elegí una fecha.'); return; }
  if (!todoElDia && !hora) { showToast('Elegí una hora, o tildá "Todo el día".'); return; }
  const ticketElegido = cache.tickets.find(t => t.id === state.nuevoServicioTicketId);
  try {
    const nuevo = await api('POST', '/api/servicios-tecnicos', {
      clienteId, ticketId: ticketElegido ? ticketElegido.id : null, ticketNumero: ticketElegido ? ticketElegido.numero : null,
      titulo, fecha, hora, duracion, todoElDia, aplicaIva
    });
    await aplicarCostosPendientes(nuevo.id);
    const filas = await api('GET', '/api/servicios-tecnicos');
    cache.serviciosTecnicos = filas;
    showToast('Servicio técnico agendado.');
    closeModal();
    refrescarVistaServicioTecnico();
  } catch (e) { showToast(e.message); }
}
function abrirDetalleServicioTecnico(id) {
  state.modal = 'detalle-servicio-tecnico';
  state.servicioTecnicoDetalleId = id;
  state.pendingPresupuestos = [];
  state.servicioReprogramaciones = null;
  render();
}
// Logo + datos de contacto de Borcam (para el encabezado del comprobante de servicio técnico en PDF).
const BORCAM_LOGO_DATAURI = 'data:image/png;base64,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';
// Los precios que se cargan (del catálogo o puntuales) son SIN IVA. El sistema calcula el IVA
// (22%, tasa básica en Uruguay) y lo muestra aparte, tanto acá adentro como en lo que ve el cliente.
const IVA_RATE = 0.22;
function totalesPorMoneda(costos) {
  const t = {};
  (costos || []).forEach(c => { t[c.moneda] = (t[c.moneda] || 0) + Number(c.cantidad) * Number(c.precio_unitario); });
  return t;
}
function renderTotalesPorMoneda(costos, aplicaIva = true) {
  const t = totalesPorMoneda(costos);
  const entradas = Object.entries(t);
  if (!entradas.length) return '<div class="hint-text">Todavía no hay costos cargados.</div>';
  return `<div style="display:flex;flex-direction:column;gap:6px;">${entradas.map(([m, subtotalRaw]) => {
    const subtotal = Math.round(subtotalRaw);
    if (!aplicaIva) return `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;font-size:12.5px;color:var(--ink-soft);">
      <span class="tag tag-cat" style="font-weight:700;">Total (sin IVA): ${m} ${subtotal}</span>
    </div>`;
    const iva = Math.round(subtotal * IVA_RATE);
    const total = subtotal + iva;
    return `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;font-size:12.5px;color:var(--ink-soft);">
      <span>Subtotal: <strong style="color:var(--ink);">${m} ${subtotal}</strong></span>
      <span>+ IVA (22%): <strong style="color:var(--ink);">${m} ${iva}</strong></span>
      <span class="tag tag-cat" style="font-weight:700;">Total: ${m} ${total}</span>
    </div>`;
  }).join('')}</div>`;
}
async function toggleAplicaIvaServicio(id, aplicaIva) {
  try {
    const actualizado = await api('POST', `/api/servicios-tecnicos/${id}/aplica-iva`, { aplicaIva });
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    render();
  } catch (e) { showToast(e.message); }
}
const ESTADOS_CHECKLIST_MANTENIMIENTO = [
  { v: 'satisfactorio', label: '✅ Satisfactorio' },
  { v: 'atencion', label: '⚠️ Necesita atención' },
  { v: 'inmediata', label: '❌ Atención inmediata' },
  { v: 'no_aplica', label: '— No aplica' }
];
async function actualizarItemChecklistServicio(id, sistema, itemId, estado) {
  try {
    const actualizado = await api('POST', `/api/servicios-tecnicos/${id}/checklist-item`, { sistema, itemId, estado });
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    render();
  } catch (e) { showToast(e.message); }
}
async function guardarMotivoItemChecklistServicio(id, sistema, itemId, estadoActual, motivo) {
  try {
    const actualizado = await api('POST', `/api/servicios-tecnicos/${id}/checklist-item`, { sistema, itemId, estado: estadoActual, motivo });
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
  } catch (e) { showToast(e.message); }
}
// Checklist detallado (secciones + ítems) para turnos generados desde un contrato de mantenimiento,
// copiado de la plantilla del sistema en el momento en que se generó la visita. Cada ítem se responde
// con Satisfactorio / Necesita atención / Atención inmediata / No aplica (con motivo si aplica).
function renderChecklistSistemasServicio(s) {
  const checklist = s.checklist_sistemas || {};
  const sistemas = Object.keys(checklist);
  if (!sistemas.length) return '';
  return sistemas.map(sistema => {
    const secciones = (checklist[sistema] && checklist[sistema].secciones) || [];
    if (!secciones.length) return '';
    return `<div style="border-top:1px solid var(--line);padding-top:14px;margin-bottom:14px;">
      <div style="font-weight:600;font-size:14px;margin-bottom:10px;">🔧 ${escapeHtml(sistema)}</div>
      ${secciones.map(sec => `
        <div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12.5px;color:var(--ink-soft);text-transform:uppercase;margin-bottom:6px;">${escapeHtml(sec.nombre)}</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${(sec.items || []).map(item => `
              <div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;">
                <div style="font-size:13.5px;margin-bottom:6px;">${escapeHtml(item.texto)}</div>
                <select onchange="actualizarItemChecklistServicio('${s.id}', '${escapeHtml(sistema)}', '${item.id}', this.value)" style="font-size:12.5px;">
                  <option value="">Sin responder</option>
                  ${ESTADOS_CHECKLIST_MANTENIMIENTO.map(e => `<option value="${e.v}" ${item.estado === e.v ? 'selected' : ''}>${e.label}</option>`).join('')}
                </select>
                ${['no_aplica', 'atencion', 'inmediata'].includes(item.estado) ? `<input type="text" placeholder="${item.estado === 'no_aplica' ? 'Motivo (opcional)' : 'Detalle qué se necesita (ej: cambio de cámara, cambio de balun, revisar cableado)'}" value="${escapeHtml(item.motivo || '')}" style="margin-top:6px;width:100%;" onblur="guardarMotivoItemChecklistServicio('${s.id}', '${escapeHtml(sistema)}', '${item.id}', '${item.estado}', this.value)">` : ''}
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;
  }).join('');
}
// Notas libres de la visita de mantenimiento (observaciones generales, con fecha) — quedan guardadas
// solo en este turno/comprobante.
async function agregarNotaMantenimientoServicio(id) {
  const input = document.getElementById('nueva-nota-mantenimiento');
  const texto = (input.value || '').trim();
  if (!texto) return;
  try {
    const actualizado = await api('POST', `/api/servicios-tecnicos/${id}/nota-mantenimiento`, { texto });
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    render();
  } catch (e) { showToast(e.message); }
}
async function eliminarNotaMantenimientoServicio(id, idx) {
  try {
    const actualizado = await api('DELETE', `/api/servicios-tecnicos/${id}/nota-mantenimiento/${idx}`);
    const i = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (i >= 0) cache.serviciosTecnicos[i] = actualizado;
    render();
  } catch (e) { showToast(e.message); }
}
function renderNotasMantenimientoServicio(s) {
  if (!s.checklist_sistemas) return '';
  const notas = s.notas_mantenimiento || [];
  return `<div style="border-top:1px solid var(--line);padding-top:14px;margin-bottom:14px;">
    <div style="font-weight:600;font-size:14px;margin-bottom:8px;">📝 Notas de la visita</div>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
      ${notas.length ? notas.map((n, idx) => `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;">
          <div style="font-size:13px;"><span style="color:var(--ink-soft);">${fmtDateTime(n.fecha)}</span> — ${escapeHtml(n.texto)}</div>
          <button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:12px;" onclick="eliminarNotaMantenimientoServicio('${s.id}', ${idx})">✕</button>
        </div>`).join('') : `<div class="hint-text">Sin notas todavía.</div>`}
    </div>
    <div style="display:flex;gap:6px;">
      <input type="text" id="nueva-nota-mantenimiento" placeholder="Agregar una observación de la visita" style="flex:1;">
      <button type="button" class="btn btn-ghost" onclick="agregarNotaMantenimientoServicio('${s.id}')">Agregar</button>
    </div>
  </div>`;
}
// Envío de la orden completa (PDF con checklist + notas) al correo del cliente, por una casilla
// aparte de la de tickets. Solo tiene sentido una vez que el turno ya está marcado como realizado
// (con o sin firma) — antes no hay nada terminado que mandar.
async function enviarOrdenMantenimientoServicio(id) {
  try {
    const actualizado = await api('POST', `/api/servicios-tecnicos/${id}/enviar-orden-mantenimiento`);
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    showToast('Orden de mantenimiento enviada al cliente.');
    render();
  } catch (e) { showToast(e.message); }
}
function renderEnvioOrdenMantenimiento(s) {
  if (s.estado !== 'realizado') return `<div class="hint-text" style="margin-bottom:14px;">La orden se puede mandar por correo una vez que el turno quede marcado como realizado.</div>`;
  if (s.orden_mantenimiento_enviada) {
    return `<div class="hint-text" style="margin-bottom:14px;">✅ Orden enviada al cliente el ${fmtDateTime(s.orden_mantenimiento_enviada_fecha)}. <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:12px;" onclick="enviarOrdenMantenimientoServicio('${s.id}')">Reenviar</button></div>`;
  }
  return `<div style="margin-bottom:14px;">
    <button type="button" class="btn btn-primary" onclick="enviarOrdenMantenimientoServicio('${s.id}')">📧 Enviar orden por correo al cliente</button>
    <div class="hint-text" style="margin-top:6px;">Si no la mandás a mano, se manda sola a las 2 horas.</div>
  </div>`;
}
function renderDetalleServicioTecnicoModal() {
  const s = (cache.serviciosTecnicos || []).find(x => String(x.id) === String(state.servicioTecnicoDetalleId));
  if (!s) return '';
  if (state.editandoServicioTecnicoId != null && String(state.editandoServicioTecnicoId) === String(s.id)) return renderEditarServicioTecnicoModal(s);
  const filas = [
    ['Cliente / edificio', escapeHtml(nombreClientePorId(s.cliente_id))],
    ['Título', escapeHtml(s.titulo)],
    ['Ticket', s.ticket_numero ? escapeHtml(s.ticket_numero) : '—'],
    ['Fecha y hora', s.todo_el_dia ? new Date(s.fecha_hora).toLocaleDateString('es-UY', { dateStyle: 'full', timeZone: 'America/Montevideo' }) + ' (todo el día)' : new Date(s.fecha_hora).toLocaleString('es-UY', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Montevideo' })],
    ['Duración', s.todo_el_dia ? '—' : `${s.duracion_minutos || 60} min`],
    ['Cargado por', s.creado_por ? escapeHtml(s.creado_por) : '—'],
    ...(s.tecnico_realizo_nombre ? [['Técnico que la realizó', escapeHtml(s.tecnico_realizo_nombre)]] : []),
    ['Estado', s.estado === 'realizado' ? 'Realizado' : s.estado === 'en_curso' ? '🚗 En curso' : 'Pendiente']
  ];
  const puedeMarcar = s.estado !== 'realizado';
  const puedeIniciar = s.estado === 'pendiente';
  const reprogramaciones = state.servicioReprogramaciones && String(state.servicioReprogramacionesId) === String(s.id) ? state.servicioReprogramaciones : null;
  const costos = s.costos || [];
  const catalogoOptions = (cache.catalogoCostos || []).filter(c => c.activo).map(c => `<option value="${c.id}">${escapeHtml(c.nombre)} (${c.moneda} ${Math.round(Number(c.precio))} + IVA)</option>`).join('');
  const adjuntos = s.presupuesto_adjuntos || [];
  const estadoPresupuesto = s.presupuesto_aprobado
    ? `<span class="tag tag-resuelto">✅ Aprobado por el cliente${s.presupuesto_aprobado_fecha ? ' el ' + fmtDateTime(s.presupuesto_aprobado_fecha) : ''}</span>`
    : (s.presupuesto_enviado ? `<span class="tag tag-cat">📤 Enviado, esperando conformidad</span>` : `<span class="hint-text" style="margin:0;">Todavía no se envió al cliente.</span>`);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal" style="max-width:640px;">
    <h2>🛠️ Detalle del servicio técnico</h2>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
      ${filas.map(([label, valor]) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;border-bottom:1px dashed var(--line);padding-bottom:6px;"><span style="color:var(--ink-soft);">${label}</span><strong>${valor}</strong></div>`).join('')}
    </div>
    ${s.checklist_sistemas ? renderChecklistSistemasServicio(s) : ''}
    ${s.checklist_sistemas ? renderNotasMantenimientoServicio(s) : ''}
    ${s.checklist_sistemas ? renderEnvioOrdenMantenimiento(s) : ''}

    <div style="border-top:1px solid var(--line);padding-top:14px;margin-bottom:14px;">
      <div style="font-weight:600;font-size:14px;margin-bottom:8px;">💲 Costos</div>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);">
        <input type="checkbox" ${s.aplica_iva !== false ? 'checked' : ''} onchange="toggleAplicaIvaServicio('${s.id}', this.checked)"> Aplicar IVA (22%)
      </label>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
        ${costos.length ? costos.map(c => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;">
            <div style="font-size:13px;">${escapeHtml(c.descripcion)} x${c.cantidad} — <strong>${c.moneda} ${Math.round(Number(c.cantidad) * Number(c.precio_unitario))}</strong>${s.aplica_iva !== false ? ' <span style="color:var(--ink-soft);">+ IVA</span>' : ''}</div>
            <button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;" onclick="borrarCostoServicioTecnico('${c.id}', '${s.id}')">Quitar</button>
          </div>`).join('') : `<div class="hint-text">Sin costos cargados todavía.</div>`}
      </div>
      ${costos.length ? `<div style="margin-bottom:10px;">${renderTotalesPorMoneda(costos, s.aplica_iva !== false)}</div>` : ''}
      <div class="field-row" style="align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="flex:1.4;min-width:180px;"><label>Del catálogo</label><select id="costo-catalogo-select" onchange="autocompletarCostoDesdeCatalogo('costo')"><option value="">— Costo puntual (libre) —</option>${catalogoOptions}</select></div>
        <div class="field" style="flex:0.7;min-width:90px;"><label>Cant.</label><input type="number" id="costo-cantidad" value="1" min="0.01" step="0.01"></div>
      </div>
      <div class="field-row" style="flex-wrap:wrap;">
        <div class="field" style="flex:1.6;min-width:160px;"><label style="display:block;min-height:28px;">Descripción</label><input type="text" id="costo-descripcion" placeholder="Ej: Mano de obra"></div>
        <div class="field" style="flex:1;min-width:120px;"><label style="display:block;min-height:28px;">Precio (sin IVA)</label><input type="number" id="costo-precio" min="0" step="0.01"></div>
        <div class="field" style="flex:0.6;min-width:100px;"><label style="display:block;min-height:28px;">Moneda</label><select id="costo-moneda"><option value="UYU">$ UYU</option><option value="USD">US$</option></select></div>
      </div>
      <button type="button" class="btn btn-ghost" onclick="agregarCostoServicioTecnico('${s.id}')">+ Agregar costo</button>
    </div>

    <div style="border-top:1px solid var(--line);padding-top:14px;margin-bottom:14px;">
      <div style="font-weight:600;font-size:14px;margin-bottom:8px;">📎 Presupuesto adjunto</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
        ${adjuntos.length ? adjuntos.map(a => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;">
            <a href="/api/servicios-tecnicos/${s.id}/presupuesto/${a.id}/descargar" target="_blank" rel="noopener" style="font-size:13px;">${attachIcon(tipoAdjunto(a.mime || ''))} ${escapeHtml(a.nombre)}</a>
            <button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;" onclick="borrarPresupuestoAdjunto('${s.id}', '${a.id}')">Quitar</button>
          </div>`).join('') : `<div class="hint-text">Sin archivos de presupuesto todavía.</div>`}
      </div>
      <input type="file" multiple accept="image/*,application/pdf" onchange="addPendingPresupuestos(this)">
      <div id="pending-presupuestos">${renderPendingPresupuestosChips()}</div>
      ${(state.pendingPresupuestos || []).length ? `<button type="button" class="btn btn-ghost" style="margin-top:8px;" onclick="subirPresupuestosServicioTecnico('${s.id}')">Subir archivo(s)</button>` : ''}
      <div style="margin-top:10px;">${estadoPresupuesto}</div>
    </div>

    ${!puedeMarcar ? `<div class="hint-text" style="margin-bottom:10px;">${s.firma_sin_firma
      ? `✍️ Sin firma del cliente — ${escapeHtml(s.firma_motivo_sin_firma || 'no había nadie presente.')}`
      : s.firma_path
        ? `✍️ Firmado por ${escapeHtml(`${s.firma_nombre || ''} ${s.firma_apellido || ''}`.trim())} (C.I. ${escapeHtml(s.firma_cedula || '—')})${s.firma_fecha ? ' · ' + fmtDateTime(s.firma_fecha) : ''}`
        : ''}</div>` : ''}
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-bottom:10px;">
      ${reprogramaciones === null
        ? `<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;" onclick="verReprogramacionesServicio('${s.id}')">🔁 Ver historial de reprogramaciones</button>`
        : reprogramaciones.length
          ? `<div style="font-size:12.5px;color:var(--ink-soft);"><div style="font-weight:600;margin-bottom:4px;">🔁 Reprogramado ${reprogramaciones.length} vez${reprogramaciones.length === 1 ? '' : 'es'}:</div>
              ${reprogramaciones.map(r => `<div style="margin-bottom:2px;">${fmtDateTime(r.fecha_hora_anterior)} → ${fmtDateTime(r.fecha_hora_nueva)}${r.motivo ? ' — ' + escapeHtml(r.motivo) : ''}${r.reprogramado_por ? ' (' + escapeHtml(r.reprogramado_por) + ')' : ''}</div>`).join('')}</div>`
          : `<div class="hint-text">Este turno nunca se reprogramó.</div>`}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cerrar</button>
      ${s.ticket_id ? `<button type="button" class="btn btn-ghost" onclick="closeModal(); openTicket('${s.ticket_id}')">Ver ticket</button>` : ''}
      <button type="button" class="btn btn-ghost" onclick="state.editandoServicioTecnicoId='${s.id}'; render();">✏️ Editar</button>
      ${puedeMarcar ? `<button type="button" class="btn btn-ghost" onclick="abrirReprogramarServicio('${s.id}')">🔁 Reprogramar</button>` : ''}
      <button type="button" class="btn btn-danger" onclick="eliminarServicioTecnico('${s.id}')">🗑️ Eliminar</button>
      ${costos.length ? `<button type="button" class="btn btn-ghost" onclick="generarComprobanteServicioTecnico('${s.id}')">🧾 Generar comprobante</button>` : ''}
      ${!s.presupuesto_aprobado ? `<button type="button" class="btn ${s.presupuesto_enviado ? 'btn-ghost' : 'btn-primary'}" onclick="enviarPresupuestoServicioTecnico('${s.id}')" title="${s.ticket_id ? '' : 'Se va a crear un ticket automáticamente para poder notificar al cliente'}">📤 ${s.presupuesto_enviado ? 'Reenviar presupuesto al cliente' : 'Enviar presupuesto al cliente'}${s.ticket_id ? '' : ' (crea ticket)'}</button>` : ''}
      ${puedeIniciar ? `<button type="button" class="btn btn-ghost" onclick="iniciarServicioTecnico('${s.id}')">🚗 Marcar en curso</button>` : ''}
      ${puedeMarcar ? `<button type="button" class="btn btn-primary" onclick="marcarServicioTecnicoRealizado('${s.id}')">✅ Marcar como realizado</button>` : ''}
    </div>
  </div></div>`;
}
async function iniciarServicioTecnico(id) {
  try {
    const actualizado = await api('POST', `/api/servicios-tecnicos/${id}/iniciar`);
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = { ...cache.serviciosTecnicos[idx], ...actualizado };
    showToast('Servicio marcado como en curso.');
    render();
  } catch (e) { showToast(e.message); }
}
async function verReprogramacionesServicio(id) {
  try {
    const filas = await api('GET', `/api/servicios-tecnicos/${id}/reprogramaciones`);
    state.servicioReprogramaciones = filas;
    state.servicioReprogramacionesId = id;
    render();
  } catch (e) { showToast(e.message); }
}
function abrirReprogramarServicio(id) {
  state.modal = 'reprogramar-servicio';
  state.reprogramarServicioId = id;
  render();
}
function renderReprogramarServicioModal() {
  const s = (cache.serviciosTecnicos || []).find(x => String(x.id) === String(state.reprogramarServicioId));
  if (!s) return '';
  const d = new Date(new Date(s.fecha_hora).getTime() + 24 * 60 * 60000);
  const fechaDefault = d.toISOString().slice(0, 10);
  const horaDefault = d.toTimeString().slice(0, 5);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>🔁 Reprogramar servicio técnico</h2>
    <p class="sub">${escapeHtml(s.titulo)} — fecha actual: ${s.todo_el_dia ? new Date(s.fecha_hora).toLocaleDateString('es-UY', { timeZone: 'America/Montevideo' }) : new Date(s.fecha_hora).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' })}</p>
    <div class="field-row">
      <div class="field"><label>Nueva fecha</label><input type="date" id="reprogramar-fecha" value="${fechaDefault}"></div>
      <div class="field"><label>Nueva hora</label><input type="time" id="reprogramar-hora" value="${s.todo_el_dia ? '00:00' : horaDefault}"></div>
    </div>
    <div class="field"><label>Motivo (opcional)</label><input type="text" id="reprogramar-motivo" placeholder="Ej: el cliente pidió moverlo"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn-primary" onclick="confirmarReprogramarServicio()">Reprogramar</button>
    </div>
  </div></div>`;
}
async function confirmarReprogramarServicio() {
  const s = (cache.serviciosTecnicos || []).find(x => String(x.id) === String(state.reprogramarServicioId));
  if (!s) return;
  const fecha = document.getElementById('reprogramar-fecha').value;
  const hora = document.getElementById('reprogramar-hora').value;
  const motivo = document.getElementById('reprogramar-motivo').value;
  if (!fecha || !hora) { showToast('Elegí la nueva fecha y hora.'); return; }
  try {
    const actualizado = await api('PUT', `/api/servicios-tecnicos/${s.id}`, {
      clienteId: s.cliente_id, titulo: s.titulo, fecha, hora, duracion: s.duracion_minutos, todoElDia: s.todo_el_dia, motivoReprogramacion: motivo
    });
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(s.id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    state.servicioReprogramaciones = null;
    showToast('Servicio técnico reprogramado.');
    state.modal = 'detalle-servicio-tecnico';
    render();
  } catch (e) { showToast(e.message); }
}
async function agregarCostoServicioTecnico(servicioId) {
  const catalogoItemId = document.getElementById('costo-catalogo-select').value || null;
  const cantidad = document.getElementById('costo-cantidad').value;
  const descripcion = document.getElementById('costo-descripcion').value;
  const precioUnitario = document.getElementById('costo-precio').value;
  const moneda = document.getElementById('costo-moneda').value;
  if (!catalogoItemId && (!descripcion || !descripcion.trim())) { showToast('Escribí una descripción, o elegí un costo del catálogo.'); return; }
  if (!catalogoItemId && (precioUnitario === '' || isNaN(Number(precioUnitario)))) { showToast('Escribí un precio.'); return; }
  try {
    await api('POST', `/api/servicios-tecnicos/${servicioId}/costos`, { catalogoItemId, descripcion, cantidad, precioUnitario: precioUnitario || null, moneda });
    await recargarServicioTecnico(servicioId);
    showToast('Costo agregado.');
  } catch (e) { showToast(e.message); }
}
async function borrarCostoServicioTecnico(costoId, servicioId) {
  try {
    await api('DELETE', `/api/costos-servicio/${costoId}`);
    await recargarServicioTecnico(servicioId);
  } catch (e) { showToast(e.message); }
}
async function recargarServicioTecnico(servicioId) {
  const filas = await api('GET', '/api/servicios-tecnicos');
  cache.serviciosTecnicos = filas;
  render();
  refrescarVistaServicioTecnico();
}
function renderPendingPresupuestosChips() {
  if (!(state.pendingPresupuestos || []).length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">${state.pendingPresupuestos.map(a => `
    <span class="tag tag-cat" style="gap:6px;padding:6px 10px;">${attachIcon(a.tipo)} ${escapeHtml(a.nombre)} <span style="opacity:.7;">(${fmtSize(a.size)})</span>
    <button type="button" onclick="removePendingPresupuesto('${a.id}')" style="border:none;background:none;cursor:pointer;color:var(--stamp-red);font-weight:700;padding:0 0 0 4px;">&times;</button></span>`).join('')}</div>`;
}
function refreshPendingPresupuestosChips() { const el = document.getElementById('pending-presupuestos'); if (el) el.innerHTML = renderPendingPresupuestosChips(); }
function addPendingPresupuestos(input) {
  state.pendingPresupuestos = state.pendingPresupuestos || [];
  Array.from(input.files || []).forEach(file => {
    if (file.size > ATTACH_MAX_BYTES) { showToast(`"${file.name}" pesa demasiado (máx. 20 MB).`); return; }
    const reader = new FileReader();
    reader.onload = () => { state.pendingPresupuestos.push({ id: uid(), nombre: file.name, tipo: tipoAdjunto(file.type || ''), size: file.size, dataUrl: reader.result }); refreshPendingPresupuestosChips(); };
    reader.readAsDataURL(file);
  });
  input.value = '';
}
function removePendingPresupuesto(id) { state.pendingPresupuestos = (state.pendingPresupuestos || []).filter(a => a.id !== id); refreshPendingPresupuestosChips(); }
async function subirPresupuestosServicioTecnico(servicioId) {
  try {
    await api('POST', `/api/servicios-tecnicos/${servicioId}/presupuesto`, { adjuntos: state.pendingPresupuestos });
    state.pendingPresupuestos = [];
    await recargarServicioTecnico(servicioId);
    showToast('Presupuesto adjuntado.');
  } catch (e) { showToast(e.message); }
}
async function borrarPresupuestoAdjunto(servicioId, adjId) {
  try {
    await api('DELETE', `/api/servicios-tecnicos/${servicioId}/presupuesto/${adjId}`);
    await recargarServicioTecnico(servicioId);
  } catch (e) { showToast(e.message); }
}
async function enviarPresupuestoServicioTecnico(servicioId) {
  try {
    const ticketActualizado = await api('POST', `/api/servicios-tecnicos/${servicioId}/enviar-presupuesto`);
    const mapeado = mapTicket(ticketActualizado);
    const idx = cache.tickets.findIndex(x => x.id === mapeado.id);
    if (idx >= 0) cache.tickets[idx] = mapeado; else cache.tickets.push(mapeado);
    await recargarServicioTecnico(servicioId);
    showToast('Presupuesto enviado al cliente.');
  } catch (e) { showToast(e.message); }
}
// Carga jsPDF desde CDN una sola vez (lazy, recién cuando hace falta generar un comprobante) y
// reusa la misma promesa si se pide más de una vez.
let _jsPdfLoadPromise = null;
function cargarJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (_jsPdfLoadPromise) return _jsPdfLoadPromise;
  _jsPdfLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script.onload = () => resolve();
    script.onerror = () => { _jsPdfLoadPromise = null; reject(new Error('No se pudo cargar el generador de PDF.')); };
    document.head.appendChild(script);
  });
  return _jsPdfLoadPromise;
}
// El comprobante de servicio técnico es un recibo interno de Borcam (NO una factura electrónica de
// DGI): se genera a pedido con un botón, tiene numeración correlativa propia (serie A, ej. A-00001)
// que el backend asigna y guarda para no repetirla, y reproduce el membrete real de Borcam.
async function generarComprobanteServicioTecnico(servicioId) {
  try {
    const { comprobante, servicio, cliente } = await api('POST', `/api/servicios-tecnicos/${servicioId}/comprobante`);
    await cargarJsPdf();
    let firmaDataUrl = null;
    if (servicio.firma_path) {
      try {
        const resp = await fetch(`/api/servicios-tecnicos/${servicioId}/firma`, { credentials: 'include' });
        if (resp.ok) firmaDataUrl = await blobToDataUrl(await resp.blob());
      } catch (e) { console.error('No se pudo cargar la firma para el comprobante:', e.message); }
    }
    construirPdfComprobante(comprobante, servicio, cliente, firmaDataUrl);
    await recargarServicioTecnico(servicioId);
  } catch (e) { showToast(e.message); }
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function construirPdfComprobante(comprobante, servicio, cliente, firmaDataUrl) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 15;
  let y = 18;

  // Membrete: logo + datos de contacto de Borcam, igual a la papelería real.
  doc.addImage(BORCAM_LOGO_DATAURI, 'PNG', marginX, y, 38, 31.6);

  // Número de comprobante y fecha, arriba a la derecha (como en una factura).
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Comprobante de Servicio Técnico', pageWidth - marginX, y + 4, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`N.° ${comprobante.numero}`, pageWidth - marginX, y + 11, { align: 'right' });
  doc.text(`Fecha: ${new Date(comprobante.creado).toLocaleDateString('es-UY', { timeZone: 'America/Montevideo' })}`, pageWidth - marginX, y + 17, { align: 'right' });

  y += 40;
  doc.setDrawColor(200);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  // Aviso de que no es una factura fiscal de DGI, bien visible debajo del membrete.
  doc.setFontSize(8.5);
  doc.setTextColor(140);
  doc.text('Este documento es un comprobante interno de Borcam y no tiene valor de Comprobante Fiscal Electrónico (CFE) ante DGI.', marginX, y);
  doc.setTextColor(0);
  y += 9;

  // Datos del cliente / edificio.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('Cliente / edificio', marginX, y);
  y += 5.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(cliente ? (cliente.nombre || '—') : '—', marginX, y);
  y += 5;
  if (cliente && cliente.direccion) { doc.text(cliente.direccion, marginX, y); y += 5; }
  if (cliente && cliente.contacto_nombre) { doc.text(`Contacto: ${cliente.contacto_nombre}`, marginX, y); y += 5; }
  y += 3;

  // Descripción del servicio realizado.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('Servicio', marginX, y);
  y += 5.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const tituloLineas = doc.splitTextToSize(servicio.titulo || '—', pageWidth - marginX * 2);
  doc.text(tituloLineas, marginX, y);
  y += tituloLineas.length * 5 + 2;
  doc.text(`Fecha de la visita: ${new Date(servicio.fecha_hora).toLocaleDateString('es-UY', { timeZone: 'America/Montevideo' })}`, marginX, y);
  y += 9;

  // Tabla de costos.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('Detalle', marginX, y);
  y += 6;
  const colDesc = marginX, colCant = pageWidth - marginX - 62, colPrecio = pageWidth - marginX - 42, colImporte = pageWidth - marginX;
  doc.setFontSize(9);
  doc.text('Descripción', colDesc, y);
  doc.text('Cant.', colCant, y, { align: 'right' });
  doc.text('P. unitario', colPrecio, y, { align: 'right' });
  doc.text('Importe', colImporte, y, { align: 'right' });
  y += 2;
  doc.setDrawColor(210);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  const aplicaIva = servicio.aplica_iva !== false;
  (servicio.costos || []).forEach(c => {
    const importe = Math.round(Number(c.cantidad) * Number(c.precio_unitario));
    const descLineas = doc.splitTextToSize(c.descripcion, colCant - colDesc - 4);
    doc.text(descLineas, colDesc, y);
    doc.text(String(c.cantidad), colCant, y, { align: 'right' });
    doc.text(`${c.moneda} ${Math.round(Number(c.precio_unitario))}`, colPrecio, y, { align: 'right' });
    doc.text(`${c.moneda} ${importe}`, colImporte, y, { align: 'right' });
    y += Math.max(descLineas.length, 1) * 5 + 1;
  });
  y += 3;
  doc.setDrawColor(210);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  // Totales por moneda, con el IVA (22%) discriminado — salvo que el service tenga el IVA
  // desactivado (cliente que solo pide el comprobante interno, sin factura oficial).
  const totales = totalesPorMoneda(servicio.costos || []);
  doc.setFontSize(10);
  Object.entries(totales).forEach(([moneda, subtotalRaw]) => {
    const subtotal = Math.round(subtotalRaw);
    doc.setFont('helvetica', 'normal');
    if (!aplicaIva) {
      doc.setFont('helvetica', 'bold');
      doc.text(`Total (${moneda}, sin IVA)`, colPrecio, y, { align: 'right' });
      doc.text(`${moneda} ${subtotal}`, colImporte, y, { align: 'right' });
      y += 8;
      return;
    }
    const iva = Math.round(subtotal * IVA_RATE);
    const total = subtotal + iva;
    doc.text(`Subtotal (${moneda})`, colPrecio, y, { align: 'right' });
    doc.text(`${moneda} ${subtotal}`, colImporte, y, { align: 'right' });
    y += 5.5;
    doc.text(`IVA 22% (${moneda})`, colPrecio, y, { align: 'right' });
    doc.text(`${moneda} ${iva}`, colImporte, y, { align: 'right' });
    y += 5.5;
    doc.setFont('helvetica', 'bold');
    doc.text(`Total (${moneda})`, colPrecio, y, { align: 'right' });
    doc.text(`${moneda} ${total}`, colImporte, y, { align: 'right' });
    y += 8;
  });

  // Conformidad del cliente: firma dibujada + aclaración, o la constancia del motivo si no había
  // nadie presente para firmar al cerrar el service.
  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(0);
  doc.text('Conformidad del cliente', marginX, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  if (firmaDataUrl) {
    doc.addImage(firmaDataUrl, 'PNG', marginX, y, 65, 26);
    doc.setDrawColor(180);
    doc.line(marginX, y + 28, marginX + 65, y + 28);
    doc.setFontSize(8);
    const nombreCompleto = `${servicio.firma_nombre || ''} ${servicio.firma_apellido || ''}`.trim();
    doc.text(`Aclaración: ${nombreCompleto || '—'}`, marginX, y + 33);
    doc.text(`C.I.: ${servicio.firma_cedula || '—'}`, marginX, y + 38);
    if (servicio.firma_fecha) doc.text(`Fecha: ${new Date(servicio.firma_fecha).toLocaleDateString('es-UY', { timeZone: 'America/Montevideo' })}`, marginX, y + 43);
    y += 48;
  } else if (servicio.firma_sin_firma) {
    doc.setTextColor(120);
    const motivoLineas = doc.splitTextToSize(`Sin firma del cliente — ${servicio.firma_motivo_sin_firma || 'no había nadie presente al finalizar el service.'}`, pageWidth - marginX * 2);
    doc.text(motivoLineas, marginX, y);
    doc.setTextColor(0);
    y += motivoLineas.length * 5 + 4;
  }

  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text('BORCAM EQUIPAMIENTOS S.R.L — Av 8 de Octubre 2956, Montevideo — Tel.: 598+ 24878281 — administracion@borcam.com.uy', pageWidth / 2, pageHeight - 12, { align: 'center' });

  doc.save(`Comprobante ${comprobante.numero} - ${(servicio.titulo || 'servicio').replace(/[\\/:*?"<>|]/g, '')}.pdf`);
}
function renderEditarServicioTecnicoModal(s) {
  const d = new Date(s.fecha_hora);
  const fechaDefault = d.toISOString().slice(0, 10);
  const horaDefault = d.toTimeString().slice(0, 5);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>✏️ Editar servicio técnico</h2>
    <div class="field"><label>Cliente / edificio</label>
      <select id="servicio-edit-cliente">${cache.clientes.map(c => `<option value="${c.id}" ${c.id === s.cliente_id ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Título del evento</label><input type="text" id="servicio-edit-titulo" value="${escapeHtml(s.titulo)}"></div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" id="servicio-edit-ics-todo-el-dia" ${s.todo_el_dia ? 'checked' : ''} onchange="toggleTodoElDiaIcs('servicio-edit')"> Todo el día</label>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="servicio-edit-fecha" value="${fechaDefault}"></div>
      <div class="field" id="servicio-edit-ics-hora-wrap" style="${s.todo_el_dia ? 'display:none;' : ''}"><label>Hora</label><input type="time" id="servicio-edit-hora" value="${horaDefault}"></div>
    </div>
    <div class="field" id="servicio-edit-ics-duracion-wrap" style="${s.todo_el_dia ? 'display:none;' : ''}"><label>Duración (minutos)</label><input type="number" id="servicio-edit-duracion" min="15" step="15" value="${s.duracion_minutos || 60}"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="state.editandoServicioTecnicoId=null; render();">Cancelar</button>
      <button type="button" class="btn btn-primary" onclick="guardarEdicionServicioTecnico('${s.id}')">Guardar cambios</button>
    </div>
  </div></div>`;
}
async function guardarEdicionServicioTecnico(id) {
  const clienteId = document.getElementById('servicio-edit-cliente').value;
  const titulo = document.getElementById('servicio-edit-titulo').value;
  const fecha = document.getElementById('servicio-edit-fecha').value;
  const hora = document.getElementById('servicio-edit-hora').value;
  const duracion = document.getElementById('servicio-edit-duracion').value;
  const todoElDia = document.getElementById('servicio-edit-ics-todo-el-dia').checked;
  if (!clienteId) { showToast('Elegí un cliente/edificio.'); return; }
  if (!fecha) { showToast('Elegí una fecha.'); return; }
  if (!todoElDia && !hora) { showToast('Elegí una hora, o tildá "Todo el día".'); return; }
  try {
    const actualizado = await api('PUT', `/api/servicios-tecnicos/${id}`, { clienteId, titulo, fecha, hora, duracion, todoElDia });
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    state.editandoServicioTecnicoId = null;
    showToast('Servicio técnico actualizado.');
    render();
  } catch (e) { showToast(e.message); }
}
async function eliminarServicioTecnico(id) {
  if (!confirm('¿Eliminar este servicio técnico? Se borran también sus costos y presupuesto adjunto. Esta acción no se puede deshacer.')) return;
  try {
    await api('DELETE', `/api/servicios-tecnicos/${id}`);
    cache.serviciosTecnicos = (cache.serviciosTecnicos || []).filter(x => String(x.id) !== String(id));
    closeModal();
    showToast('Servicio técnico eliminado.');
    render();
    refrescarVistaServicioTecnico();
  } catch (e) { showToast(e.message); }
}
/* ---- Catálogo de costos precargados (mano de obra, viáticos, etc.) ---- */
function renderCatalogoCostosTab() {
  const items = cache.catalogoCostos || [];
  return `<div class="page-head" style="margin-top:6px;"><div><h1 style="font-size:18px;">${items.length} costo${items.length === 1 ? '' : 's'} en el catálogo</h1><div class="sub">Se usan como atajo al cargar costos en una visita; siempre se puede cargar un costo puntual aparte.</div></div>
      <button type="button" class="btn btn-ghost" onclick="openCatalogoCostoModal()">+ Nuevo costo</button></div>
    <div class="user-list">${items.length ? items.map(c => `
      <div class="user-row" style="border:1px solid var(--line);">
        <div class="avatar">💲</div>
        <div style="flex:1;"><div class="u-name">${escapeHtml(c.nombre)} ${!c.activo ? '<span class="tag" style="margin-left:6px;">Inactivo</span>' : ''}</div>
        <div class="u-sub">${c.moneda} ${Math.round(Number(c.precio))} + IVA</div></div>
        <button type="button" class="btn btn-ghost" onclick="openCatalogoCostoModal('${c.id}')">Editar</button>
        <button type="button" class="btn btn-danger" onclick="borrarCatalogoCosto('${c.id}')">Eliminar</button>
      </div>`).join('') : `<div class="hint-text">Todavía no cargaste ningún costo al catálogo.</div>`}</div>`;
}
function openCatalogoCostoModal(id) {
  state.modal = 'catalogo-costo';
  state.catalogoCostoEditId = id || null;
  render();
}
function renderCatalogoCostoModal() {
  const item = state.catalogoCostoEditId ? (cache.catalogoCostos || []).find(c => String(c.id) === String(state.catalogoCostoEditId)) : null;
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>${item ? '✏️ Editar costo' : '+ Nuevo costo del catálogo'}</h2>
    <div class="field"><label>Nombre</label><input type="text" id="catalogo-costo-nombre" value="${item ? escapeHtml(item.nombre) : ''}" placeholder="Ej: Mano de obra por visita"></div>
    <div class="field-row">
      <div class="field"><label>Precio (sin IVA)</label><input type="number" id="catalogo-costo-precio" min="0" step="1" value="${item ? Math.round(Number(item.precio)) : ''}"></div>
      <div class="field" style="flex:0.6;"><label>Moneda</label><select id="catalogo-costo-moneda"><option value="UYU" ${!item || item.moneda === 'UYU' ? 'selected' : ''}>$ UYU</option><option value="USD" ${item && item.moneda === 'USD' ? 'selected' : ''}>US$</option></select></div>
    </div>
    ${item ? `<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" id="catalogo-costo-activo" ${item.activo ? 'checked' : ''}> Activo (visible al cargar costos)</label>` : ''}
    <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="button" class="btn btn-primary" onclick="guardarCatalogoCosto()">Guardar</button></div>
  </div></div>`;
}
async function guardarCatalogoCosto() {
  const nombre = document.getElementById('catalogo-costo-nombre').value;
  const precio = Math.round(Number(document.getElementById('catalogo-costo-precio').value));
  const moneda = document.getElementById('catalogo-costo-moneda').value;
  const activoEl = document.getElementById('catalogo-costo-activo');
  if (!nombre || !nombre.trim()) { showToast('Escribí un nombre.'); return; }
  if (isNaN(precio)) { showToast('Escribí un precio.'); return; }
  try {
    if (state.catalogoCostoEditId) {
      const actualizado = await api('PUT', `/api/catalogo-costos/${state.catalogoCostoEditId}`, { nombre, precio, moneda, activo: activoEl ? activoEl.checked : true });
      const idx = cache.catalogoCostos.findIndex(c => String(c.id) === String(state.catalogoCostoEditId));
      if (idx >= 0) cache.catalogoCostos[idx] = actualizado;
    } else {
      const nuevo = await api('POST', '/api/catalogo-costos', { nombre, precio, moneda });
      cache.catalogoCostos = [...(cache.catalogoCostos || []), nuevo];
    }
    showToast('Guardado.');
    closeModal();
    refrescarVistaServicioTecnico();
  } catch (e) { showToast(e.message); }
}
async function borrarCatalogoCosto(id) {
  if (!confirm('¿Eliminar este costo del catálogo?')) return;
  try {
    await api('DELETE', `/api/catalogo-costos/${id}`);
    cache.catalogoCostos = cache.catalogoCostos.filter(c => String(c.id) !== String(id));
    refrescarVistaServicioTecnico();
  } catch (e) { showToast(e.message); }
}
// Tarjeta que se ve dentro del ticket con los turnos de Servicio Técnico ya agendados desde acá,
// para no tener que ir a buscarlos a Calendario → Servicio Técnico.
function renderServiciosTecnicosDelTicket(t) {
  const turnos = t.serviciosTecnicos || [];
  if (!turnos.length) return '';
  return `<div class="card card-narrow" style="max-width:560px;margin:14px 0;">
    ${configSectionHead('🛠️', 'Servicio técnico agendado', 'Turnos cargados desde este ticket.')}
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${turnos.map(s => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:8px 12px;">
          <div>
            <div style="font-weight:600;font-size:13.5px;">${escapeHtml(s.titulo)}</div>
            <div class="u-sub">${s.todo_el_dia ? new Date(s.fecha_hora).toLocaleDateString('es-UY', { dateStyle: 'medium', timeZone: 'America/Montevideo' }) + ' · Todo el día' : new Date(s.fecha_hora).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' })}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button type="button" class="btn btn-ghost" onclick="verDetalleServicioTecnicoDesdeTicket('${s.id}')">💲 Costos / presupuesto</button>
            ${s.estado === 'realizado' ? `<span class="tag tag-resuelto">Realizado</span>` : `<button type="button" class="btn btn-ghost" onclick="marcarServicioTecnicoRealizadoDesdeTicket('${s.id}', '${t.id}')">✅ Marcar realizado</button>`}
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}
async function verDetalleServicioTecnicoDesdeTicket(servicioId) {
  try {
    if (!cache.serviciosTecnicos.length || !cache.catalogoCostos) {
      const [servicios, catalogo] = await Promise.all([api('GET', '/api/servicios-tecnicos'), api('GET', '/api/catalogo-costos')]);
      cache.serviciosTecnicos = servicios;
      cache.catalogoCostos = catalogo;
    }
    abrirDetalleServicioTecnico(servicioId);
  } catch (e) { showToast(e.message); }
}
function marcarServicioTecnicoRealizadoDesdeTicket(servicioId, ticketId) {
  abrirModalFirmaServicio(servicioId, ticketId);
}
// Checklist de pasos según la categoría del ticket (plantillas configurables en Configuración → Checklists).
function renderChecklistTicket(t) {
  const pasos = (CAT.checklistsCategoria && CAT.checklistsCategoria[t.categoria]) || [];
  if (!pasos.length) return '';
  const estado = t.checklistEstado || {};
  return `<div class="card card-narrow" style="max-width:560px;margin:14px 0;">
    ${configSectionHead('✅', `Checklist — ${escapeHtml(t.categoria)}`, 'Pasos sugeridos para esta categoría. Se guardan solos al tildarlos.')}
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${pasos.map(p => `
        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;${estado[p] ? 'color:var(--ink-soft);text-decoration:line-through;' : ''}">
          <input type="checkbox" ${estado[p] ? 'checked' : ''} onchange="toggleChecklistItem('${t.id}', ${escapeHtml(JSON.stringify(p))}, this.checked)"> ${escapeHtml(p)}
        </label>`).join('')}
    </div>
  </div>`;
}
async function toggleChecklistItem(ticketId, paso, marcado) {
  try {
    await api('PATCH', `/api/tickets/${ticketId}/checklist`, { paso, marcado });
    const t = cache.tickets.find(x => x.id === ticketId);
    if (t) { t.checklistEstado = t.checklistEstado || {}; t.checklistEstado[paso] = marcado; }
    render();
  } catch (e) { showToast(e.message); }
}
// Historial: otros tickets previos del mismo correo remitente, para saber rápido si es un cliente
// recurrente o si ya tuvo un problema parecido antes.
function renderHistorialClienteTicket(t) {
  const hist = t.historialCliente || [];
  if (!hist.length) return '';
  return `<div class="card card-narrow" style="max-width:560px;margin:14px 0;">
    ${configSectionHead('🗂️', `Otros tickets de ${escapeHtml(t.remitenteEmail)}`, `${hist.length} ticket${hist.length === 1 ? '' : 's'} anterior${hist.length === 1 ? '' : 'es'} de este mismo correo.`)}
    <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;">
      ${hist.map(h => `
        <button type="button" class="user-row" style="width:100%;text-align:left;border:1px solid var(--line);cursor:pointer;padding:8px 12px;" onclick="openTicket('${h.id}')">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(h.numero)} — ${escapeHtml(h.asunto)}</div>
            <div class="u-sub">${fmtDateTime(h.creado)}</div>
          </div>
          <span class="stamp stamp-${slug(h.estado)}" style="flex:none;">${escapeHtml(h.estado)}</span>
        </button>`).join('')}
    </div>
  </div>`;
}
function marcarServicioTecnicoRealizado(id) {
  abrirModalFirmaServicio(id, null);
}
// --- Firma de conformidad al cerrar un service ---
// Cuadro que se abre al marcar un service como realizado: aclaración (nombre/apellido/cédula) y un
// recuadro para dibujar la firma con el dedo (celular) o el mouse (compu), usando Pointer Events para
// que funcione igual en ambos casos. Si no hay nadie presente para firmar, se puede igual cerrar el
// service dejando la constancia del motivo, sin firma.
let firmaCanvasCtx = null, firmaDibujando = false, firmaTieneTrazo = false;
function abrirModalFirmaServicio(servicioId, ticketId) {
  state.modal = 'firma-servicio';
  state.firmaServicioId = servicioId;
  state.firmaServicioTicketId = ticketId || null;
  state.firmaSinFirma = false;
  render();
  setTimeout(inicializarCanvasFirma, 0);
}
function renderModalFirmaServicio() {
  const sinFirma = state.firmaSinFirma;
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>✍️ Conformidad del cliente</h2>
    <div class="hint-text" style="margin-bottom:10px;">Se le pide al cliente que firme para dejar constancia de que el service se realizó.</div>
    <div class="field"><label>Técnico que realizó la visita</label>
      <select id="firma-tecnico">${(cache.usuarios || []).map(u => `<option value="${escapeHtml(u.nombre + ' ' + u.apellido)}" ${currentUser() && currentUser().id === u.id ? 'selected' : ''}>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</option>`).join('')}</select>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:13px;color:var(--ink-soft);">
      <input type="checkbox" id="firma-sin-firma-check" ${sinFirma ? 'checked' : ''} onchange="toggleFirmaSinFirma(this.checked)"> No hay nadie presente para firmar
    </label>
    <div id="firma-con-datos" style="${sinFirma ? 'display:none;' : ''}">
      <div class="field-row">
        <div class="field"><label>Nombre</label><input type="text" id="firma-nombre"></div>
        <div class="field"><label>Apellido</label><input type="text" id="firma-apellido"></div>
      </div>
      <div class="field"><label>Cédula</label><input type="text" id="firma-cedula" placeholder="Ej: 4.123.456-7"></div>
      <div class="field"><label>Firma</label>
        <canvas id="firma-canvas" style="width:100%;height:160px;border:1px solid var(--line);border-radius:8px;background:#fff;touch-action:none;cursor:crosshair;display:block;"></canvas>
        <button type="button" class="btn btn-ghost" style="margin-top:6px;" onclick="limpiarFirmaCanvas()">Limpiar firma</button>
      </div>
    </div>
    <div id="firma-sin-datos" style="${sinFirma ? '' : 'display:none;'}">
      <div class="field"><label>Motivo (opcional)</label><textarea id="firma-motivo" rows="3" placeholder="Ej: no había nadie en el edificio al finalizar el service."></textarea></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn-primary" onclick="confirmarMarcarServicioRealizado()">✅ Marcar como realizado</button>
    </div>
  </div></div>`;
}
function toggleFirmaSinFirma(checked) {
  state.firmaSinFirma = checked;
  render();
  if (!checked) setTimeout(inicializarCanvasFirma, 0);
}
function inicializarCanvasFirma() {
  const canvas = document.getElementById('firma-canvas');
  if (!canvas) return;
  // Ajusta la resolución interna del canvas al tamaño real en pantalla (x2, para que no se vea
  // pixelada la firma en celulares con pantalla de alta densidad).
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(rect.width, 200) * 2;
  canvas.height = Math.max(rect.height, 100) * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0F2A4D';
  firmaCanvasCtx = ctx; firmaTieneTrazo = false;
  let last = null;
  const posDesde = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.onpointerdown = (e) => { firmaDibujando = true; last = posDesde(e); try { canvas.setPointerCapture(e.pointerId); } catch (err) {} };
  canvas.onpointermove = (e) => {
    if (!firmaDibujando || !last) return;
    const p = posDesde(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; firmaTieneTrazo = true;
  };
  const parar = () => { firmaDibujando = false; last = null; };
  canvas.onpointerup = parar; canvas.onpointerleave = parar; canvas.onpointercancel = parar;
}
function limpiarFirmaCanvas() {
  const canvas = document.getElementById('firma-canvas');
  if (!canvas || !firmaCanvasCtx) return;
  firmaCanvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  firmaTieneTrazo = false;
}
async function confirmarMarcarServicioRealizado() {
  const servicioId = state.firmaServicioId;
  const ticketId = state.firmaServicioTicketId;
  try {
    const tecnicoNombre = (document.getElementById('firma-tecnico') || {}).value || '';
    let payload;
    if (state.firmaSinFirma) {
      const motivo = document.getElementById('firma-motivo').value;
      payload = { conFirma: false, motivoSinFirma: motivo, tecnicoNombre };
    } else {
      const nombre = document.getElementById('firma-nombre').value.trim();
      const apellido = document.getElementById('firma-apellido').value.trim();
      const cedula = document.getElementById('firma-cedula').value.trim();
      if (!nombre || !apellido || !cedula) { showToast('Completá nombre, apellido y cédula.'); return; }
      if (!firmaTieneTrazo) { showToast('Falta la firma — dibujala en el recuadro.'); return; }
      const canvas = document.getElementById('firma-canvas');
      payload = { conFirma: true, nombre, apellido, cedula, firmaDataUrl: canvas.toDataURL('image/png'), tecnicoNombre };
    }
    const actualizado = await api('POST', `/api/servicios-tecnicos/${servicioId}/marcar-realizado`, payload);
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(servicioId));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    showToast('Servicio técnico marcado como realizado.');
    closeModal();
    if (ticketId) await refreshTicket(ticketId);
    render();
  } catch (e) { showToast(e.message); }
}
function renderCalendarioConfigTab(c, filasDias) {
  return `
    <div class="card card-narrow" style="max-width:640px;margin-bottom:18px;">
      <div style="font-weight:600;font-size:14.5px;margin-bottom:8px;">Enlace para compartir con clientes</div>
      <div style="display:flex;gap:8px;">
        <input readonly value="${window.location.origin}/agendar" style="flex:1;padding:10px 12px;border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--paper);">
        <button type="button" class="btn btn-ghost" onclick="copiarEnlaceAgenda()">Copiar</button>
      </div>
    </div>

    <div class="card card-narrow" style="max-width:640px;">
      <form id="form-calendario" onsubmit="return submitCalendarioConfig(event)">
        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:16px;">
          <input type="checkbox" name="agendaActiva" ${c.activo ? 'checked' : ''}> Activar la agenda pública (si está apagada, el enlace no deja reservar)
        </label>

        <div style="font-weight:600;font-size:13.5px;margin-bottom:8px;">Duración y anticipación</div>
        <div class="field-row">
          <div class="field"><label>Duración de cada turno (min)</label><input type="number" name="duracionMinutos" value="${c.duracionMinutos || 60}" min="15" step="15"></div>
          <div class="field"><label>Días mínimos de anticipación</label><input type="number" name="minNoticeDays" value="${c.minNoticeDays ?? 1}" min="0"></div>
          <div class="field"><label>Días hacia adelante a mostrar</label><input type="number" name="diasVisibles" value="${c.diasVisibles || 21}" min="1"></div>
        </div>
        <div class="hint-text" style="margin:-6px 0 16px;">Con 1 día de anticipación, un cliente no puede agendar para hoy, recién desde mañana.</div>

        <div style="font-weight:600;font-size:13.5px;margin-bottom:10px;padding-top:12px;border-top:1px dashed var(--line-strong);">Días y horarios disponibles</div>
        ${filasDias}
        <div class="hint-text" style="margin-bottom:16px;">Un solo bloque horario por día. Si un edificio comparte ese día con otro, asignale directamente cada repetición del mes (por ejemplo, en un mes con 4 viernes, podés poner "Edificio A" en 1°, 2° y 3°, y "Edificio B" en el 4°). Dejalo en "Sin restricción" si esa repetición está abierta a cualquiera. Una vez que un edificio toma una fecha puntual, esa fecha queda bloqueada para los demás.</div>

        <button type="button" class="btn btn-ghost btn-block" style="margin-bottom:12px;" onclick="generarVistaPreviaCalendario()">🔍 Ver a qué edificio le toca cada fecha real (próximos meses)</button>
        <div id="vista-previa-calendario" style="margin-bottom:16px;"></div>

        <div style="font-weight:600;font-size:13.5px;margin:12px 0 8px;padding-top:12px;border-top:1px dashed var(--line-strong);">Edificios (uno por línea)</div>
        <div class="field"><textarea name="edificios" style="min-height:90px;">${escapeHtml((cache.calendarioEdificios || []).join('\n'))}</textarea></div>

        <div style="font-weight:600;font-size:13.5px;margin:12px 0 8px;padding-top:12px;border-top:1px dashed var(--line-strong);">Google Calendar</div>
        <div class="hint-text" style="margin-bottom:10px;">
          ${cache.googleServiceEmail ? `Compartí tu calendario de Google con esta cuenta (permiso "Hacer cambios en los eventos"): <strong>${escapeHtml(cache.googleServiceEmail)}</strong>` : 'Todavía no está configurada la cuenta de servicio de Google en el servidor.'}
        </div>
        <div class="field"><label>ID del calendario</label><input name="googleCalendarId" value="${escapeHtml(c.googleCalendarId || '')}" placeholder="tuemail@gmail.com o algo@group.calendar.google.com"></div>

        <button type="submit" class="btn btn-primary btn-block">Guardar configuración</button>
      </form>
      <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
        <button type="button" class="btn btn-ghost btn-block" onclick="probarGoogleCalendar()">Probar conexión con Google Calendar</button>
        <div id="resultado-google" style="margin-top:8px;"></div>
      </div>
    </div>`;
}
function renderCalendarioListaCitas(filtro, mensajeVacio) {
  const citas = (cache.citas || []).filter(filtro);
  const citasHtml = citas.length ? citas.map(ci => `
    <button type="button" class="user-row" style="width:100%;text-align:left;border:1px solid var(--line);cursor:pointer;" onclick="abrirDetalleCita('${ci.id}')">
      <div class="avatar">📅</div>
      <div><div class="u-name">${escapeHtml(ci.nombre_cliente)}${ci.estado === 'cancelada' ? ' <span class="tag tag-cerrado" style="margin-left:6px;">Cancelado</span>' : ''}${ci.estado === 'realizada' ? ' <span class="tag tag-resuelto" style="margin-left:6px;">Realizada</span>' : ''}</div>
      <div class="u-sub">${new Date(ci.fecha_hora).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' })} · ${escapeHtml(ci.edificio)} UD ${escapeHtml(ci.numero_unidad)} · ${escapeHtml(ci.telefono)}</div></div>
    </button>`).join('') : `<div class="hint-text">${mensajeVacio}</div>`;
  return `<div class="page-head" style="margin-top:6px;"><div><h1 style="font-size:18px;">${citas.length} turno${citas.length === 1 ? '' : 's'}</h1></div></div>
    <div class="user-list">${citasHtml}</div>`;
}
function abrirDetalleCita(id) {
  state.modal = 'detalle-cita';
  state.citaDetalleId = id;
  render();
}
function renderDetalleCitaModal() {
  const ci = (cache.citas || []).find(x => String(x.id) === String(state.citaDetalleId));
  if (!ci) return '';
  const filas = [
    ['Cliente', escapeHtml(ci.nombre_cliente)],
    ['Correo', escapeHtml(ci.correo_cliente || '—')],
    ['Teléfono', escapeHtml(ci.telefono || '—')],
    ['Edificio', escapeHtml(ci.edificio || '—')],
    ['Unidad', escapeHtml(ci.numero_unidad || '—')],
    ['Tiene internet', ci.tiene_internet ? 'Sí' : 'No'],
    ['Fecha y hora', new Date(ci.fecha_hora).toLocaleString('es-UY', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Montevideo' })],
    ['Duración', `${ci.duracion_minutos || 60} min`],
    ['Estado', ci.estado === 'realizada' ? 'Realizada' : ci.estado === 'cancelada' ? 'Cancelada' : 'Confirmada']
  ];
  const puedeMarcar = ci.estado === 'confirmada';
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>📅 Detalle del turno</h2>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:${puedeMarcar ? '18px' : '4px'};">
      ${filas.map(([label, valor]) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;border-bottom:1px dashed var(--line);padding-bottom:6px;"><span style="color:var(--ink-soft);">${label}</span><strong>${valor}</strong></div>`).join('')}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cerrar</button>
      ${puedeMarcar ? `<button type="button" class="btn btn-primary" onclick="marcarCitaRealizada('${ci.id}')">✅ Marcar como realizada</button>` : ''}
    </div>
  </div></div>`;
}
async function marcarCitaRealizada(id) {
  try {
    await api('POST', `/api/citas/${id}/marcar-realizada`);
    const ci = cache.citas.find(x => String(x.id) === String(id));
    if (ci) ci.estado = 'realizada';
    showToast('Turno marcado como realizado.');
    closeModal();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Configuración ---------------- */

async function submitConfiguracion(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const casillaEmail = fd.get('casillaEmail').trim();
  if (!casillaEmail) { showToast('Ingresá un correo electrónico válido.'); return false; }
  const payload = {
    casillaEmail, casillaNombre: fd.get('casillaNombre').trim(), correoActivo: fd.get('correoActivo') === 'on',
    imapHost: fd.get('imapHost').trim(), imapPort: Number(fd.get('imapPort')) || 993, imapUsuario: fd.get('imapUsuario').trim(), imapPassword: fd.get('imapPassword').trim(),
    smtpHost: fd.get('smtpHost').trim(), smtpPort: Number(fd.get('smtpPort')) || 465, smtpUsuario: fd.get('smtpUsuario').trim(), smtpPassword: fd.get('smtpPassword').trim(),
    avisoFindeActivo: fd.get('avisoFindeActivo') === 'on', avisoFindeMensaje: fd.get('avisoFindeMensaje').trim(),
    avisoFueraHorarioActivo: fd.get('avisoFueraHorarioActivo') === 'on', avisoFueraHorarioMensaje: fd.get('avisoFueraHorarioMensaje').trim(),
    avisoFueraHorarioInicio: fd.get('avisoFueraHorarioInicio'), avisoFueraHorarioFin: fd.get('avisoFueraHorarioFin'),
    telegramActivo: fd.get('telegramActivo') === 'on', telegramChatId: fd.get('telegramChatId').trim(),
    seguimientoActivo: fd.get('seguimientoActivo') === 'on',
    seguimientoDiasRecordatorio: Number(fd.get('seguimientoDiasRecordatorio')) || 2,
    seguimientoRepetirDias: Number(fd.get('seguimientoRepetirDias')) || 2,
    seguimientoDiasEscalar: Number(fd.get('seguimientoDiasEscalar')) || 0,
    respaldoActivo: fd.get('respaldoActivo') === 'on',
    respaldoCorreoDestino: fd.get('respaldoCorreoDestino').trim(),
    respaldoFrecuenciaDias: Number(fd.get('respaldoFrecuenciaDias')) || 7,
    recordatorioSinAsignarActivo: fd.get('recordatorioSinAsignarActivo') === 'on',
    recordatorioSinAsignarHora: fd.get('recordatorioSinAsignarHora') || '18:00',
    correoMantenimientoActivo: fd.get('correoMantenimientoActivo') === 'on',
    casillaNombreMant: fd.get('casillaNombreMant').trim(), smtpHostMant: fd.get('smtpHostMant').trim(),
    smtpPortMant: Number(fd.get('smtpPortMant')) || 465, smtpUsuarioMant: fd.get('smtpUsuarioMant').trim(),
    smtpPasswordMant: fd.get('smtpPasswordMant').trim()
  };
  await api('PUT', '/api/configuracion', payload);
  cache.configuracion = await api('GET', '/api/configuracion');
  showToast('Configuración guardada.');
  render();
  return false;
}

async function probarConexionCorreo() {
  const el = document.getElementById('resultado-prueba');
  if (el) el.innerHTML = '<span class="hint-text">Probando conexión…</span>';
  try {
    const r = await api('POST', '/api/configuracion/probar');
    if (el) el.innerHTML = `
      <div class="hint-text">IMAP (recibir): ${r.imap.ok ? '<strong style="color:var(--stamp-green);">funciona ✓</strong>' : `<strong style="color:var(--stamp-red);">falló</strong> — ${escapeHtml(r.imap.error || '')}`}</div>
      <div class="hint-text">SMTP (enviar): ${r.smtp.ok ? '<strong style="color:var(--stamp-green);">funciona ✓</strong>' : `<strong style="color:var(--stamp-red);">falló</strong> — ${escapeHtml(r.smtp.error || '')}`}</div>`;
  } catch (e) { if (el) el.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`; }
}
async function probarConexionCorreoMantenimiento() {
  const el = document.getElementById('resultado-prueba-mant');
  if (el) el.innerHTML = '<span class="hint-text">Probando conexión…</span>';
  try {
    await api('POST', '/api/configuracion/probar-mantenimiento');
    if (el) el.innerHTML = `<span style="color:var(--stamp-green);font-weight:600;">Funciona ✓</span>`;
  } catch (e) { if (el) el.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`; }
}

async function probarTelegram() {
  const el = document.getElementById('resultado-telegram');
  if (el) el.innerHTML = '<span class="hint-text">Enviando mensaje de prueba…</span>';
  try {
    await api('POST', '/api/configuracion/probar-telegram');
    if (el) el.innerHTML = `<span style="color:var(--stamp-green);font-weight:600;">Mensaje enviado, revisá el grupo de Telegram ✓</span>`;
  } catch (e) { if (el) el.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`; }
}

async function probarSeguimiento() {
  const el = document.getElementById('resultado-seguimiento');
  if (el) el.innerHTML = '<span class="hint-text">Ejecutando revisión…</span>';
  try {
    await api('POST', '/api/configuracion/probar-seguimiento');
    if (el) el.innerHTML = `<span style="color:var(--stamp-green);font-weight:600;">Listo, revisión ejecutada ✓ (si correspondía algún aviso, ya se mandó)</span>`;
  } catch (e) { if (el) el.innerHTML = `<span class="error-text">${escapeHtml(e.message)}</span>`; }
}

async function eliminarTodosLosTickets() {
  const escrito = prompt('Esto borra TODOS los tickets del sistema, sin excepción, y no se puede deshacer.\n\nEscribí ELIMINAR (en mayúsculas) para confirmar:');
  if (escrito !== 'ELIMINAR') { if (escrito !== null) showToast('No se eliminó nada: el texto no coincidía.'); return; }
  try {
    const r = await api('DELETE', '/api/tickets');
    cache.tickets = [];
    showToast(`${r.eliminados} ticket${r.eliminados === 1 ? '' : 's'} eliminado${r.eliminados === 1 ? '' : 's'}.`);
    go('dashboard');
  } catch (e) { showToast(e.message); }
}

async function reiniciarImap() {
  const escrito = prompt('Esto hace que el sistema vuelva a bajar TODOS los correos de la casilla desde el principio, como si nunca la hubiera revisado (puede recrear muchos tickets de golpe, y las respuestas viejas no van a quedar agrupadas en el ticket original). Escribí REINICIAR para confirmar:');
  if (escrito !== 'REINICIAR') { if (escrito !== null) showToast('No se hizo ningún cambio: el texto no coincidía.'); return; }
  try {
    await api('POST', '/api/configuracion/reiniciar-imap');
    showToast('Listo. La próxima revisión de la casilla va a bajar todo desde cero (puede tardar unos minutos según cuántos correos haya).');
  } catch (e) { showToast(e.message); }
}

async function saltarAlFinalImap() {
  if (!confirm('Esto marca como "ya revisado" todo lo que hay ahora mismo en la casilla, sin recrear tickets viejos. De ahora en más, solo se van a procesar los correos que lleguen nuevos. ¿Continuar?')) return;
  try {
    await api('POST', '/api/configuracion/saltar-al-final-imap');
    showToast('Listo. A partir de ahora solo se procesan los correos nuevos que lleguen.');
  } catch (e) { showToast(e.message); }
}

async function limpiarTicketsAntiguos() {
  const mesesStr = prompt('¿A partir de cuántos meses sin actividad querés borrar tickets ya Resueltos o Cerrados? (los que sigan Abiertos, En progreso o Esperando al Cliente nunca se tocan)', '2');
  if (mesesStr === null) return;
  const meses = Number(mesesStr);
  if (!meses || meses <= 0) { showToast('Ingresá un número de meses válido.'); return; }
  const dias = Math.round(meses * 30);
  if (!confirm(`Esto borra definitivamente todos los tickets Resueltos o Cerrados con más de ${meses} mes(es) sin actividad, junto con sus adjuntos. No se puede deshacer. ¿Continuar?`)) return;
  try {
    const r = await api('POST', '/api/tickets/limpiar-antiguos', { dias });
    showToast(`${r.eliminados} ticket${r.eliminados === 1 ? '' : 's'} antiguo${r.eliminados === 1 ? '' : 's'} eliminado${r.eliminados === 1 ? '' : 's'}.`);
    cache.tickets = (await api('GET', '/api/tickets')).map(mapTicket);
    if (state.view === 'dashboard') render();
  } catch (e) { showToast(e.message); }
}

async function limpiarAdjuntosHuerfanos() {
  if (!confirm('Esto busca en Storage archivos adjuntos que quedaron sueltos de tickets ya borrados (de antes de este cambio) y los elimina para liberar espacio. No afecta a ningún ticket que siga existiendo. ¿Continuar?')) return;
  try {
    const r = await api('POST', '/api/storage/limpiar-huerfanos');
    showToast(`Se liberaron ${r.archivosEliminados} archivo${r.archivosEliminados === 1 ? '' : 's'} de ${r.carpetasEliminadas} ticket${r.carpetasEliminadas === 1 ? '' : 's'} ya borrado${r.carpetasEliminadas === 1 ? '' : 's'}.`);
  } catch (e) { showToast(e.message); }
}

async function descargarRespaldoAhora() {
  try {
    const r = await fetch('/api/respaldo/descargar', { credentials: 'same-origin' });
    if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error || 'No se pudo generar el respaldo.'); }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `respaldo-ticketera-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Respaldo descargado.');
  } catch (e) { showToast(e.message); }
}

async function descargarRespaldoArchivos() {
  showToast('Armando el archivo, puede tardar unos segundos…');
  try {
    const r = await fetch('/api/respaldo/archivos', { credentials: 'same-origin' });
    if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error || 'No se pudo generar el respaldo de archivos.'); }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `respaldo-archivos-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Archivos adjuntos descargados.');
  } catch (e) { showToast(e.message); }
}

async function restaurarRespaldo() {
  const input = document.getElementById('input-restaurar');
  const file = input.files && input.files[0];
  if (!file) { showToast('Elegí primero el archivo de respaldo.'); return; }
  const escrito = prompt('Esto BORRA todos los datos actuales del sistema y los reemplaza por los del archivo elegido. No se puede deshacer.\n\nEscribí RESTAURAR para confirmar:');
  if (escrito !== 'RESTAURAR') { if (escrito !== null) showToast('No se restauró nada: el texto no coincidía.'); return; }
  try {
    const texto = await file.text();
    const data = JSON.parse(texto);
    showToast('Restaurando… no cierres esta ventana.');
    await api('POST', '/api/respaldo/restaurar', data);
    showToast('¡Restaurado con éxito! Recargando…');
    setTimeout(() => window.location.reload(), 1500);
  } catch (e) { showToast('Error al restaurar: ' + e.message); }
}

/* ---------------- Portal de cliente ---------------- */

async function loadClienteTickets() {
  const [rows, edificios] = await Promise.all([
    api('GET', '/api/portal/tickets'),
    cache.edificiosCliente.length ? Promise.resolve(cache.edificiosCliente) : api('GET', '/api/portal/edificios')
  ]);
  cache.tickets = rows.map(mapTicket);
  cache.edificiosCliente = edificios;
}
function goCliente(view) {
  state.view = view;
  render();
  if (view === 'cliente-documentos' && !state.clienteDocumentosCargados) {
    state.clienteDocumentosCargados = true;
    loadClienteDocumentos();
  }
  if (view === 'cliente-perfil' && !cache.perfilCliente) loadClientePerfil();
  if (view === 'cliente-proveedores') loadClienteProveedores();
}
async function loadClienteProveedores() {
  const [proveedores, edificios] = await Promise.all([
    api('GET', '/api/portal/proveedores'),
    cache.edificiosCliente.length ? Promise.resolve(cache.edificiosCliente) : api('GET', '/api/portal/edificios')
  ]);
  cache.proveedores = proveedores;
  cache.edificiosCliente = edificios;
  render();
}
function renderClienteProveedores() {
  const edificios = (cache.edificiosCliente || []).filter(e => e.rolCliente === 'Edificio');
  const rows = (cache.proveedores || []).map(p => `
    <div class="card" style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;"><div style="font-weight:600;font-size:14.5px;">${escapeHtml(p.nombre)}</div>
        <div style="font-size:12.5px;color:var(--ink-soft);">${escapeHtml(p.edificio_nombre)}${[p.telefono, p.correo].filter(Boolean).length ? ' · ' + [p.telefono, p.correo].filter(Boolean).map(escapeHtml).join(' · ') : ''}</div></div>
      <button type="button" class="btn btn-danger" onclick="borrarProveedorCliente('${p.id}')">Eliminar</button>
    </div></div>`).join('');
  const list = (cache.proveedores || []).length ? rows : `<div class="empty-state"><div class="big">Todavía no cargaste proveedores</div></div>`;
  return `<div class="page-head"><div><h1>Proveedores y Servicios</h1><div class="sub">Empresas de mantenimiento de los edificios que administrás</div></div>
      ${edificios.length ? `<button type="button" class="btn btn-primary" onclick="state.modal='nuevo-proveedor-cliente'; render();">+ Nuevo proveedor</button>` : ''}</div>
    ${!edificios.length ? `<div class="hint-text">Todavía no tenés ningún edificio a cargo.</div>` : list}`;
}
function renderNuevoProveedorClienteModal() {
  const edificios = (cache.edificiosCliente || []).filter(e => e.rolCliente === 'Edificio');
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>+ Nuevo proveedor</h2>
    <form onsubmit="return submitNuevoProveedorCliente(event)">
      <div class="field"><label>Nombre de la empresa</label><input name="nombre" placeholder="Ej: Ascensores XYZ" required></div>
      <div class="field"><label>Edificio</label><select name="edificioClienteId" required><option value="" disabled selected>Elegí el edificio</option>${edificios.map(e => `<option value="${e.id}">${escapeHtml(e.nombre)}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field"><label>Teléfono</label><input name="telefono"></div>
        <div class="field"><label>Correo</label><input name="correo" type="email"></div>
      </div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">Crear proveedor</button></div>
    </form></div></div>`;
}
async function submitNuevoProveedorCliente(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    await api('POST', '/api/portal/proveedores', {
      nombre: fd.get('nombre').trim(), edificioClienteId: fd.get('edificioClienteId'),
      telefono: fd.get('telefono').trim(), correo: fd.get('correo').trim()
    });
    cache.proveedores = await api('GET', '/api/portal/proveedores');
    closeModal();
    showToast('Proveedor creado.');
    render();
  } catch (e) { showToast(e.message); }
  return false;
}
async function borrarProveedorCliente(id) {
  if (!confirm('¿Eliminar este proveedor?')) return;
  try {
    await api('DELETE', `/api/portal/proveedores/${id}`);
    cache.proveedores = (cache.proveedores || []).filter(p => String(p.id) !== String(id));
    render();
  } catch (e) { showToast(e.message); }
}
async function loadClientePerfil() {
  cache.perfilCliente = await api('GET', '/api/portal/perfil');
  render();
}
function renderClientePerfil() {
  const p = cache.perfilCliente;
  if (!p) return `<div class="empty-state">Cargando…</div>`;
  return `<div class="page-head"><div><h1>Mi perfil</h1><div class="sub">Tus datos de contacto y tu contraseña de acceso al portal</div></div></div>
    <div class="card" style="max-width:520px;">
      <form onsubmit="return submitClientePerfilDatos(event)">
        <div class="field"><label>Edificio / cuenta</label><input value="${escapeHtml(p.nombre)}" disabled></div>
        <div class="field"><label>Correo de acceso</label><input value="${escapeHtml(p.correo || '')}" disabled></div>
        <div class="field"><label>Nombre de contacto</label><input name="contactoNombre" value="${escapeHtml(p.contacto_nombre || '')}" placeholder="Quién responde habitualmente los tickets"></div>
        <div class="field"><label>Teléfono</label><input name="telefono" value="${escapeHtml(p.telefono || '')}"></div>
        <div class="modal-actions" style="justify-content:flex-start;"><button type="submit" class="btn btn-primary">Guardar cambios</button></div>
      </form>
    </div>
    <div class="card" style="max-width:520px;margin-top:16px;">
      <h3 style="margin-top:0;">Cambiar contraseña</h3>
      <form onsubmit="return submitClientePerfilPassword(event)">
        <div class="field"><label>Contraseña actual</label><input type="password" name="passwordActual" required></div>
        <div class="field"><label>Contraseña nueva</label><input type="password" name="passwordNueva" minlength="6" required></div>
        <div class="field"><label>Repetir contraseña nueva</label><input type="password" name="passwordNueva2" minlength="6" required></div>
        <div class="modal-actions" style="justify-content:flex-start;"><button type="submit" class="btn btn-primary">Actualizar contraseña</button></div>
      </form>
    </div>`;
}
async function submitClientePerfilDatos(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    await api('PUT', '/api/portal/perfil', { contactoNombre: fd.get('contactoNombre'), telefono: fd.get('telefono') });
    cache.perfilCliente = await api('GET', '/api/portal/perfil');
    showToast('Datos actualizados.');
  } catch (e) { showToast(e.message); }
  return false;
}
async function submitClientePerfilPassword(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const passwordActual = fd.get('passwordActual');
  const passwordNueva = fd.get('passwordNueva');
  const passwordNueva2 = fd.get('passwordNueva2');
  if (passwordNueva !== passwordNueva2) { showToast('Las contraseñas nuevas no coinciden.'); return false; }
  try {
    await api('PUT', '/api/portal/perfil', { passwordActual, passwordNueva });
    ev.target.reset();
    showToast('Contraseña actualizada.');
  } catch (e) { showToast(e.message); }
  return false;
}
async function loadClienteDocumentos() {
  cache.documentosCliente = await api('GET', '/api/portal/documentos');
  render();
}
function iconoDocumento(mime) {
  if ((mime || '').startsWith('image/')) return '&#128247;';
  if (mime === 'application/pdf') return '&#128196;';
  return '&#128196;';
}
function renderClienteDocumentos() {
  const rows = cache.documentosCliente.map(d => `
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">${iconoDocumento(d.mime)}</span>
          <div><div style="font-weight:600;font-size:14.5px;">${escapeHtml(d.nombre)}</div>
            <div style="font-size:12.5px;color:var(--ink-soft);">${escapeHtml(d.categoria)} · ${fmtDateTime(d.creado)}</div></div>
        </div>
        <a class="btn btn-primary" href="/api/portal/documentos/${d.id}/descargar" target="_blank" rel="noopener">Ver / descargar</a>
      </div>
    </div>`).join('');
  const list = cache.documentosCliente.length ? rows : `<div class="empty-state"><div class="big">Todavía no hay documentos cargados</div><div class="sub">Acá vas a encontrar actas, manuales o contratos de tu edificio cuando los subamos.</div></div>`;
  return `<div class="page-head"><div><h1>Documentos</h1><div class="sub">Actas de servicio, manuales y contratos de tu edificio</div></div></div>${list}`;
}
function openClienteTicket(id) { state.view = 'cliente-ticket'; state.ticketId = id; state.pendingAttachments = []; render(); loadClienteTicketDetalle(id); }
async function loadClienteTicketDetalle(id) {
  const t = await api('GET', '/api/portal/tickets/' + id);
  const mapped = mapTicket(t);
  const idx = cache.tickets.findIndex(x => x.id === id);
  if (idx >= 0) cache.tickets[idx] = mapped; else cache.tickets.unshift(mapped);
  render();
}
async function submitClienteReply(ev, ticketId) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const cuerpo = fd.get('cuerpo').trim();
  if (!cuerpo) return false;
  try {
    await api('POST', `/api/portal/tickets/${ticketId}/mensajes`, { cuerpo, adjuntos: state.pendingAttachments });
    state.pendingAttachments = [];
    ev.target.reset();
    await loadClienteTicketDetalle(ticketId);
  } catch (e) { showToast(e.message); }
  return false;
}
function openNuevoTicketClienteModal() { state.modal = 'nuevo-ticket-cliente'; state.pendingAttachments = []; render(); }
async function submitNuevoTicketCliente(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const asunto = fd.get('asunto').trim();
  const cuerpo = fd.get('cuerpo').trim();
  const edificioClienteId = fd.get('edificioClienteId') || null;
  if (!asunto || !cuerpo) return false;
  try {
    const t = await api('POST', '/api/portal/tickets', { asunto, cuerpo, edificioClienteId, adjuntos: state.pendingAttachments });
    state.pendingAttachments = [];
    state.modal = null;
    await loadClienteTickets();
    showToast('Ticket creado.');
    openClienteTicket(t.id);
  } catch (e) { showToast(e.message); }
  return false;
}

/* ---------------- Render: piezas comunes ---------------- */

function logoSvg(variant) {
  const src = variant === 'white' ? '/logo-white.png' : '/logo.png';
  return `<img src="${src}" alt="Borcam" class="logo-img">`;
}
function navItems(activeView) {
  const items = [
    { v: 'dashboard', label: 'Tickets', ico: '&#9776;' }, { v: 'reservas', label: 'Reservas', ico: '&#128203;' },
    { v: 'grupos', label: 'Clientes', ico: '&#128100;' },
    { v: 'respuestas', label: 'Respuestas', ico: '&#128172;' }, { v: 'documentos', label: 'Documentos', ico: '&#128220;' },
    { v: 'documentos-edificio', label: 'Documentos edificio', ico: '&#128193;' }, { v: 'automatizaciones', label: 'Automatizaciones', ico: '&#9889;' },
    { v: 'calendario', label: 'Calendario', ico: '&#128197;' }, { v: 'servicio-tecnico', label: 'Servicio Técnico', ico: '&#128295;' },
    { v: 'newsletter', label: 'Newsletter', ico: '&#128240;' },
    { v: 'tags', label: 'Tags', ico: '&#127991;' },
  ];
  if (currentUser().es_superadmin) items.push({ v: 'estadisticas', label: 'Estadísticas', ico: '&#128202;' });
  items.push(
    { v: 'configuracion', label: 'Configuración', ico: '&#9881;' }, { v: 'perfil', label: 'Mi perfil', ico: '&#9998;' },
    { v: 'usuarios', label: 'Usuarios', ico: '&#128101;' }
  );
  return items.map(it => `<button class="nav-btn ${activeView === it.v ? 'active' : ''}" onclick="go('${it.v}')"><span class="ico">${it.ico}</span><span>${it.label}</span></button>`).join('');
}
function renderShell(inner) {
  const u = currentUser();
  return `
  <style>
    /* Tarjetas de totales del dashboard de Reporte mensual (Servicio Técnico). */
    .stat-card{background:var(--card,#fff);border:1px solid var(--line);border-radius:10px;padding:14px 18px;min-width:180px;flex:1;}
    .stat-card-label{font-size:12px;color:var(--muted,#6b7280);margin-bottom:6px;}
    .stat-card-value{font-size:22px;font-weight:700;}
    /* Arreglo: el menú lateral usaba "position: sticky", que se "despega" de su lugar cerca del
       final de una página muy larga (como la bandeja de Tickets, con hasta 20 tickets por página).
       Con "fixed" queda anclado a la pantalla siempre, sin importar cuánto scroll tenga el contenido. */
    @media (min-width: 881px) {
      .sidebar { position: fixed !important; top: 0; left: 0; height: 100vh; overflow-y: auto; }
      .main { margin-left: 220px; }
    }
    /* Rediseño del menú lateral: degradé oscuro, borde con brillo animado, ítems tipo "pill" con
       badge circular para el ícono, indicador activo con degradé + glow, avatar de usuario. */
    .sidebar{background:linear-gradient(190deg,#0A1830 0%,#0F2A4D 55%,#132F5C 100%);position:relative;box-shadow:2px 0 24px rgba(0,0,0,.25);}
    .sidebar::after{content:'';position:absolute;top:0;right:0;width:1px;height:100%;background:linear-gradient(180deg,transparent,rgba(61,126,240,.55),transparent);}
    .sidebar .brand-mark{position:relative;padding-bottom:16px;margin-bottom:14px;flex-direction:column;align-items:flex-start;gap:8px;}
    .sidebar .brand-mark::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,rgba(255,255,255,.22),transparent);}
    .sidebar .brand-mark .name{letter-spacing:.05em;font-size:11px;white-space:normal;line-height:1.4;width:100%;}
    .sidebar nav{gap:4px;}
    .nav-btn{position:relative;border-radius:10px;padding:9px 12px 9px 10px;transition:background .15s ease,color .15s ease,transform .15s ease;}
    .nav-btn .ico{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.06);font-size:13px;flex:none;transition:background .15s ease,transform .15s ease;}
    .nav-btn:hover{background:rgba(255,255,255,.08);color:#fff;transform:translateX(2px);}
    .nav-btn:hover .ico{background:rgba(255,255,255,.14);transform:scale(1.06);}
    .nav-btn.active{background:linear-gradient(90deg,var(--brand) 0%,var(--brand-2) 130%);color:#fff;box-shadow:0 4px 14px -2px rgba(30,86,199,.55);}
    .nav-btn.active .ico{background:rgba(255,255,255,.22);}
    .nav-btn.active::before{content:'';position:absolute;left:-14px;top:50%;transform:translateY(-50%);width:4px;height:22px;border-radius:0 4px 4px 0;background:#fff;box-shadow:0 0 10px 2px rgba(255,255,255,.6);}
    .sidebar-foot{border-top-color:rgba(255,255,255,.1);}
    .sidebar-foot .who{display:flex;align-items:center;gap:10px;padding:4px 4px 12px;}
    .sidebar-avatar{width:34px;height:34px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-weight:600;font-size:13px;color:#fff;background:linear-gradient(135deg,var(--brand-2),#8B5CF6);box-shadow:0 0 0 2px rgba(255,255,255,.15);overflow:hidden;}
    .sidebar-avatar img,.dash-profile-avatar img,.perfil-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;}
    .sidebar-foot .who-text strong{display:block;color:#fff;font-size:13.5px;}
    .sidebar-foot .who-text{font-size:12px;color:#8FAAD4;}
    .sidebar-theme-toggle{margin-left:auto;flex:none;width:30px;height:30px;border-radius:50%;border:none;background:rgba(255,255,255,.08);color:#EDF3FF;font-size:14px;display:flex;align-items:center;justify-content:center;transition:background .15s ease,transform .15s ease;}
    .sidebar-theme-toggle:hover{background:rgba(255,255,255,.18);transform:scale(1.06);}

    /* Sistema de diseño general (aplica a toda la app: botones, etiquetas, sello del número de
       ticket) — degradés + sombra tipo "3D" y animaciones sutiles al interactuar. */
    .card{border-radius:16px !important;box-shadow:0 1px 2px rgba(15,42,77,.05),0 4px 14px -10px rgba(15,42,77,.15) !important;transition:box-shadow .15s ease,transform .15s ease;}
    .card:hover{box-shadow:0 10px 26px -14px rgba(15,42,77,.22) !important;}
    .btn{transition:transform .15s ease,box-shadow .15s ease,filter .15s ease,background .15s ease,border-color .15s ease;border-radius:999px !important;gap:8px;}
    .btn-primary{background:linear-gradient(135deg,var(--brand) 0%,#2E6BE0 55%,var(--brand-2) 100%);box-shadow:0 4px 12px -4px rgba(30,86,199,.5);border:none;}
    .btn-primary:hover{transform:translateY(-1px);box-shadow:0 8px 18px -4px rgba(30,86,199,.6);filter:brightness(1.04);}
    .btn-primary:active{transform:translateY(0);box-shadow:0 2px 6px -2px rgba(30,86,199,.5);}
    /* Outline: fondo transparente, borde de color — para acciones secundarias (jerarquía clara
       frente al botón principal, que va relleno con degradé). */
    .btn-ghost{background:#fff;border:1.5px solid var(--brand-2) !important;color:var(--brand);box-shadow:0 1px 2px rgba(15,42,77,.04);}
    .btn-ghost:hover{transform:translateY(-1px);box-shadow:0 6px 14px -6px rgba(30,86,199,.3);background:var(--brand-tint);}
    .btn-danger{background:#fff;border:1.5px solid var(--stamp-red) !important;color:var(--stamp-red);box-shadow:0 1px 2px rgba(196,61,61,.05);}
    .btn-danger:hover{transform:translateY(-1px);box-shadow:0 6px 14px -6px rgba(196,61,61,.3);background:var(--stamp-red-tint);}

    /* Botón nativo "Elegir archivos" — mismo estilo píldora/degradé que "Enviar respuesta",
       en un color distinto (violeta) para diferenciarlo como acción secundaria de adjuntar. */
    input[type=file]::file-selector-button{border:none;border-radius:999px;padding:9px 18px;margin-right:10px;font-weight:600;font-size:13.5px;color:#fff;background:linear-gradient(135deg,#7C3AED 0%,#9D5CFF 55%,#B47CFF 100%);box-shadow:0 4px 12px -4px rgba(124,58,237,.5);cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,filter .15s ease;}
    input[type=file]::file-selector-button:hover{transform:translateY(-1px);box-shadow:0 8px 18px -4px rgba(124,58,237,.6);filter:brightness(1.05);}
    input[type=file]::file-selector-button:active{transform:translateY(0);}

    .tag{position:relative;padding-left:20px;font-weight:700;box-shadow:0 1px 2px rgba(15,42,77,.06);transition:transform .12s ease;border:1px solid currentColor;}
    .tag::before{content:'';position:absolute;left:9px;top:50%;transform:translateY(-50%);width:6px;height:6px;border-radius:50%;background:currentColor;}
    .tag-urgente{animation:tagPulseUrgente 1.8s ease-in-out infinite;}
    @keyframes tagPulseUrgente{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.35);}50%{box-shadow:0 0 0 5px rgba(196,61,61,0);}}
    .badge-atencion{box-shadow:0 1px 3px rgba(196,61,61,.25);animation:badgeGlow 2s ease-in-out infinite;}
    @keyframes badgeGlow{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.3);}50%{box-shadow:0 0 0 6px rgba(196,61,61,0);}}
    .badge-vencido{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--stamp-red-tint);color:var(--stamp-red);border:1px solid var(--stamp-red);}
    @media (prefers-reduced-motion: reduce){.tag-urgente,.badge-atencion{animation:none;}}

    .stub{border-radius:12px;transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease;}
    .stub-asunto{color:var(--ink);}
    .stub:hover{transform:translateY(-2px);box-shadow:0 10px 24px -8px rgba(15,42,77,.22);border-color:var(--line-strong);}
    .stub-num{background:linear-gradient(160deg,#0F2A4D 0%,#1B3F73 100%);position:relative;overflow:hidden;}
    .stub-num::before,.stub-num::after{background:var(--paper);}
    .stub-num > *{position:relative;z-index:1;}

    .stamp{border-radius:8px;padding:7px 16px;box-shadow:0 4px 10px -4px currentColor;background:#fff;}

    /* ---------------- Modo oscuro ---------------- */
    :root[data-theme="dark"]{
      --ink:#E8EEF7; --ink-soft:#9FB3CC; --paper:#0B1626; --card:#121F35;
      --line:#22334D; --line-strong:#33496B; --brand:#4C86E8; --brand-2:#6FA0F5; --brand-tint:#1B2C46;
      --stamp-red:#E2726B; --stamp-red-tint:#3A1F22; --stamp-amber:#E0B75C; --stamp-amber-tint:#3A331C;
      --stamp-green:#4FCB94; --stamp-green-tint:#173729; --gray:#8CA0BC; --gray-tint:#1C2A3F;
      color-scheme: dark; /* así el navegador dibuja en oscuro sus propios controles: el reloj de
      los campos de hora, el calendario de los campos de fecha, y la barra de scroll. */
    }
    :root:not([data-theme="dark"]){ color-scheme: light; }
    :root[data-theme="dark"] body{background:var(--paper);color:var(--ink);}
    :root[data-theme="dark"] .field input,:root[data-theme="dark"] .field select,:root[data-theme="dark"] .field textarea,
    :root[data-theme="dark"] .filters select,:root[data-theme="dark"] .filters input[type=search],:root[data-theme="dark"] .filters input[type=date],
    :root[data-theme="dark"] .btn-ghost,:root[data-theme="dark"] .btn-danger,:root[data-theme="dark"] .stamp,
    :root[data-theme="dark"] .msg-entrante,:root[data-theme="dark"] .msg-html-frame,:root[data-theme="dark"] .reply-tab.active,
    :root[data-theme="dark"] .modal,:root[data-theme="dark"] .sign-editor
    { background:var(--card) !important; color:var(--ink); border-color:var(--line-strong) !important; }
    :root[data-theme="dark"] .btn-primary,:root[data-theme="dark"] .msg-saliente{color:#fff;}
    :root[data-theme="dark"] .sidebar-theme-toggle{background:rgba(255,255,255,.08);color:#EDF3FF;}
    :root[data-theme="dark"] .sidebar-theme-toggle:hover{background:rgba(255,255,255,.16);}
    /* Estas barras siempre son azul marino de marca, en los dos modos (igual que el menú lateral,
       que ya usa un color fijo): sin este ajuste, se aclaraban solas al invertirse --ink. */
    :root[data-theme="dark"] .topbar,:root[data-theme="dark"] .bottomnav,:root[data-theme="dark"] .toast
    { background:#0F2A4D !important; }
    :root[data-theme="dark"] ::selection{background:var(--brand);color:#fff;}
  </style>
  <div class="shell">
    <aside class="sidebar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div>
      <nav>${navItems(state.view)}</nav>
      <div class="sidebar-foot"><div class="who"><div class="sidebar-avatar">${avatarInner(u)}</div><div class="who-text"><strong>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</strong>${escapeHtml(u.cargo)}</div>
      <button type="button" class="sidebar-theme-toggle" onclick="toggleTema()" title="Cambiar a modo ${document.documentElement.getAttribute('data-theme') === 'dark' ? 'claro' : 'oscuro'}">${document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙'}</button></div>
      <button class="nav-btn" onclick="logout()"><span class="ico">&#8630;</span><span>Cerrar sesión</span></button></div>
    </aside>
    <div class="main">
      <div class="topbar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div><button class="nav-btn" style="color:#fff" onclick="logout()">Salir</button></div>
      <div class="content">${inner}</div>
      <div class="bottomnav">${navItems(state.view)}</div>
    </div>
  </div>
  ${renderActiveModal()}
  ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}`;
}

/* ---------------- Dashboard / stub ---------------- */

// Estilos del rediseño de la bandeja: se inyectan una sola vez por render (id checa duplicados).
// Autocontenido — se puede sacar borrando esta función y su llamada en renderDashboard().
function dashboardStyleTag() {
  return `<style id="dash-style-v2">
    .filters{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow);}
    .filters select,.filters input[type=date]{transition:border-color .15s ease,box-shadow .15s ease;}
    .filters select:focus,.filters input:focus{outline:none;border-color:var(--brand-2);box-shadow:0 0 0 3px rgba(61,126,240,.15);}
    .filters input[type=search]{border-radius:99px;padding-left:14px;}

    .stub{border-radius:12px;transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease;}
    .stub-asunto{color:var(--ink);}
    .stub:hover{transform:translateY(-2px);box-shadow:0 10px 24px -8px rgba(15,42,77,.22);border-color:var(--line-strong);}
    .stub-num{background:linear-gradient(160deg,#0F2A4D 0%,#1B3F73 100%);}
    .stub-num::before,.stub-num::after{background:var(--paper);}

    .tag{position:relative;padding-left:20px;font-weight:700;box-shadow:0 1px 2px rgba(15,42,77,.06);border:1px solid currentColor;}
    .tag::before{content:'';position:absolute;left:9px;top:50%;transform:translateY(-50%);width:6px;height:6px;border-radius:50%;background:currentColor;}
    .tag-urgente{animation:tagPulseUrgente 1.8s ease-in-out infinite;}
    @keyframes tagPulseUrgente{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.35);}50%{box-shadow:0 0 0 5px rgba(196,61,61,0);}}

    .badge-atencion{box-shadow:0 1px 3px rgba(196,61,61,.25);animation:badgeGlow 2s ease-in-out infinite;}
    @keyframes badgeGlow{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.3);}50%{box-shadow:0 0 0 6px rgba(196,61,61,0);}}
    .badge-vencido{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--stamp-red-tint);color:var(--stamp-red);border:1px solid var(--stamp-red);}
    @media (prefers-reduced-motion: reduce){.tag-urgente,.badge-atencion{animation:none;}}

    .dash-profile-chip{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:99px;padding:5px 14px 5px 5px;box-shadow:0 1px 2px rgba(15,42,77,.05),0 8px 18px -10px rgba(15,42,77,.25);transition:transform .15s ease,box-shadow .15s ease;}
    .dash-profile-chip:hover{transform:translateY(-2px);box-shadow:0 1px 2px rgba(15,42,77,.05),0 12px 22px -8px rgba(15,42,77,.32);border-color:var(--line-strong);}
    .dash-profile-avatar{width:30px;height:30px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-weight:600;font-size:12px;color:#fff;background:linear-gradient(135deg,var(--brand-2),#8B5CF6);box-shadow:0 2px 6px rgba(30,86,199,.4);overflow:hidden;}
    .dash-profile-name{font-size:13.5px;font-weight:600;color:var(--ink);}
    @media (max-width:600px){.dash-profile-name{display:none;}}

    .carga-trabajo{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:14px;}
    .carga-trabajo-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-soft);margin-right:2px;}
    .carga-chip{display:inline-flex;align-items:center;gap:6px;background:var(--card);border:1px solid var(--line-strong);border-radius:99px;padding:5px 6px 5px 12px;font-size:12.5px;font-weight:600;color:var(--ink);transition:transform .12s ease,box-shadow .12s ease;}
    .carga-chip:hover{transform:translateY(-1px);box-shadow:0 4px 10px -4px rgba(15,42,77,.25);border-color:var(--brand-2);}
    .carga-chip .n{background:var(--brand-tint);color:var(--brand);border-radius:99px;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700;padding:0 6px;}
    .carga-chip-alerta{border-color:var(--stamp-red);}
    .carga-chip-alerta .n{background:var(--stamp-red-tint);color:var(--stamp-red);}
  </style>`;
}
function renderStub(t, clientMode, selectable) {
  const lastMsg = t.mensajes[t.mensajes.length - 1];
  const grupo = t.grupoId ? cache.clientes.find(g => g.id === t.grupoId) : null;
  const agente = t.asignadoA ? cache.usuarios.find(u => u.id === t.asignadoA) : null;
  const onclick = clientMode ? `openClienteTicket('${t.id}')` : `openTicket('${t.id}')`;
  const checked = selectable && state.selectedTickets.has(t.id);
  return `
  <div class="stub" role="button" tabindex="0" onclick="${onclick}" onkeydown="if(event.key==='Enter'){${onclick}}">
    ${selectable ? `<label class="stub-check" onclick="event.stopPropagation()"><input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleSeleccionTicket('${t.id}', this.checked)"></label>` : ''}
    <div class="stub-num"><div class="n">${t.numero.split('-').slice(1).join('-')}</div><div class="y">${t.numero.split('-')[0]}</div></div>
    <div class="stub-body">
      <div class="stub-top"><div class="stub-asunto">${escapeHtml(t.asunto)}</div><div class="stub-time">${fmtRel(t.actualizado)}</div></div>
      <div class="stub-remitente">${escapeHtml(t.remitenteNombre)} · ${escapeHtml(t.remitenteEmail)}${lastMsg ? ' · última respuesta: ' + escapeHtml(lastMsg.autor) : ''}</div>
      <div class="stub-snippet">${escapeHtml(lastMsg ? lastMsg.cuerpo : '')}</div>
      <div class="stub-meta">
        ${!clientMode && t.necesitaAtencion ? `<span class="badge-atencion">🔔 Respondió el cliente</span>` : ''}
        ${!clientMode && ticketVencido(t) ? `<span class="badge-vencido">⏰ Vencido</span>` : ''}
        ${!clientMode && t.reservasPendientes > 0 ? `<span class="tag tag-resuelto">📅 ${t.reservasPendientes > 1 ? t.reservasPendientes + ' reservas agendadas' : 'Reserva agendada'}</span>` : ''}
        <span class="tag tag-${slug(t.estado)}">${t.estado}</span><span class="tag tag-${slug(t.prioridad)}">${t.prioridad}</span><span class="tag tag-cat">${escapeHtml(t.categoria)}</span>
        ${!clientMode && grupo ? `<span class="tag tag-cliente">${escapeHtml(grupo.nombre)}</span>` : ''}
        ${clientMode && cache.edificiosCliente.length > 1 && t.edificioNombre ? `<span class="tag tag-cliente">${escapeHtml(t.edificioNombre)}</span>` : ''}
        ${!clientMode ? `<span class="tag tag-agente">${agente ? '👤 ' + escapeHtml(agente.nombre) + ' ' + escapeHtml(agente.apellido) : 'Sin asignar'}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function renderBulkActionBar() {
  const n = state.selectedTickets.size;
  const estOpts = `<option value="">Cambiar estado a…</option>` + CAT.ESTADOS.map(e => `<option value="${e}">${e}</option>`).join('');
  const agenteOpts = `<option value="" disabled selected>Elegí un agente…</option><option value="ninguno">Sin asignar</option>` + cache.usuarios.map(u => `<option value="${u.id}">${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</option>`).join('');
  const selectStyle = 'height:38px;padding:0 10px;border:1px solid var(--line-strong);border-radius:var(--radius);font-size:13.5px;background:#fff;';
  const btnStyle = 'height:38px;';
  return `
  <div class="card" style="margin-bottom:16px;">
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px;">
      <strong style="font-size:13.5px;">${n} ticket${n === 1 ? '' : 's'} seleccionado${n === 1 ? '' : 's'}</strong>
      <select id="bulk-estado" style="${selectStyle}">${estOpts}</select>
      <button class="btn btn-ghost" style="${btnStyle}" onclick="aplicarAccionMasivaEstado()">Aplicar estado</button>
      <select id="bulk-agente" style="${selectStyle}">${agenteOpts}</select>
      <button class="btn btn-ghost" style="${btnStyle}" onclick="aplicarAccionMasivaAgente()">Aplicar asignación</button>
    </div>
    <div style="display:flex;justify-content:center;align-items:center;gap:10px;padding-top:10px;border-top:1px dashed var(--line-strong);">
      <button class="btn btn-danger" style="${btnStyle}" onclick="aplicarAccionMasivaEliminar()">Eliminar seleccionados</button>
      <button class="btn btn-ghost" style="${btnStyle}" onclick="limpiarSeleccion()">Deseleccionar todo</button>
    </div>
  </div>`;
}

function esTicketDeReserva(t) {
  return t.asunto.toLowerCase().includes('reserva');
}
/* ---------------- Agendar reserva (calendario propio) ----------------
   Antes este bloque generaba un .ics para descargar y el sistema no se enteraba de nada. Ahora
   guarda la reserva en la tabla reservas_calendario (igual que "Agendar servicio técnico" hace con
   servicios_tecnicos) y queda visible/gestionable en Reservas → Calendario de reservas. */
function renderReservaCalendario(t) {
  const ahora = new Date();
  const fechaDefault = ahora.toISOString().slice(0, 10);
  return `<div class="card card-narrow" style="max-width:560px;margin:14px 0;">
    ${configSectionHead('📅', 'Agendar esta reserva', 'Queda guardada en el calendario de reservas del sistema (sección Reservas → Calendario de reservas).')}
    <div class="field"><label>Fecha</label><input type="date" id="reserva-fecha" value="${fechaDefault}"></div>
    <div class="field"><label>Horario</label><input type="text" id="reserva-horario" placeholder="Ej: Turno nocturno"></div>
    <div class="field"><label>Servicio</label><input type="text" id="reserva-servicio" placeholder="Ej: Barbacoas, Barbacoa 02"></div>
    <div class="field"><label>Edificio</label><input type="text" id="reserva-edificio" placeholder="Ej: Edificio Estrellas de Malvín"></div>
    <div class="field"><label>Realizada por</label><input type="text" id="reserva-realizado-por" placeholder="Nombre de quien hace la reserva"></div>
    <div style="margin-top:10px;"><button type="button" class="btn btn-primary" onclick="guardarReservaCalendario('${t.id}')">📅 Agendar reserva</button></div>
  </div>`;
}
// Al tildar "Todo el día" se ocultan hora/duración, ya que no aplican a un evento de día completo
// (así queda igual que la opción "Todo el día" de One Calendar / Windows Calendar / Outlook).
function toggleTodoElDiaIcs(prefijo) {
  const marcado = document.getElementById(`${prefijo}-ics-todo-el-dia`).checked;
  const horaWrap = document.getElementById(`${prefijo}-ics-hora-wrap`);
  const duracionWrap = document.getElementById(`${prefijo}-ics-duracion-wrap`);
  if (horaWrap) horaWrap.style.display = marcado ? 'none' : '';
  if (duracionWrap) duracionWrap.style.display = marcado ? 'none' : '';
}
async function guardarReservaCalendario(ticketId) {
  const t = cache.tickets.find(x => x.id === ticketId);
  if (!t) return;
  const fecha = document.getElementById('reserva-fecha').value;
  const horario = document.getElementById('reserva-horario').value;
  const servicio = document.getElementById('reserva-servicio').value;
  const edificio = document.getElementById('reserva-edificio').value;
  const realizadoPor = document.getElementById('reserva-realizado-por').value;
  if (!fecha) { showToast('Elegí una fecha.'); return; }
  try {
    await api('POST', '/api/reservas-calendario', { ticketId: t.id, ticketNumero: t.numero, clienteId: t.grupoId || null, titulo: t.asunto, fecha, horario, servicio, edificio, realizadoPor });
    showToast('Reserva agendada.');
    // Después de agendar, vuelve directo a Reservas → Tickets de reserva, en vez de dejarte en el ticket.
    state.view = 'reservas';
    state.reservasTab = 'tickets';
    render();
  } catch (e) { showToast(e.message); }
}
/* ---------------- Calendario de reservas (vista propia dentro de "Reservas") ----------------
   Convive con la lista de tickets con "reserva" en el asunto (pestañas separadas), pero es
   independiente: acá viven las reservas ya agendadas, con su propio estado y gestión. */
async function cargarReservasCalendario() {
  cache.reservasCalendario = await api('GET', '/api/reservas-calendario');
}
async function recargarReservasCalendario() {
  await cargarReservasCalendario();
  refrescarVistaReservas();
}
function refrescarVistaReservas() {
  const el = document.querySelector('.content');
  if (el && state.view === 'reservas') el.innerHTML = renderReservas();
}
function cambiarReservasTab(t) { state.reservasTab = t; render(); }
function filaReservaCalendario(r) {
  return `
    <button type="button" class="user-row" style="width:100%;text-align:left;border:1px solid var(--line);cursor:pointer;" onclick="abrirDetalleReservaCalendario(${r.id})">
      <div class="avatar">📅</div>
      <div><div class="u-name">${escapeHtml(r.servicio || r.titulo)}${r.estado === 'realizada' ? ' <span class="tag tag-resuelto" style="margin-left:6px;">Realizada</span>' : r.estado === 'cancelada' ? ' <span class="tag" style="margin-left:6px;background:var(--stamp-red-bg,#fde8e8);color:var(--stamp-red,#b42318);">Cancelada</span>' : ''}</div>
      <div class="u-sub">${new Date(r.fecha_hora).toLocaleDateString('es-UY', { dateStyle: 'medium', timeZone: 'America/Montevideo' })}${r.horario ? ' · ' + escapeHtml(r.horario) : ''}${r.edificio ? ' · ' + escapeHtml(r.edificio) : ''}${r.realizado_por ? ' · ' + escapeHtml(r.realizado_por) : ''}${r.ticket_numero ? ` · Ticket ${escapeHtml(r.ticket_numero)}` : ''}</div></div>
    </button>`;
}
function renderCalendarioReservasTab() {
  const pendientes = (cache.reservasCalendario || []).filter(r => r.estado === 'pendiente').sort((a, b) => new Date(a.fecha_hora) - new Date(b.fecha_hora));
  const listaPendientes = pendientes.length ? pendientes.map(filaReservaCalendario).join('') : `<div class="hint-text">No hay reservas agendadas.</div>`;
  return `
    <div class="page-head" style="margin-top:6px;"><div><h1 style="font-size:18px;">${pendientes.length} reserva${pendientes.length === 1 ? '' : 's'} agendada${pendientes.length === 1 ? '' : 's'}</h1></div></div>
    <div class="hint-text" style="margin-bottom:10px;">Cuando pasa la fecha de una reserva pendiente, el sistema la marca sola como realizada y cierra su ticket — la vas a encontrar en "Reservas cerradas".</div>
    <div class="user-list">${listaPendientes}</div>`;
}
function renderReservasCerradasTab() {
  const cerradas = (cache.reservasCalendario || []).filter(r => r.estado !== 'pendiente').sort((a, b) => new Date(b.fecha_hora) - new Date(a.fecha_hora));
  const lista = cerradas.length ? cerradas.map(filaReservaCalendario).join('') : `<div class="hint-text">Todavía no hay reservas realizadas ni canceladas.</div>`;
  return `
    <div class="page-head" style="margin-top:6px;"><div><h1 style="font-size:18px;">${cerradas.length} reserva${cerradas.length === 1 ? '' : 's'} cerrada${cerradas.length === 1 ? '' : 's'}</h1></div></div>
    <div class="hint-text" style="margin-bottom:10px;">Realizadas y canceladas. Entrá a una para borrarla definitivamente si hace falta.</div>
    <div class="user-list">${lista}</div>`;
}
function abrirDetalleReservaCalendario(id) {
  state.modal = 'detalle-reserva-calendario';
  state.detalleReservaId = id;
  render();
}
function renderDetalleReservaCalendarioModal() {
  const r = (cache.reservasCalendario || []).find(x => x.id === state.detalleReservaId);
  if (!r) return '';
  const puedeGestionar = r.estado === 'pendiente';
  const filaDato = (label, valor) => valor ? `
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);">
      <span style="color:var(--ink-soft);">${escapeHtml(label)}</span>
      <strong>${escapeHtml(valor)}</strong>
    </div>` : '';
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>📅 ${escapeHtml(r.titulo)}</h2>
    ${r.ticket_numero ? `<p class="sub">Ticket ${escapeHtml(r.ticket_numero)}</p>` : ''}
    <div style="margin:8px 0 4px;">
      ${filaDato('Fecha', new Date(r.fecha_hora).toLocaleDateString('es-UY', { dateStyle: 'medium', timeZone: 'America/Montevideo' }))}
      ${filaDato('Horario', r.horario)}
      ${filaDato('Servicio', r.servicio)}
      ${filaDato('Edificio', r.edificio)}
      ${filaDato('Realizada por', r.realizado_por)}
      ${filaDato('Estado', r.estado === 'realizada' ? 'Realizada' : r.estado === 'cancelada' ? 'Cancelada' : 'Pendiente')}
    </div>
    <div class="modal-actions" style="flex-wrap:wrap;">
      ${r.ticket_id ? `<button type="button" class="btn btn-ghost" onclick="closeModal(); openTicket('${r.ticket_id}')">Ver ticket</button>` : ''}
      <button type="button" class="btn btn-ghost" onclick="abrirReprogramarReserva(${r.id})">✏️ Editar</button>
      ${puedeGestionar ? `<button type="button" class="btn btn-primary" onclick="marcarReservaRealizada(${r.id})">✅ Marcar realizada</button>` : ''}
      ${puedeGestionar ? `<button type="button" class="btn btn-danger" onclick="cancelarReserva(${r.id})">Cancelar reserva</button>` : ''}
      <button type="button" class="btn btn-danger" onclick="eliminarReservaCalendario(${r.id})">🗑️ Eliminar</button>
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cerrar</button>
    </div>
  </div></div>`;
}
async function eliminarReservaCalendario(id) {
  if (!confirm('¿Eliminar esta reserva? Esta acción no se puede deshacer.')) return;
  try {
    await api('DELETE', `/api/reservas-calendario/${id}`);
    await recargarReservasCalendario();
    showToast('Reserva eliminada.');
    closeModal();
  } catch (e) { showToast(e.message); }
}
async function marcarReservaRealizada(id) {
  try {
    await api('POST', `/api/reservas-calendario/${id}/marcar-realizada`);
    await recargarReservasCalendario();
    showToast('Reserva marcada como realizada.');
    closeModal();
  } catch (e) { showToast(e.message); }
}
async function cancelarReserva(id) {
  if (!confirm('¿Cancelar esta reserva?')) return;
  try {
    await api('POST', `/api/reservas-calendario/${id}/cancelar`);
    await recargarReservasCalendario();
    showToast('Reserva cancelada.');
    closeModal();
  } catch (e) { showToast(e.message); }
}
function abrirReprogramarReserva(id) {
  state.modal = 'reprogramar-reserva';
  state.reprogramarReservaId = id;
  render();
}
function renderReprogramarReservaModal() {
  const r = (cache.reservasCalendario || []).find(x => x.id === state.reprogramarReservaId);
  if (!r) return '';
  const fechaDefault = new Date(r.fecha_hora).toISOString().slice(0, 10);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>✏️ Editar reserva</h2>
    <p class="sub">${escapeHtml(r.titulo)}</p>
    <div class="field"><label>Fecha</label><input type="date" id="reprog-reserva-fecha" value="${fechaDefault}"></div>
    <div class="field"><label>Horario</label><input type="text" id="reprog-reserva-horario" value="${escapeHtml(r.horario || '')}" placeholder="Ej: Turno nocturno"></div>
    <div class="field"><label>Servicio</label><input type="text" id="reprog-reserva-servicio" value="${escapeHtml(r.servicio || '')}" placeholder="Ej: Barbacoas, Barbacoa 02"></div>
    <div class="field"><label>Edificio</label><input type="text" id="reprog-reserva-edificio" value="${escapeHtml(r.edificio || '')}" placeholder="Ej: Edificio Estrellas de Malvín"></div>
    <div class="field"><label>Realizada por</label><input type="text" id="reprog-reserva-realizado-por" value="${escapeHtml(r.realizado_por || '')}"></div>
    <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="button" class="btn btn-primary" onclick="confirmarReprogramarReserva()">Guardar</button></div>
  </div></div>`;
}
async function confirmarReprogramarReserva() {
  const id = state.reprogramarReservaId;
  const r = (cache.reservasCalendario || []).find(x => x.id === id);
  if (!r) return;
  const fecha = document.getElementById('reprog-reserva-fecha').value;
  const horario = document.getElementById('reprog-reserva-horario').value;
  const servicio = document.getElementById('reprog-reserva-servicio').value;
  const edificio = document.getElementById('reprog-reserva-edificio').value;
  const realizadoPor = document.getElementById('reprog-reserva-realizado-por').value;
  if (!fecha) { showToast('Elegí una fecha.'); return; }
  try {
    await api('PUT', `/api/reservas-calendario/${id}`, { titulo: r.titulo, fecha, horario, servicio, edificio, realizadoPor });
    await cargarReservasCalendario();
    showToast('Reserva actualizada.');
    state.modal = 'detalle-reserva-calendario';
    render();
  } catch (e) { showToast(e.message); }
}
// Atajo "🏷️ Pedido de Tag" desde la ficha del ticket: te lleva directo a Tags → Nuevo pedido
// con el número de ticket (y el nombre del solicitante) ya cargados.
function irAPedidoDeTagDesdeTicket(ticketId) {
  const t = cache.tickets.find(x => x.id === ticketId);
  if (!t) return;
  // Si el ticket ya tiene asignado un Cliente con rol Edificio, se precarga ese edificio en el
  // pedido (los residentes casi nunca tienen cuenta de cliente propia: el Cliente del ticket
  // normalmente ES el edificio).
  const clienteDelTicket = t.grupoId ? cache.clientes.find(c => c.id === t.grupoId) : null;
  const edificioPrecarga = clienteDelTicket && clienteDelTicket.rolCliente === 'Edificio' ? clienteDelTicket.nombre : '';
  state.tagsPrecarga = { ticket: t.numero, cliente: t.remitenteNombre || '', edificio: edificioPrecarga };
  state.tagsTab = 'nuevo';
  state.view = 'tags';
  render();
  renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } });
}
/* ---------------- Agendar servicio técnico (botón + modal, cualquier ticket) ----------------
   Igual de autocontenido que el bloque de Reservas: no toca la base de datos, se puede sacar
   borrando este bloque, la llamada al botón en renderTicket() y la línea en renderActiveModal(). */
function openAgendarServicioModal(ticketId) {
  state.modal = 'agendar-servicio';
  state.agendarServicioTicketId = ticketId;
  state.pendingCostosServicio = [];
  render();
  asegurarCatalogoCostosCargado().then(() => { if (state.modal === 'agendar-servicio') render(); });
}
function renderAgendarServicioModal() {
  const t = cache.tickets.find(x => x.id === state.agendarServicioTicketId);
  if (!t) { return ''; }
  const ahora = new Date(Date.now() + 60 * 60000);
  const fechaDefault = ahora.toISOString().slice(0, 10);
  const horaDefault = ahora.toTimeString().slice(0, 5);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>📅 Agendar servicio técnico</h2>
    <p class="sub">Ticket ${escapeHtml(t.numero)} — ${escapeHtml(t.asunto)}</p>
    <div class="field"><label>Título del evento</label><input type="text" id="servicio-ics-titulo" value="${escapeHtml(`Servicio técnico — ${t.asunto}`)}"></div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" id="servicio-ics-todo-el-dia" onchange="toggleTodoElDiaIcs('servicio')"> Todo el día</label>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="servicio-ics-fecha" value="${fechaDefault}"></div>
      <div class="field" id="servicio-ics-hora-wrap"><label>Hora</label><input type="time" id="servicio-ics-hora" value="${horaDefault}"></div>
    </div>
    <div class="field" id="servicio-ics-duracion-wrap"><label>Duración (minutos)</label><input type="number" id="servicio-ics-duracion" min="15" step="15" value="60"></div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" id="servicio-ics-aplica-iva" checked> Aplicar IVA (22%)</label>
    ${renderCostosPendientesEditor()}
    <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="button" class="btn btn-primary" onclick="guardarServicioTecnico()">📅 Agendar</button></div>
  </div></div>`;
}
async function guardarServicioTecnico() {
  const t = cache.tickets.find(x => x.id === state.agendarServicioTicketId);
  if (!t) return;
  const fecha = document.getElementById('servicio-ics-fecha').value;
  const hora = document.getElementById('servicio-ics-hora').value;
  const duracion = document.getElementById('servicio-ics-duracion').value;
  const titulo = document.getElementById('servicio-ics-titulo').value;
  const todoElDia = document.getElementById('servicio-ics-todo-el-dia').checked;
  const aplicaIva = document.getElementById('servicio-ics-aplica-iva').checked;
  if (!fecha) { showToast('Elegí una fecha.'); return; }
  if (!todoElDia && !hora) { showToast('Elegí una hora, o tildá "Todo el día".'); return; }
  if (!t.grupoId) { showToast('Este ticket no está vinculado a ningún cliente/edificio. Asignalo a un cliente antes de agendar el servicio técnico.'); return; }
  // Ya no se descarga ningún .ics: el turno queda guardado en el sistema, visible en Servicio Técnico.
  try {
    const nuevo = await api('POST', '/api/servicios-tecnicos', { ticketId: t.id, ticketNumero: t.numero, clienteId: t.grupoId, titulo, fecha, hora, duracion, todoElDia, aplicaIva });
    await aplicarCostosPendientes(nuevo.id);
    await refreshTicket(t.id);
    showToast('Servicio técnico agendado.');
    closeModal();
  } catch (e) { showToast(e.message); }
}
// soloAgendados=true -> tickets de reserva que ya tienen una reserva pendiente agendada (pestaña
// "Reserva Agendada"). soloAgendados=false -> el resto, los que todavía no se agendaron (pestaña
// "Tickets de reserva"). Así se separan sin duplicar tickets entre las dos pestañas.
function filteredReservas(soloAgendados) {
  const f = state.filtersReservas;
  return cache.tickets
    .filter(esTicketDeReserva)
    .filter(t => soloAgendados ? t.reservasPendientes > 0 : !(t.reservasPendientes > 0))
    .filter(t => f.estado === 'todos' ? (t.estado !== 'Cerrado' && t.estado !== 'Resuelto') : t.estado === f.estado)
    .filter(t => f.prioridad === 'todas' || t.prioridad === f.prioridad)
    .filter(t => { if (!f.search) return true; const s = f.search.toLowerCase(); return t.asunto.toLowerCase().includes(s) || t.numero.toLowerCase().includes(s) || t.remitenteNombre.toLowerCase().includes(s) || t.remitenteEmail.toLowerCase().includes(s); })
    .sort((a, b) => new Date(b.actualizado) - new Date(a.actualizado));
}
function setFilterReservas(k, v) { state.filtersReservas[k] = v; state.paginaReservas = 1; state.paginaReservasAgendadas = 1; render(); }
function irAPaginaReservas(n) { state.paginaReservas = n; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function irAPaginaReservasAgendadas(n) { state.paginaReservasAgendadas = n; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function renderTicketsReservaTab(soloAgendados) {
  const todos = filteredReservas(soloAgendados);
  const paginaKey = soloAgendados ? 'paginaReservasAgendadas' : 'paginaReservas';
  const irAPagina = soloAgendados ? 'irAPaginaReservasAgendadas' : 'irAPaginaReservas';
  const totalPaginas = Math.max(1, Math.ceil(todos.length / TICKETS_POR_PAGINA));
  if (!state[paginaKey]) state[paginaKey] = 1; // por si la clave no estaba inicializada en state
  if (state[paginaKey] > totalPaginas) state[paginaKey] = totalPaginas;
  if (state[paginaKey] < 1) state[paginaKey] = 1;
  const desde = (state[paginaKey] - 1) * TICKETS_POR_PAGINA;
  const tickets = todos.slice(desde, desde + TICKETS_POR_PAGINA);

  const estOptions = ['todos', ...CAT.ESTADOS].map(e => `<option value="${e}" ${state.filtersReservas.estado === e ? 'selected' : ''}>${e === 'todos' ? 'Todo estado (sin cerrados ni resueltos)' : e}</option>`).join('');
  const prioOptions = ['todas', ...CAT.PRIORIDADES].map(p => `<option value="${p}" ${state.filtersReservas.prioridad === p ? 'selected' : ''}>${p === 'todas' ? 'Toda prioridad' : p}</option>`).join('');
  const mensajeVacio = soloAgendados ? 'Acá aparecen los tickets de reserva que ya tienen una reserva pendiente agendada.' : 'Acá aparecen automáticamente los tickets cuyo asunto contiene la palabra "reserva" y todavía no tienen una reserva agendada.';
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t, false, true)).join('')}</div>` : `<div class="empty-state"><div class="big">No hay reservas que coincidan</div><div>${mensajeVacio}</div></div>`;

  const paginacion = todos.length > TICKETS_POR_PAGINA ? `
    <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:18px;">
      <button class="btn btn-ghost" ${state[paginaKey] <= 1 ? 'disabled' : ''} onclick="${irAPagina}(${state[paginaKey] - 1})">&larr; Anterior</button>
      <span style="font-size:13.5px;color:var(--ink-soft);">Página ${state[paginaKey]} de ${totalPaginas}</span>
      <button class="btn btn-ghost" ${state[paginaKey] >= totalPaginas ? 'disabled' : ''} onclick="${irAPagina}(${state[paginaKey] + 1})">Siguiente &rarr;</button>
    </div>` : '';

  return `
    <div class="sub" style="margin-bottom:10px;">${todos.length} ticket${todos.length === 1 ? '' : 's'} con "reserva" en el asunto</div>
    <div class="filters">
      <select onchange="setFilterReservas('estado', this.value)">${estOptions}</select>
      <select onchange="setFilterReservas('prioridad', this.value)">${prioOptions}</select>
      <input type="search" placeholder="Buscar y presioná Enter…" value="${escapeHtml(state.filtersReservas.search)}" onkeydown="if(event.key==='Enter'){ setFilterReservas('search', this.value); }" onsearch="setFilterReservas('search', this.value)">
    </div>
    ${state.selectedTickets.size ? renderBulkActionBar() : ''}
    ${list}
    ${paginacion}`;
}
function renderReservas() {
  const tab = state.reservasTab || 'calendario';
  const tabsHtml = [
    { v: 'tickets', label: 'Tickets de reserva' },
    { v: 'calendario', label: '📅 Calendario de reservas' },
    { v: 'cerradas', label: 'Reservas cerradas' },
    { v: 'agendados', label: '📅 Reserva Agendada' }
  ].map(t => `<button class="reply-tab ${tab === t.v ? 'active' : ''}" type="button" onclick="cambiarReservasTab('${t.v}')">${t.label}</button>`).join('');
  const contenido = tab === 'tickets' ? renderTicketsReservaTab(false) : tab === 'agendados' ? renderTicketsReservaTab(true) : tab === 'cerradas' ? renderReservasCerradasTab() : renderCalendarioReservasTab();
  return `
    <div class="page-head"><div><h1>Reservas</h1><div class="sub">Reservas agendadas desde tickets, y los tickets de reserva que las originan.</div></div></div>
    <div class="reply-tabs" style="margin-bottom:14px;">${tabsHtml}</div>
    ${contenido}`;
}

// Carga de trabajo actual: cuenta, por cada agente, cuántos tickets tiene abiertos ahora mismo
// (sin contar Cerrados ni Resueltos), para poder repartir mejor al asignar uno nuevo.
function cargaTrabajoPorAgente() {
  const activos = cache.tickets.filter(t => !esTicketDeReserva(t) && t.estado !== 'Cerrado' && t.estado !== 'Resuelto');
  const conteos = {};
  let sinAsignar = 0;
  activos.forEach(t => {
    if (!t.asignadoA) { sinAsignar++; return; }
    conteos[t.asignadoA] = (conteos[t.asignadoA] || 0) + 1;
  });
  const filas = cache.usuarios
    .map(u => ({ id: u.id, label: `${u.nombre} ${u.apellido}`, count: conteos[u.id] || 0 }))
    .filter(f => f.count > 0)
    .sort((a, b) => b.count - a.count);
  if (sinAsignar > 0) filas.push({ id: 'sin-asignar', label: 'Sin asignar', count: sinAsignar, alerta: true });
  return filas;
}
function renderCargaTrabajo() {
  const filas = cargaTrabajoPorAgente();
  if (!filas.length) return '';
  const chips = filas.map(f => `<button type="button" class="carga-chip${f.alerta ? ' carga-chip-alerta' : ''}" onclick="setFilter('agente','${f.id}')" title="Ver los tickets de ${escapeHtml(f.label)}">${escapeHtml(f.label)}<span class="n">${f.count}</span></button>`).join('');
  return `<div class="carga-trabajo"><span class="carga-trabajo-label">Carga actual:</span>${chips}</div>`;
}

function renderDashboard() {
  const todos = filteredTickets();
  const totalPaginas = Math.max(1, Math.ceil(todos.length / TICKETS_POR_PAGINA));
  if (state.paginaTickets > totalPaginas) state.paginaTickets = totalPaginas;
  if (state.paginaTickets < 1) state.paginaTickets = 1;
  const desde = (state.paginaTickets - 1) * TICKETS_POR_PAGINA;
  const tickets = todos.slice(desde, desde + TICKETS_POR_PAGINA);

  const catOptions = ['todas', ...CAT.CATEGORIAS].map(c => `<option value="${c}" ${state.filters.categoria === c ? 'selected' : ''}>${c === 'todas' ? 'Todas las categorías' : c}</option>`).join('');
  const prioOptions = ['todas', ...CAT.PRIORIDADES].map(p => `<option value="${p}" ${state.filters.prioridad === p ? 'selected' : ''}>${p === 'todas' ? 'Toda prioridad' : p}</option>`).join('');
  const estOptions = ['todos', ...CAT.ESTADOS].map(e => `<option value="${e}" ${state.filters.estado === e ? 'selected' : ''}>${e === 'todos' ? 'Todo estado (sin cerrados ni resueltos)' : e}</option>`).join('');
  const grupoOptions = `<option value="todos">Todos los clientes</option>` + cache.clientes.map(g => `<option value="${g.id}" ${state.filters.grupo === g.id ? 'selected' : ''}>${escapeHtml(g.nombre)}</option>`).join('');
  const agenteOptions = `<option value="todos">Todo el equipo</option><option value="sin-asignar">Sin asignar</option>` + cache.usuarios.map(u => `<option value="${u.id}" ${state.filters.agente === u.id ? 'selected' : ''}>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</option>`).join('');
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t, false, true)).join('')}</div>` : `<div class="empty-state"><div class="big">No hay tickets que coincidan</div><div>Probá cambiar los filtros o simulá un correo entrante nuevo.</div></div>`;

  const paginacion = todos.length > TICKETS_POR_PAGINA ? `
    <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:18px;">
      <button class="btn btn-ghost" ${state.paginaTickets <= 1 ? 'disabled' : ''} onclick="irAPagina(${state.paginaTickets - 1})">&larr; Anterior</button>
      <span style="font-size:13.5px;color:var(--ink-soft);">Página ${state.paginaTickets} de ${totalPaginas}</span>
      <button class="btn btn-ghost" ${state.paginaTickets >= totalPaginas ? 'disabled' : ''} onclick="irAPagina(${state.paginaTickets + 1})">Siguiente &rarr;</button>
    </div>` : '';

  const u = currentUser();
  const vencidosCount = cache.tickets.filter(t => !esTicketDeReserva(t) && ticketVencido(t)).length;
  return `${dashboardStyleTag()}
    <div class="page-head"><div><h1>Bandeja de entrada general</h1><div class="sub">${todos.length} ticket${todos.length === 1 ? '' : 's'} visibles${state.filters.fecha ? ` · mostrando tickets del ${state.filters.fecha.split('-').reverse().join('/')}` : ''}${vencidosCount ? ` · <span class="badge-vencido">⏰ ${vencidosCount} vencido${vencidosCount === 1 ? '' : 's'}</span>` : ''}</div></div>
      <div style="display:flex;align-items:center;gap:12px;">
        <button class="btn btn-primary" onclick="openNuevoCorreoModal()">+ Simular correo entrante</button>
        <button type="button" class="dash-profile-chip" onclick="go('perfil')" title="Ir a mi perfil">
          <span class="dash-profile-avatar">${avatarInner(u)}</span>
          <span class="dash-profile-name">${escapeHtml(u.nombre)}</span>
        </button>
      </div></div>
    ${renderCargaTrabajo()}
    <div class="filters">
      <button class="btn ${state.filters.fecha === hoyStr() ? 'btn-primary' : 'btn-ghost'}" onclick="setFilter('fecha', hoyStr())">Tickets de hoy</button>
      <input type="date" value="${state.filters.fecha}" onchange="setFilter('fecha', this.value)" title="Buscar tickets de un día específico">
      ${state.filters.fecha ? `<button class="btn btn-ghost" onclick="setFilter('fecha','')">Ver todos los días</button>` : ''}
      <select onchange="setFilter('estado', this.value)">${estOptions}</select>
      <select onchange="setFilter('categoria', this.value)">${catOptions}</select>
      <select onchange="setFilter('prioridad', this.value)">${prioOptions}</select>
      <select onchange="setFilter('grupo', this.value)">${grupoOptions}</select>
      <select onchange="setFilter('agente', this.value)">${agenteOptions}</select>
      <input type="search" placeholder="Buscar y presioná Enter…" value="${escapeHtml(state.filters.search)}" onkeydown="if(event.key==='Enter'){ setFilter('search', this.value); }" onsearch="setFilter('search', this.value)">
    </div>
    ${state.selectedTickets.size ? renderBulkActionBar() : ''}
    ${list}
    ${paginacion}`;
}

/* ---------------- Ticket detail ---------------- */

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
function limpiarCuerpo(texto) {
  const sinCitas = recortarCitas(texto || '');
  return sinCitas.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function renderThreadHtml(t) {
  return t.mensajes.map(m => {
    if (m.tipo === 'nota') {
      return `<div class="msg msg-nota"><div class="msg-head"><span class="msg-autor">🔒 ${escapeHtml(m.autor)} <span class="auto-badge" style="background:var(--stamp-amber-tint);color:var(--stamp-amber);">Nota interna</span></span><span>${fmtDateTime(m.fecha)}</span></div>
        <div class="msg-body">${escapeHtml(limpiarCuerpo(m.cuerpo))}</div></div>`;
    }
    if (m.tipo === 'sistema') {
      return `<div class="msg msg-sistema"><div class="msg-head"><span class="msg-autor">&#9993; ${escapeHtml(m.autor)}</span><span>${fmtDateTime(m.fecha)}</span></div>
        <div class="msg-body">${escapeHtml(limpiarCuerpo(m.cuerpo))}</div>${m.destinatarios.length ? `<div class="msg-destinatarios">Enviado a: ${m.destinatarios.map(escapeHtml).join(', ')}</div>` : ''}</div>`;
    }
    return `<div class="msg msg-${m.tipo}"><div class="msg-head">
        <span class="msg-autor">${escapeHtml(m.autor)}${m.tipo === 'entrante' ? ' · ' + escapeHtml(t.remitenteEmail) : ''}${m.automatico ? ' <span class="auto-badge">&#9889; Automático</span>' : ''}</span>
        <span>${fmtDateTime(m.fecha)}</span></div>
      ${m.cc.length ? `<div class="msg-cc">CC: ${m.cc.map(escapeHtml).join(', ')}</div>` : ''}
      <div class="msg-body">${escapeHtml(limpiarCuerpo(m.cuerpo))}</div>
      ${m.cuerpoHtml ? `<iframe class="msg-html-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" srcdoc="${escapeHtml(m.cuerpoHtml)}"></iframe>` : ''}
      ${m.adjuntos.length ? renderAdjuntos(t.id, m.id, m.adjuntos) : ''}
      ${m.firmaHtml ? `<div class="msg-firma">${m.firmaHtml}</div>` : ''}</div>`;
  }).join('');
}
// Abre una foto de un mensaje (mail o portal) en grande, tapando la pantalla, en vez de descargarla
// directo — la mayoría de las veces solo hace falta mirarla. Si igual se necesita el archivo, abajo
// queda un botón de descarga aparte. Reutiliza la misma imagen que ya está cargada (mismo <img> src),
// así que no genera ningún pedido nuevo al servidor.
function ampliarImagenAdjunto(url, nombre) {
  const existente = document.getElementById('lightbox-imagen-adjunto');
  if (existente) existente.remove();
  const div = document.createElement('div');
  div.id = 'lightbox-imagen-adjunto';
  div.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,15,25,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;cursor:zoom-out;padding:24px;box-sizing:border-box;';
  div.innerHTML = `
    <img src="${url}" alt="${escapeHtml(nombre)}" style="max-width:100%;max-height:82vh;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.5);cursor:default;">
    <div style="display:flex;gap:10px;cursor:default;">
      <a href="${url}" download="${escapeHtml(nombre)}" class="btn btn-ghost" style="background:#fff;" onclick="event.stopPropagation();">⬇ Descargar</a>
      <button type="button" class="btn btn-ghost" style="background:#fff;" onclick="document.getElementById('lightbox-imagen-adjunto').remove();">✕ Cerrar</button>
    </div>`;
  div.onclick = () => div.remove();
  document.body.appendChild(div);
}
function renderAdjuntos(ticketId, mensajeId, adjuntos) {
  return `<div class="msg-attachments">${adjuntos.map(a => {
    const url = `/api/adjuntos/${ticketId}/${mensajeId}/${a.id}`;
    if (a.tipo === 'imagen') return `<img src="${url}" alt="${escapeHtml(a.nombre)}" class="adjunto-imagen-click" onclick="ampliarImagenAdjunto('${url}','${escapeHtml(a.nombre).replace(/'/g, "\\'")}')">`;
    if (a.tipo === 'video') return `<div class="attach-video-wrap">
        <video controls src="${url}" class="attach-video"></video>
        <a class="attach-file" href="${url}" download="${escapeHtml(a.nombre)}">⬇ Descargar ${escapeHtml(a.nombre)} <span style="opacity:.7;">(${fmtSize(a.size)})</span></a>
      </div>`;
    return `<a class="attach-file" href="${url}" download="${escapeHtml(a.nombre)}">${attachIcon(a.tipo)} ${escapeHtml(a.nombre)} <span style="opacity:.7;">(${fmtSize(a.size)})</span></a>`;
  }).join('')}</div>`;
}

// Estilos propios de la ficha de ticket: burbujas de mensaje estilo WhatsApp (con "colita") y
// caja de respuesta con look más moderno (pestañas subrayadas, tipo Outlook nuevo).
function ticketStyleTag() {
  return `<style id="ticket-style-v2">
    .adjunto-imagen-click{cursor:zoom-in;}
    .thread{gap:10px !important;}
    .msg{border-radius:16px !important;box-shadow:0 1px 2px rgba(15,42,77,.06),0 4px 10px -6px rgba(15,42,77,.12) !important;position:relative;max-width:100%;}
    /* Evita que una URL larga sin espacios (frecuente en correos con imágenes embebidas) empuje
       el ancho de la burbuja y desborde la pantalla. */
    .msg-body{overflow-wrap:anywhere;word-break:break-word;}
    .msg-html-frame{max-width:100%;}
    .msg-entrante{border-top-left-radius:4px !important;}
    .msg-entrante::before{content:'';position:absolute;left:-7px;top:0;width:0;height:0;border:8px solid transparent;border-top-color:#fff;border-left:0;transform:rotate(-8deg);}
    .msg-saliente{border-top-right-radius:4px !important;}
    .msg-saliente::before{content:'';position:absolute;right:-7px;top:0;width:0;height:0;border:8px solid transparent;border-top-color:var(--brand);border-right:0;transform:rotate(8deg);}
    .msg-nota{border-radius:12px !important;}
    .msg-sistema{border-radius:12px !important;}

    .reply-box{border-radius:16px !important;box-shadow:0 1px 2px rgba(15,42,77,.05),0 10px 24px -14px rgba(15,42,77,.25) !important;}
    .reply-tabs{background:none !important;padding:0 !important;border-bottom:1px solid var(--line);border-radius:0 !important;width:100% !important;gap:18px !important;margin-bottom:18px !important;display:flex;}
    .reply-tab{background:none !important;border:none !important;padding:8px 2px 12px !important;font-size:13.5px;font-weight:600;color:var(--ink-soft);border-bottom:2px solid transparent !important;border-radius:0 !important;position:relative;top:1px;transition:color .15s ease,border-color .15s ease;box-shadow:none !important;}
    .reply-tab:hover{color:var(--brand);}
    .reply-tab.active{color:var(--brand) !important;border-bottom-color:var(--brand) !important;background:none !important;box-shadow:none !important;}
    .reply-box textarea{border-radius:12px !important;}
    .reply-box textarea:focus,.reply-box input:focus,.reply-box select:focus{outline:none;border-color:var(--brand-2);box-shadow:0 0 0 3px rgba(61,126,240,.15);}
    .reply-actions{display:flex;justify-content:flex-end;}

    /* Fila Categoría / Prioridad / Estado / Asignado a / Cliente — selects con más presencia:
       tarjeta redondeada, flecha propia, brillo al enfocar. */
    .meta-grid{gap:14px !important;}
    .meta-grid .field label{color:var(--brand) !important;font-size:11.5px !important;}
    .meta-grid .field select{appearance:none;-webkit-appearance:none;width:100%;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%231E56C7'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z' clip-rule='evenodd'/%3E%3C/svg%3E") no-repeat right 12px center/16px;border:1.5px solid var(--line-strong) !important;border-radius:10px !important;padding:10px 34px 10px 12px !important;font-weight:600;color:var(--ink);box-shadow:0 1px 2px rgba(15,42,77,.04);transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease;cursor:pointer;}
    .meta-grid .field select:hover{border-color:var(--brand-2) !important;transform:translateY(-1px);}
    .meta-grid .field select:focus{outline:none;border-color:var(--brand-2) !important;box-shadow:0 0 0 3px rgba(61,126,240,.18);}
    .meta-grid .field input[list]{width:100%;border:1.5px solid var(--line-strong) !important;border-radius:10px !important;padding:10px 12px !important;font-weight:600;color:var(--ink);box-shadow:0 1px 2px rgba(15,42,77,.04);transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease;box-sizing:border-box;}
    .meta-grid .field input[list]:hover{border-color:var(--brand-2) !important;transform:translateY(-1px);}
    .meta-grid .field input[list]:focus{outline:none;border-color:var(--brand-2) !important;box-shadow:0 0 0 3px rgba(61,126,240,.18);}

    /* Cuadro del número de ticket (arriba de la ficha) — antes era solo texto gris, ahora un
       "sello" a juego con el resto del diseño (mismo estilo que el número en la bandeja). */
    .ticket-num-big{display:inline-block;font-family:var(--font-mono) !important;font-size:13px !important;font-weight:700;letter-spacing:.03em;color:#fff !important;background:linear-gradient(160deg,#0F2A4D 0%,#1B3F73 100%);padding:6px 14px;border-radius:8px;box-shadow:0 4px 10px -4px rgba(15,42,77,.4);margin-bottom:6px;}
  </style>`;
}
function renderTicket(id) {
  const t = cache.tickets.find(x => x.id === id);
  if (!t) return `<button class="back-link" onclick="go('dashboard')">&larr; Volver</button><div class="empty-state">Cargando…</div>`;
  const catOptions = CAT.CATEGORIAS.map(c => `<option value="${c}" ${t.categoria === c ? 'selected' : ''}>${c}</option>`).join('');
  const prioOptions = CAT.PRIORIDADES.map(p => `<option value="${p}" ${t.prioridad === p ? 'selected' : ''}>${p}</option>`).join('');
  const estOptions = CAT.ESTADOS.map(e => `<option value="${e}" ${t.estado === e ? 'selected' : ''}>${e}</option>`).join('');
  const asignOptions = `<option value="">Sin asignar</option>` + cache.usuarios.map(u => `<option value="${u.id}" ${t.asignadoA === u.id ? 'selected' : ''}>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)} (${u.cargo})</option>`).join('');
  const grupoOptions = `<option value="">Sin cliente asignado</option>` + cache.clientes.map(g => `<option value="${g.id}" ${t.grupoId === g.id ? 'selected' : ''}>${escapeHtml(g.nombre)}</option>`).join('');
  const thread = renderThreadHtml(t);
  const lastMsg = t.mensajes[t.mensajes.length - 1];
  const uid_ = currentUser().id;
  const u = currentUser();
  return `${ticketStyleTag()}
    <button class="back-link" onclick="go('dashboard')">&larr; Volver a la bandeja general</button>
    <div class="ticket-head">
      <div class="ticket-head-top">
        <div><div class="ticket-num-big">${t.numero}</div><h1>${escapeHtml(t.asunto)}</h1>
          <div class="ticket-from">De ${escapeHtml(t.remitenteNombre)} · ${escapeHtml(t.remitenteEmail)} · creado ${fmtDateTime(t.creado)}</div>
          ${lastMsg ? `<div class="ticket-from">Última respuesta: <strong>${escapeHtml(lastMsg.autor)}</strong> · ${fmtDateTime(lastMsg.fecha)}</div>` : ''}</div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
          ${t.necesitaAtencion ? `<div class="stamp stamp-atencion">🔔 Respondió el cliente</div>` : ''}
          ${t.satisfaccion === 'si' ? `<div class="stamp stamp-resuelto">😊 Cliente conforme</div>` : ''}
          ${t.satisfaccion === 'no' ? `<div class="stamp stamp-atencion">😕 Cliente no conforme</div>` : ''}
          ${t.reservasPendientes > 0 ? `<div class="stamp stamp-resuelto">📅 ${t.reservasPendientes > 1 ? t.reservasPendientes + ' reservas agendadas' : 'Reserva agendada'}</div>` : ''}
          <div class="stamp stamp-${slug(t.estado)}">${t.estado}</div>
        </div>
      </div>
      <div class="ticket-actions-row" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;">
        ${t.asignadoA !== uid_ ? `<button type="button" class="btn btn-ghost" onclick="tomarTicket('${t.id}')">Tomar este ticket</button>` : ''}
        ${!esTicketDeReserva(t) ? `<button type="button" class="btn btn-ghost" onclick="openAgendarServicioModal('${t.id}')">📅 Agendar servicio técnico</button>` : ''}
        ${!esTicketDeReserva(t) ? `<button type="button" class="btn btn-ghost" onclick="irAPedidoDeTagDesdeTicket('${t.id}')">🏷️ Pedido de Tag</button>` : ''}
        <button type="button" class="btn btn-ghost" onclick="openFusionarTicketModal('${t.id}')">🔀 Fusionar con otro ticket</button>
        <button type="button" class="btn btn-danger" onclick="eliminarTicket('${t.id}')">Eliminar ticket</button>
      </div>
      <div class="meta-grid">
        <div class="field"><label>Categoría</label><select onchange="updateTicketField('${t.id}','categoria', this.value)">${catOptions}</select></div>
        <div class="field"><label>Prioridad</label><select onchange="updateTicketField('${t.id}','prioridad', this.value)">${prioOptions}</select></div>
        <div class="field"><label>Estado</label><select onchange="updateTicketField('${t.id}','estado', this.value)">${estOptions}</select></div>
        <div class="field"><label>Asignado a</label><select onchange="updateTicketField('${t.id}','asignadoA', this.value)">${asignOptions}</select></div>
        <div class="field"><label>Cliente</label><select onchange="updateTicketField('${t.id}','clienteId', this.value)">${grupoOptions}</select></div>
        <div class="field"><label>Apartamento</label><input value="${escapeHtml(t.edificio || '')}" placeholder="Ej: 01 SyNC" onchange="updateTicketField('${t.id}','edificio', this.value)"><div class="hint-text">Dato descriptivo (unidad/apto), no reemplaza al Cliente asignado arriba.</div></div>
      </div>
    </div>
    ${esTicketDeReserva(t) ? renderReservaCalendario(t) : ''}
    ${renderServiciosTecnicosDelTicket(t)}
    ${renderChecklistTicket(t)}
    ${renderHistorialClienteTicket(t)}
    ${renderAceptacionesTicket(t)}
    <div class="thread">${thread}</div>
    <div class="reply-box">
      <div class="reply-tabs">
        <button class="reply-tab ${state.replyTab === 'saliente' ? 'active' : ''}" onclick="setReplyTab('saliente')">Responder como agente</button>
        <button class="reply-tab ${state.replyTab === 'entrante' ? 'active' : ''}" onclick="setReplyTab('entrante')">Simular respuesta del solicitante</button>
        <button class="reply-tab ${state.replyTab === 'nota' ? 'active' : ''}" onclick="setReplyTab('nota')">🔒 Nota interna</button>
      </div>
      <form onsubmit="return submitReply(event, '${t.id}')">
        ${state.replyTab === 'saliente' && cache.respuestas.length ? `
        <div class="field"><label>Respuesta predefinida</label><select onchange="insertCanned(this)"><option value="">Elegir una respuesta…</option>${cache.respuestas.map(r => `<option value="${r.id}">${escapeHtml(r.titulo)}</option>`).join('')}</select></div>` : ''}
        ${state.replyTab === 'nota' ? `<div class="hint-text" style="margin-bottom:10px;">Esta nota es solo para uso interno del equipo. El cliente nunca la ve, ni en el portal ni por correo.</div>` : ''}
        <div class="field" style="margin-bottom:0;"><textarea name="cuerpo" placeholder="${state.replyTab === 'saliente' ? 'Escribí tu respuesta…' : state.replyTab === 'nota' ? 'Escribí la nota interna…' : 'Escribí el correo que llegaría del solicitante…'}" required></textarea></div>
        ${state.replyTab === 'saliente' && u.firma_html ? `<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" name="incluirFirma" checked> Incluir mi firma</label>` : ''}
        ${state.replyTab === 'saliente' ? `
        <div class="field" style="margin-top:12px;"><label>CC (copia a)</label><input name="cc" type="text" value="${escapeHtml(ccSugeridoParaTicket(t))}" placeholder="otro-correo@ejemplo.com, otro2@ejemplo.com"><div class="hint-text">Se completa solo con quienes estuvieron en copia en este ticket. Podés editarlo antes de enviar.</div></div>
        <div class="field"><label>Adjuntar archivos</label><input type="file" multiple accept="image/*,video/*,application/pdf" onchange="addPendingAttachments(this)"><div class="hint-text">Imágenes, PDF o video, máx. 20 MB.</div><div id="pending-attachments">${renderPendingChips()}</div></div>
        ${cache.documentosLegales.filter(d => d.activo).length ? `
        <div class="field"><label>Pedir aceptación de un documento (opcional)</label><select name="documentoLegalId"><option value="">Ninguno</option>${cache.documentosLegales.filter(d => d.activo).map(d => `<option value="${d.id}">${escapeHtml(d.nombre)}</option>`).join('')}</select><div class="hint-text">Se le agrega al cliente un enlace para leer y aceptar ese documento, con registro de fecha, hora e IP.</div></div>` : ''}` : ''}
        <div class="reply-actions"><button type="submit" class="btn btn-primary">${state.replyTab === 'saliente' ? 'Enviar respuesta' : state.replyTab === 'nota' ? 'Guardar nota interna' : 'Simular correo entrante'}</button></div>
      </form>
    </div>`;
}

/* ---------------- Clientes ---------------- */

function renderGrupoRow(g) {
  return `
    <div class="stub" role="button" tabindex="0" style="align-items:stretch;" onclick="openGrupoDetail('${g.id}')" onkeydown="if(event.key==='Enter'){openGrupoDetail('${g.id}')}">
      <div class="stub-num" style="width:64px;"><div class="n" style="font-size:18px;">${g.tienePortal ? '🔐' : '—'}</div><div class="y">portal</div></div>
      <div class="stub-body"><div class="stub-top"><div class="stub-asunto">${escapeHtml(g.nombre)}</div></div>
        <div class="stub-remitente">${[g.telefono, g.correo].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        ${g.direccion ? `<div class="stub-snippet">${escapeHtml(g.direccion)}</div>` : ''}
        ${g.rolCliente || g.administradoPorNombre ? `<div class="stub-meta">${g.rolCliente ? `<span class="tag tag-cliente">${escapeHtml(g.rolCliente)}</span>` : ''}${g.administradoPorNombre ? `<span class="tag">Administrado por ${escapeHtml(g.administradoPorNombre)}</span>` : ''}</div>` : ''}
      </div>
      <button type="button" class="btn btn-danger" style="flex:none;align-self:center;" onclick="event.stopPropagation();deleteGrupo('${g.id}')">Eliminar</button>
    </div>`;
}
// Clientes separados en Edificios / Administraciones / Otros, porque hoy conviven dos niveles de
// agrupamiento (Administración → Edificios que gestiona, y Edificio → Apartamentos que lo integran)
// usando el mismo campo "administrado por"; separarlos en pestañas evita que una lista larga mezcle
// edificios, administraciones y apartamentos sin distinción.
function renderGrupos() {
  const tab = state.clientesTab || 'edificios';
  const edificios = cache.clientes.filter(c => c.rolCliente === 'Edificio');
  const administraciones = cache.clientes.filter(c => c.rolCliente === 'Administración');
  const apartamentosSueltos = cache.clientes.filter(c => c.rolCliente === 'Apartamento' && !c.administradoPorId);
  const otros = cache.clientes.filter(c => !['Edificio', 'Administración'].includes(c.rolCliente) && !(c.rolCliente === 'Apartamento' && c.administradoPorId));
  const tabsHtml = [
    { v: 'edificios', label: `🏢 Edificios (${edificios.length})` },
    { v: 'administraciones', label: `🗂️ Administraciones (${administraciones.length})` },
    { v: 'otros', label: `Otros clientes (${otros.length})` }
  ].map(t => `<button class="reply-tab ${tab === t.v ? 'active' : ''}" type="button" onclick="state.clientesTab='${t.v}'; render();">${t.label}</button>`).join('');
  const grupo = tab === 'edificios' ? edificios : tab === 'administraciones' ? administraciones : otros;
  const mensajeVacio = tab === 'edificios' ? 'Todavía no diste de alta ningún edificio.' : tab === 'administraciones' ? 'Todavía no diste de alta ninguna administración.' : 'No hay otros clientes cargados.';
  const list = grupo.length ? `<div class="stub-list">${grupo.map(renderGrupoRow).join('')}</div>` : `<div class="empty-state"><div class="big">${mensajeVacio}</div></div>`;
  const avisoApartamentosSueltos = tab === 'otros' && apartamentosSueltos.length
    ? `<div class="hint-text" style="margin-bottom:10px;">Hay ${apartamentosSueltos.length} apartamento${apartamentosSueltos.length === 1 ? '' : 's'} sin edificio asignado (rol "Apartamento" sin "Administrado por"); quedan listados acá abajo, en Otros.</div>` : '';
  return `<div class="page-head"><div><h1>Clientes</h1><div class="sub">Edificios con sus apartamentos, administraciones con los edificios que gestionan, y el resto de los clientes.</div></div><button class="btn btn-primary" onclick="openNuevoGrupoModal()">+ Nuevo cliente</button></div>
    <div class="reply-tabs" style="margin-bottom:14px;">${tabsHtml}</div>
    ${avisoApartamentosSueltos}${list}`;
}

async function renderGrupoDetailAsync(id) {
  const g = cache.clientes.find(x => x.id === id);
  if (!g) return `<div class="empty-state">Cliente no encontrado.</div>`;
  const tickets = await loadClienteDetalleTickets(id);
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t)).join('')}</div>` : `<div class="empty-state"><div class="big">Este cliente todavía no tiene tickets</div></div>`;
  // Proveedores y Servicios: por ahora solo lo cargan/ven cuentas Administración, para los edificios
  // que ellas mismas administran.
  if (g.rolCliente === 'Administración') { cache.proveedores = await api('GET', '/api/proveedores'); }
  const serviciosTecnicosCliente = await api('GET', `/api/clientes/${id}/servicios-tecnicos`).catch(() => []);
  const contratoMantenimiento = g.esMantenimiento ? await api('GET', `/api/clientes/${id}/contrato-mantenimiento`).catch(() => null) : null;
  return `${ticketStyleTag()}
    <button class="back-link" onclick="go('grupos')">&larr; Volver a clientes</button>
    <div class="ticket-head">
      <div class="ticket-head-top"><div><div class="ticket-num-big">CLIENTE</div><h1>${escapeHtml(g.nombre)}</h1>
        <div class="ticket-from">${[g.direccion, g.telefono, g.correo].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        <div class="ticket-from">Portal de cliente: ${g.tienePortal ? `<strong style="color:var(--stamp-green);">habilitado</strong>` : '<strong style="color:var(--gray);">sin configurar</strong>'}</div>
        ${g.administradoPorNombre ? `<div class="ticket-from">Administrado por: <strong>${escapeHtml(g.administradoPorNombre)}</strong></div>` : ''}
      </div>
        ${g.rolCliente ? `<div class="stamp stamp-abierto">${escapeHtml(g.rolCliente)}</div>` : ''}</div>
      <div style="display:flex;gap:8px;margin-top:16px;padding-top:16px;border-top:1px dashed var(--line-strong);">
        <button class="btn btn-ghost" onclick="openEditarGrupoModal('${g.id}')">Editar cliente</button>
        <button class="btn btn-danger" onclick="deleteGrupo('${g.id}')">Eliminar</button></div>
    </div>
    ${renderDependientesGrupo(g)}
    ${g.rolCliente === 'Administración' ? renderProveedoresGrupo(g) : ''}
    ${g.esMantenimiento ? renderContratoMantenimientoGrupo(g, contratoMantenimiento) : ''}
    ${renderHistorialServiciosTecnicosCliente(serviciosTecnicosCliente)}
    <div class="page-head"><div><h1 style="font-size:18px;">Tickets de este cliente</h1><div class="sub">${tickets.length} en total</div></div></div>
    ${list}`;
}
// Historial de servicios técnicos hechos a este cliente/edificio a lo largo del tiempo, con su
// comprobante si ya se generó uno — para responder rápido "¿cuántas veces vinieron?".
function renderHistorialServiciosTecnicosCliente(servicios) {
  if (!servicios || !servicios.length) return '';
  return `<div class="page-head"><div><h1 style="font-size:18px;">🛠️ Servicios técnicos</h1><div class="sub">${servicios.length} en total</div></div></div>
    <div class="stub-list" style="margin-bottom:18px;">${servicios.map(s => `
      <div class="user-row" style="border:1px solid var(--line);cursor:pointer;" onclick="verDetalleServicioTecnicoDesdeTicket('${s.id}')">
        <div class="avatar">${s.estado === 'realizado' ? '✅' : s.estado === 'en_curso' ? '🚗' : '🕒'}</div>
        <div style="flex:1;"><div class="u-name">${escapeHtml(s.titulo)}</div>
          <div class="u-sub">${s.todo_el_dia ? new Date(s.fecha_hora).toLocaleDateString('es-UY', { timeZone: 'America/Montevideo' }) : new Date(s.fecha_hora).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' })}${s.comprobante_numero ? ' · Comprobante ' + escapeHtml(s.comprobante_numero) : ''}</div></div>
        <span class="stamp stamp-${s.estado === 'realizado' ? 'resuelto' : s.estado === 'en_curso' ? 'en-progreso' : 'abierto'}">${s.estado === 'realizado' ? 'Realizado' : s.estado === 'en_curso' ? 'En curso' : 'Pendiente'}</span>
      </div>`).join('')}</div>`;
}
// Si este cliente es un "padre" (Administración o Edificio), lista a los clientes que tiene a cargo
// (edificios o apartamentos, según el caso) para poder entrar a cada uno con un clic.
function renderDependientesGrupo(g) {
  const dependientes = cache.clientes.filter(c => c.administradoPorId === g.id);
  if (!dependientes.length) return '';
  const titulo = g.rolCliente === 'Administración' ? 'Edificios que administra' : g.rolCliente === 'Edificio' ? 'Apartamentos' : 'Clientes a cargo';
  return `<div class="page-head"><div><h1 style="font-size:18px;">${titulo}</h1><div class="sub">${dependientes.length} en total</div></div></div>
    <div class="stub-list">${dependientes.map(renderGrupoRow).join('')}</div>`;
}
// Empresas de mantenimiento cargadas para los edificios que administra esta Administración. Por
// ahora solo campos mínimos (nombre, edificio, teléfono, correo) — se va a ir ampliando.
function edificiosDeAdministracion(administracionId) {
  return cache.clientes.filter(c => c.administradoPorId === administracionId && c.rolCliente === 'Edificio');
}
function renderProveedoresGrupo(g) {
  const edificioIds = edificiosDeAdministracion(g.id).map(e => e.id);
  const proveedores = (cache.proveedores || []).filter(p => edificioIds.includes(p.edificio_cliente_id));
  const rows = proveedores.map(p => `
    <div class="user-row" style="border:1px solid var(--line);">
      <div class="avatar">🔧</div>
      <div style="flex:1;"><div class="u-name">${escapeHtml(p.nombre)}</div>
        <div class="u-sub">${escapeHtml(p.edificio_nombre)}${[p.telefono, p.correo].filter(Boolean).length ? ' · ' + [p.telefono, p.correo].filter(Boolean).map(escapeHtml).join(' · ') : ''}</div></div>
      <button type="button" class="btn btn-danger" onclick="borrarProveedor('${p.id}', '${g.id}')">Eliminar</button>
    </div>`).join('');
  return `<div class="page-head"><div><h1 style="font-size:18px;">🔧 Proveedores y Servicios</h1><div class="sub">Empresas de mantenimiento por edificio</div></div>
      ${edificioIds.length ? `<button type="button" class="btn btn-ghost" onclick="openNuevoProveedorModal('${g.id}')">+ Nuevo proveedor</button>` : ''}</div>
    ${!edificioIds.length ? `<div class="hint-text" style="margin-bottom:14px;">Esta administración todavía no tiene edificios a cargo; asignale al menos uno antes de cargar proveedores.</div>` : ''}
    ${proveedores.length ? rows : (edificioIds.length ? `<div class="hint-text" style="margin-bottom:14px;">Todavía no hay proveedores cargados.</div>` : '')}`;
}
/* ---------------- Contrato de mantenimiento (clientes marcados "Cliente de mantenimiento") ----------------
   Un solo contrato por cliente, que cubre uno o varios sistemas (CCTV, Portería, Redes, Control de
   acceso, Sistema de Incendio, u otro que se agregue a mano). El cobro es mensual y aparte — acá solo
   se agenda: cuando falten 7 días para la "próxima visita", el sistema genera solo el turno de
   Servicio Técnico correspondiente (sin ticket ni costos) y calcula la siguiente fecha. */
const SISTEMAS_MANTENIMIENTO_BASE = ['CCTV', 'Portería', 'Redes', 'Control de acceso', 'Sistema de Incendio'];
const FRECUENCIAS_MANTENIMIENTO = [{ v: 1, label: 'Mensual' }, { v: 2, label: 'Bimestral' }, { v: 3, label: 'Trimestral' }, { v: 4, label: 'Cuatrimestral' }];
function frecuenciaMantenimientoLabel(meses) {
  const f = FRECUENCIAS_MANTENIMIENTO.find(x => x.v === Number(meses));
  return f ? f.label : `Cada ${meses} meses`;
}
function renderContratoMantenimientoGrupo(g, contrato) {
  return `<div class="page-head"><div><h1 style="font-size:18px;">🔧 Contrato de mantenimiento</h1><div class="sub">${contrato ? (contrato.activo ? 'Activo' : 'Pausado') : 'Todavía no configurado'}</div></div>
      <button type="button" class="btn btn-ghost" onclick="openContratoMantenimientoModal('${g.id}')">${contrato ? 'Editar contrato' : '+ Configurar contrato'}</button></div>
    ${contrato ? `
    <div class="user-row" style="border:1px solid var(--line);align-items:flex-start;">
      <div class="avatar">🔧</div>
      <div style="flex:1;">
        <div class="u-name">${(contrato.sistemas || []).map(s => `<span class="tag" style="margin-right:6px;">${escapeHtml(s)}</span>`).join('')}</div>
        <div class="u-sub" style="margin-top:6px;">Frecuencia: ${frecuenciaMantenimientoLabel(contrato.frecuencia_meses)} · Próxima visita: ${new Date(contrato.proxima_fecha + 'T00:00:00-03:00').toLocaleDateString('es-UY', { timeZone: 'America/Montevideo' })}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${contrato.activo
          ? `<button type="button" class="btn btn-ghost" onclick="pausarContratoMantenimiento('${contrato.id}')">Pausar</button>`
          : `<button type="button" class="btn btn-ghost" onclick="reactivarContratoMantenimiento('${contrato.id}')">Reactivar</button>`}
        <button type="button" class="btn btn-danger" onclick="eliminarContratoMantenimiento('${contrato.id}')">Eliminar</button>
      </div>
    </div>` : `<div class="hint-text" style="margin-bottom:14px;">Este cliente está marcado como "Cliente de mantenimiento" pero todavía no tiene un contrato configurado.</div>`}`;
}
async function openContratoMantenimientoModal(clienteId) {
  state.contratoMantenimientoClienteId = clienteId;
  cache.contratoMantenimientoEdit = await api('GET', `/api/clientes/${clienteId}/contrato-mantenimiento`).catch(() => null);
  state.modal = 'contrato-mantenimiento';
  render();
}
async function submitContratoMantenimiento(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const sistemas = fd.getAll('sistemas').map(s => (s || '').trim()).filter(Boolean);
  const otro = (fd.get('sistemaOtro') || '').trim();
  if (otro) sistemas.push(...otro.split(',').map(s => s.trim()).filter(Boolean));
  if (!sistemas.length) { showToast('Elegí al menos un sistema.'); return false; }
  const payload = { sistemas, frecuenciaMeses: Number(fd.get('frecuenciaMeses')), proximaFecha: fd.get('proximaFecha') };
  try {
    await api('POST', `/api/clientes/${state.contratoMantenimientoClienteId}/contrato-mantenimiento`, payload);
    state.modal = null;
    render();
  } catch (e) { showToast(e.message); }
  return false;
}
async function pausarContratoMantenimiento(id) {
  try { await api('POST', `/api/contratos-mantenimiento/${id}/pausar`); render(); } catch (e) { showToast(e.message); }
}
async function reactivarContratoMantenimiento(id) {
  try { await api('POST', `/api/contratos-mantenimiento/${id}/reactivar`); render(); } catch (e) { showToast(e.message); }
}
async function eliminarContratoMantenimiento(id) {
  if (!confirm('¿Eliminar este contrato de mantenimiento? No se puede deshacer.')) return;
  try { await api('DELETE', `/api/contratos-mantenimiento/${id}`); render(); } catch (e) { showToast(e.message); }
}
function renderContratoMantenimientoModal() {
  const contrato = cache.contratoMantenimientoEdit;
  const sistemasActuales = contrato ? (contrato.sistemas || []) : [];
  const sistemasExtra = sistemasActuales.filter(s => !SISTEMAS_MANTENIMIENTO_BASE.includes(s));
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>${contrato ? 'Editar contrato de mantenimiento' : 'Configurar contrato de mantenimiento'}</h2>
    <form onsubmit="return submitContratoMantenimiento(event)">
      <div class="field"><label>Sistemas que cubre</label>
        ${SISTEMAS_MANTENIMIENTO_BASE.map(s => `<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:6px;"><input type="checkbox" name="sistemas" value="${s}" ${sistemasActuales.includes(s) ? 'checked' : ''}> ${s}</label>`).join('')}
        <input name="sistemaOtro" placeholder="Otro sistema (opcional)" value="${escapeHtml(sistemasExtra.join(', '))}">
        <div class="hint-text">Si hay más de uno, separalos con coma.</div></div>
      <div class="field"><label>Frecuencia de visitas</label>
        <select name="frecuenciaMeses">${FRECUENCIAS_MANTENIMIENTO.map(f => `<option value="${f.v}" ${contrato && Number(contrato.frecuencia_meses) === f.v ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>
      <div class="field"><label>Próxima visita</label><input type="date" name="proximaFecha" value="${contrato ? contrato.proxima_fecha : ''}" required></div>
      <div class="hint-text">El sistema va a generar solo el turno de Servicio Técnico 7 días antes de esta fecha, y va a calcular la siguiente sumando la frecuencia — sin crear ticket ni costos.</div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">Guardar contrato</button></div>
    </form></div></div>`;
}
function openNuevoProveedorModal(administracionId) {
  state.modal = 'nuevo-proveedor';
  state.proveedorAdministracionId = administracionId;
  render();
}
function renderNuevoProveedorModal() {
  const administracionId = state.proveedorAdministracionId;
  const edificios = edificiosDeAdministracion(administracionId);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>+ Nuevo proveedor</h2>
    <form onsubmit="return submitNuevoProveedor(event)">
      <div class="field"><label>Nombre de la empresa</label><input name="nombre" placeholder="Ej: Ascensores XYZ" required></div>
      <div class="field"><label>Edificio</label><select name="edificioClienteId" required><option value="" disabled selected>Elegí el edificio</option>${edificios.map(e => `<option value="${e.id}">${escapeHtml(e.nombre)}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field"><label>Teléfono</label><input name="telefono"></div>
        <div class="field"><label>Correo</label><input name="correo" type="email"></div>
      </div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">Crear proveedor</button></div>
    </form></div></div>`;
}
async function submitNuevoProveedor(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const administracionId = state.proveedorAdministracionId;
  try {
    await api('POST', '/api/proveedores', {
      nombre: fd.get('nombre').trim(), edificioClienteId: fd.get('edificioClienteId'),
      telefono: fd.get('telefono').trim(), correo: fd.get('correo').trim()
    });
    cache.proveedores = await api('GET', '/api/proveedores');
    closeModal();
    state.view = 'grupo'; state.grupoId = administracionId;
    showToast('Proveedor creado.');
    render();
  } catch (e) { showToast(e.message); }
  return false;
}
async function borrarProveedor(id, administracionId) {
  if (!confirm('¿Eliminar este proveedor?')) return;
  try {
    await api('DELETE', `/api/proveedores/${id}`);
    cache.proveedores = (cache.proveedores || []).filter(p => String(p.id) !== String(id));
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Respuestas / Automatizaciones / Usuarios / Perfil / Config ---------------- */

function renderRespuestas() {
  const rows = cache.respuestas.map(c => `
    <div class="card" style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;"><div style="font-weight:600;font-size:14.5px;margin-bottom:4px;">${escapeHtml(c.titulo)}</div>
      <div style="font-size:13px;color:var(--ink-soft);white-space:pre-wrap;">${escapeHtml(c.cuerpo)}</div></div>
      <div style="display:flex;gap:8px;flex:none;"><button class="btn btn-ghost" onclick="openEditarRespuestaModal('${c.id}')">Editar</button><button class="btn btn-danger" onclick="deleteRespuesta('${c.id}')">Eliminar</button></div>
    </div></div>`).join('');
  const list = cache.respuestas.length ? rows : `<div class="empty-state"><div class="big">Todavía no hay respuestas predefinidas</div></div>`;
  return `<div class="page-head"><div><h1>Respuestas predefinidas</h1><div class="sub">Plantillas listas para usar al responder tickets</div></div><button class="btn btn-primary" onclick="openNuevaRespuestaModal()">+ Nueva respuesta</button></div>${list}`;
}

function renderPasosEditor() {
  const estadoOpts = sel => ['Sin cambio', ...CAT.ESTADOS].map(e => `<option value="${e}" ${sel === e ? 'selected' : ''}>${e}</option>`).join('');
  const respOpts = sel => cache.respuestas.map(r => `<option value="${r.id}" ${sel === r.id ? 'selected' : ''}>${escapeHtml(r.titulo)}</option>`).join('');
  return state.editandoPasos.map((p, idx) => `
    <div class="paso-row" data-paso-id="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:13px;">Paso ${idx + 1}${idx === 0 ? ' · primer disparador' : ' · en base a la respuesta anterior'}</strong>
        ${state.editandoPasos.length > 1 ? `<button type="button" class="btn btn-ghost" style="padding:4px 9px;font-size:12px;" onclick="quitarPasoEditor('${p.id}')">Quitar</button>` : ''}
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;"><input type="checkbox" data-field="matchAny" ${p.matchAny ? 'checked' : ''} onchange="onPasoMatchAnyChange('${p.id}', this.checked)"> Se dispara con cualquier respuesta del cliente</label>
      <div class="field" data-field-wrap="palabras" style="${p.matchAny ? 'display:none;' : ''}"><label>Palabras clave</label><input type="text" data-field="palabras" value="${escapeHtml(p.palabras)}" placeholder="tag, llave, sticker vehicular"></div>
      ${idx === 0 ? `<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;background:var(--brand-tint);padding:8px 10px;border-radius:6px;">
        <input type="checkbox" data-field="soloNuevoTicket" ${p.soloNuevoTicket ? 'checked' : ''}> Disparar solo al crear el ticket (no en respuestas posteriores)
      </label>` : ''}
      <div class="field"><label>Respuesta a enviar</label><select data-field="respuestaId">${respOpts(p.respuestaId)}</select></div>
      <div class="field" style="margin-bottom:0;"><label>Cambiar estado a</label><select data-field="accionEstado">${estadoOpts(p.accionEstado)}</select></div>
    </div>`).join('');
}

function renderAutomatizaciones() {
  const rows = cache.automatizaciones.map(a => {
    const pasosHtml = a.pasos.map((p, idx) => {
      const resp = cache.respuestas.find(r => r.id === p.respuestaId);
      const disparador = p.soloNuevoTicket ? 'al crear el ticket (siempre)' : p.matchAny ? 'cualquier respuesta del cliente' : (p.palabras || []).join(', ');
      return `<div class="hint-text" style="margin-top:4px;"><strong>Paso ${idx + 1}:</strong> ${escapeHtml(disparador)} &rarr; ${resp ? escapeHtml(resp.titulo) : 'respuesta eliminada'}${p.accionEstado !== 'Sin cambio' ? ` · estado: <strong>${escapeHtml(p.accionEstado)}</strong>` : ''}</div>`;
    }).join('');
    return `<div class="card" style="margin-bottom:12px;opacity:${a.activo ? '1' : '.55'};"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-weight:600;font-size:14.5px;">${escapeHtml(a.nombre)}</span><span class="tag ${a.activo ? 'tag-resuelto' : 'tag-cerrado'}">${a.activo ? 'Activa' : 'Pausada'}</span>
        <span class="tag tag-cat">${a.pasos.length} paso${a.pasos.length === 1 ? '' : 's'}</span></div>${pasosHtml}</div>
      <div style="display:flex;gap:8px;flex:none;"><button class="btn btn-ghost" onclick="toggleAutomatizacion('${a.id}')">${a.activo ? 'Pausar' : 'Activar'}</button>
        <button class="btn btn-ghost" onclick="openEditarAutomatizacionModal('${a.id}')">Editar</button><button class="btn btn-danger" onclick="deleteAutomatizacion('${a.id}')">Eliminar</button></div>
    </div></div>`;
  }).join('');
  const list = cache.automatizaciones.length ? rows : `<div class="empty-state"><div class="big">Todavía no hay automatizaciones</div></div>`;
  return `<div class="page-head"><div><h1>Automatizaciones</h1><div class="sub">Cadenas de pasos que responden solas ante ciertas palabras</div></div><button class="btn btn-primary" onclick="openNuevaAutomatizacionModal()">+ Nueva automatización</button></div>${list}`;
}

function openNuevoUsuarioModal() {
  state.modal = 'nuevo-usuario';
  render();
}

async function submitNuevoUsuario(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const password = fd.get('password'), password2 = fd.get('password2');
  if (password !== password2) { showToast('Las contraseñas no coinciden.'); return false; }
  try {
    await api('POST', '/api/usuarios', {
      nombre: fd.get('nombre').trim(), apellido: fd.get('apellido').trim(), telefono: fd.get('telefono').trim(),
      email: fd.get('email').trim(), cargo: fd.get('cargo'), password, esSuperadmin: fd.get('esSuperadmin') === 'on'
    });
    cache.usuarios = await api('GET', '/api/usuarios');
    state.modal = null;
    showToast('Usuario creado.');
    render();
  } catch (e) { showToast(e.message); }
  return false;
}

function renderNuevoUsuarioModal() {
  const cargoOptions = CAT.CARGOS.map(c => `<option value="${c}">${c}</option>`).join('');
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>Nuevo usuario</h2>
    <p class="sub">Da de alta a alguien del equipo directamente, sin que tenga que registrarse.</p>
    <form onsubmit="return submitNuevoUsuario(event)">
      <div class="field-row">
        <div class="field"><label>Nombre</label><input name="nombre" required></div>
        <div class="field"><label>Apellido</label><input name="apellido" required></div>
      </div>
      <div class="field"><label>Teléfono</label><input name="telefono"></div>
      <div class="field"><label>Correo electrónico</label><input name="email" type="email" required></div>
      <div class="field"><label>Cargo</label><select name="cargo" required><option value="" disabled selected>Elegí un cargo</option>${cargoOptions}</select></div>
      <div class="field-row">
        <div class="field"><label>Contraseña</label><input name="password" type="password" required></div>
        <div class="field"><label>Repetir contraseña</label><input name="password2" type="password" required></div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:16px;">
        <input type="checkbox" name="esSuperadmin"> Es Superadmin (puede editar a otros usuarios)
      </label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button type="submit" class="btn btn-primary">Crear usuario</button>
      </div>
    </form>
  </div></div>`;
}

function openEditarUsuarioModal(id) {
  state.modal = 'editar-usuario';
  state.editUsuarioId = id;
  render();
}

async function submitEditarUsuario(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    await api('PUT', '/api/usuarios/' + state.editUsuarioId, {
      nombre: fd.get('nombre').trim(), apellido: fd.get('apellido').trim(), telefono: fd.get('telefono').trim(),
      cargo: fd.get('cargo'), esSuperadmin: fd.get('esSuperadmin') === 'on', password: fd.get('password').trim() || undefined
    });
    cache.usuarios = await api('GET', '/api/usuarios');
    state.modal = null;
    showToast('Usuario actualizado.');
    render();
  } catch (e) { showToast(e.message); }
  return false;
}

function renderEditarUsuarioModal() {
  const u = cache.usuarios.find(x => x.id === state.editUsuarioId);
  if (!u) return '';
  const cargoOptions = CAT.CARGOS.map(c => `<option value="${c}" ${u.cargo === c ? 'selected' : ''}>${c}</option>`).join('');
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>Editar usuario</h2>
    <p class="sub">${escapeHtml(u.email)} — solo un Superadmin puede modificar estos datos.</p>
    <form onsubmit="return submitEditarUsuario(event)">
      <div class="field-row">
        <div class="field"><label>Nombre</label><input name="nombre" value="${escapeHtml(u.nombre)}" required></div>
        <div class="field"><label>Apellido</label><input name="apellido" value="${escapeHtml(u.apellido)}" required></div>
      </div>
      <div class="field"><label>Teléfono</label><input name="telefono" value="${escapeHtml(u.telefono || '')}"></div>
      <div class="field"><label>Cargo</label><select name="cargo">${cargoOptions}</select></div>
      <div class="field"><label>Nueva contraseña (opcional)</label><input name="password" type="password" placeholder="Dejar en blanco para no cambiarla"></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:16px;">
        <input type="checkbox" name="esSuperadmin" ${u.es_superadmin ? 'checked' : ''}> Es Superadmin (puede editar a otros usuarios)
      </label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar cambios</button>
      </div>
    </form>
  </div></div>`;
}

function usuariosStyleTag() {
  return `<style id="usuarios-style-v1">
    .user-row{border-radius:14px !important;box-shadow:0 1px 2px rgba(15,42,77,.05),0 4px 12px -10px rgba(15,42,77,.15);transition:box-shadow .15s ease,transform .15s ease;}
    .user-row:hover{box-shadow:0 8px 20px -12px rgba(15,42,77,.22);transform:translateY(-1px);}
    .user-row .avatar{background:linear-gradient(135deg,var(--brand-2),#8B5CF6);color:#fff;overflow:hidden;box-shadow:0 2px 6px rgba(30,86,199,.35);}
    .user-row .avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;}
  </style>`;
}
function renderUsuarios() {
  const soyAdmin = currentUser().es_superadmin;
  const miId = currentUser().id;
  const rows = cache.usuarios.map(u => `<div class="user-row"><div class="avatar">${avatarInner(u)}</div>
    <div><div class="u-name">${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}${u.es_superadmin ? ' <span class="tag tag-esperando-al-cliente" style="margin-left:4px;">Superadmin</span>' : ''}</div>
    <div class="u-sub">${escapeHtml(u.email)}${u.telefono ? ' · ' + escapeHtml(u.telefono) : ''}</div></div>
    <span class="tag tag-cat cargo-pill">${escapeHtml(u.cargo)}</span>
    ${soyAdmin ? `<button class="btn btn-ghost" style="margin-left:10px;" onclick="openEditarUsuarioModal('${u.id}')">Editar</button>` : ''}
    ${soyAdmin && u.id !== miId ? `<button class="btn btn-danger" style="margin-left:6px;" onclick="eliminarUsuario('${u.id}')">Eliminar</button>` : ''}
    </div>`).join('');
  return `${usuariosStyleTag()}<div class="page-head"><div><h1>Usuarios</h1><div class="sub">${cache.usuarios.length} personas con acceso a la plataforma</div></div>
    ${soyAdmin ? `<button class="btn btn-primary" onclick="openNuevoUsuarioModal()">+ Nuevo usuario</button>` : ''}</div>
    <div class="user-list">${rows}</div>`;
}

async function eliminarUsuario(id) {
  const u = cache.usuarios.find(x => x.id === id);
  if (!confirm(`¿Eliminar a ${u ? u.nombre + ' ' + u.apellido : 'este usuario'}? Los tickets que tenía asignados quedarán sin asignar.`)) return;
  try {
    await api('DELETE', '/api/usuarios/' + id);
    cache.usuarios = cache.usuarios.filter(x => x.id !== id);
    showToast('Usuario eliminado.');
    render();
  } catch (e) { showToast(e.message); }
}

function perfilStyleTag() {
  return `<style id="perfil-style-v1">
    .perfil-hero{position:relative;overflow:hidden;border-radius:20px;padding:28px 26px;margin-bottom:22px;
      background:linear-gradient(135deg,#0F2A4D 0%,#1B3F73 55%,var(--brand-2) 100%);color:#fff;
      display:flex;align-items:center;gap:20px;box-shadow:0 16px 34px -16px rgba(15,42,77,.45);}
    .perfil-hero::before{content:'';position:absolute;top:-60px;right:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.16),transparent 70%);}
    .perfil-hero::after{content:'';position:absolute;bottom:-80px;left:20%;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(139,92,246,.25),transparent 70%);}
    .perfil-avatar{position:relative;z-index:1;flex:none;width:76px;height:76px;border-radius:50%;display:flex;align-items:center;justify-content:center;
      font-family:var(--font-display);font-weight:700;font-size:26px;color:#fff;background:linear-gradient(135deg,var(--brand-2),#8B5CF6);
      box-shadow:0 0 0 4px rgba(255,255,255,.18),0 10px 20px -6px rgba(0,0,0,.35);cursor:pointer;}
    .perfil-avatar-wrap{position:relative;z-index:1;flex:none;}
    .perfil-avatar-cam{position:absolute;bottom:-8px;right:-6px;width:28px;height:28px;border-radius:50%;background:#fff;color:var(--brand);z-index:2;
      display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 3px 8px rgba(0,0,0,.4);border:2.5px solid var(--ink);cursor:pointer;}
    .perfil-avatar-quitar{position:relative;z-index:1;display:block;margin-top:6px;font-size:11.5px;color:rgba(255,255,255,.75);text-decoration:underline;cursor:pointer;text-align:center;}
    .perfil-hero-info{position:relative;z-index:1;}
    .perfil-hero-info h1{margin:0 0 4px;font-family:var(--font-display);font-size:22px;}
    .perfil-hero-cargo{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.25);padding:4px 12px;border-radius:999px;font-size:12.5px;font-weight:600;margin-top:4px;}
    .perfil-hero-email{opacity:.8;font-size:13px;margin-top:6px;}

    .perfil-section-head{display:flex;align-items:center;gap:10px;margin-bottom:4px;}
    .perfil-section-icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;flex:none;
      background:var(--brand-tint);box-shadow:inset 0 0 0 1px var(--line);}
    .perfil-section-head h3{margin:0;font-family:var(--font-display);font-weight:600;font-size:15.5px;}

    .card-narrow{border-radius:16px !important;transition:box-shadow .15s ease;}
    .card-narrow:hover{box-shadow:0 10px 24px -14px rgba(15,42,77,.2);}
    #perfil-cargo{appearance:none;-webkit-appearance:none;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%231E56C7'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z' clip-rule='evenodd'/%3E%3C/svg%3E") no-repeat right 14px center/16px;padding-right:38px;}
  </style>`;
}
function renderPerfil() {
  const u = currentUser();
  const cargoOptions = CAT.CARGOS.map(c => `<option value="${c}" ${u.cargo === c ? 'selected' : ''}>${c}</option>`).join('');
  return `${perfilStyleTag()}
    <div class="perfil-hero">
      <div class="perfil-avatar-wrap">
        <div class="perfil-avatar" title="Cambiar foto" onclick="document.getElementById('perfil-foto-input').click()">${avatarInner(u)}</div>
        <div class="perfil-avatar-cam" title="Cambiar foto" onclick="document.getElementById('perfil-foto-input').click()">📷</div>
        <input type="file" id="perfil-foto-input" accept="image/*" style="display:none" onchange="subirFotoPerfil(this)">
        ${u.foto_path ? `<span class="perfil-avatar-quitar" onclick="quitarFotoPerfil()">Quitar foto</span>` : ''}
      </div>
      <div class="perfil-hero-info">
        <h1>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</h1>
        <div class="perfil-hero-cargo">💼 ${escapeHtml(u.cargo)}</div>
        <div class="perfil-hero-email">${escapeHtml(u.email)}</div>
      </div>
    </div>
    <div class="card card-narrow"><form onsubmit="return submitPerfil(event)">
      <div class="perfil-section-head"><div class="perfil-section-icon">👤</div><h3>Datos personales</h3></div>
      <div class="hint-text" style="margin-bottom:16px;">Se usan dentro de la plataforma y en tu firma de correo.</div>
      <div class="field-row"><div class="field"><label>Nombre</label><input name="nombre" value="${escapeHtml(u.nombre)}" required></div><div class="field"><label>Apellido</label><input name="apellido" value="${escapeHtml(u.apellido)}" required></div></div>
      <div class="field"><label>Teléfono</label><input name="telefono" value="${escapeHtml(u.telefono || '')}"></div>
      <div class="field"><label>Correo electrónico</label><input value="${escapeHtml(u.email)}" disabled></div>
      <div class="field"><label>Cargo</label><select id="perfil-cargo" name="cargo">${cargoOptions}</select></div>
      <div class="field"><label>Nueva contraseña (opcional)</label><input name="password" type="password" placeholder="Dejar en blanco para no cambiarla"></div>
      <button type="submit" class="btn btn-primary btn-block">Guardar cambios</button>
    </form></div>
    <div class="card card-narrow" style="margin-top:18px;">
      <div class="perfil-section-head"><div class="perfil-section-icon">✍️</div><h3>Firma</h3></div>
      <div class="hint-text" style="margin:4px 0 12px;">Se agrega automáticamente al responder tickets.</div>
      <div class="sign-toolbar">
        <button type="button" class="btn btn-ghost" onclick="signCmd('bold')"><b>N</b></button>
        <button type="button" class="btn btn-ghost" onclick="signCmd('italic')"><i>K</i></button>
        <button type="button" class="btn btn-ghost" onclick="signCmd('underline')"><u>S</u></button>
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('firma-img-input').click()">Insertar imagen</button>
        <input type="file" id="firma-img-input" accept="image/*" style="display:none" onchange="insertFirmaImage(this)">
        <button type="button" class="btn btn-ghost" onclick="clearFirma()">Vaciar</button>
      </div>
      <div id="firma-editor" class="sign-editor" contenteditable="true">${u.firma_html || ''}</div>
      <div class="reply-actions" style="margin-top:12px;"><button type="button" class="btn btn-primary" onclick="saveFirma()">Guardar firma</button></div>
    </div>
    <div class="card card-narrow" style="margin-top:18px;">
      <div class="perfil-section-head"><div class="perfil-section-icon">📨</div><h3>Telegram: recordatorios y respuestas</h3></div>
      ${u.telegram_chat_id ? `
        <div class="hint-text" style="margin:8px 0 12px;color:var(--stamp-green);font-weight:600;">✅ Tu Telegram ya está vinculado.</div>
        <div class="hint-text" style="margin-bottom:12px;">Recibís ahí, por privado, el aviso cuando tomás un ticket y los recordatorios de los que llevan varios días sin atender. Para responderle al cliente, simplemente mantené presionado ese aviso y elegí <strong>"Responder"</strong> — no hace falta escribir ningún número, el sistema reconoce a qué ticket corresponde por el mensaje que citaste. (Si preferís escribir el número a mano igual funciona: <strong>T-2026-0001 tu mensaje</strong>). Esa respuesta le llega al cliente exactamente igual que si la hubieras escrito desde la plataforma.</div>
        <button type="button" class="btn btn-ghost btn-block" onclick="desvincularTelegram()">Desvincular Telegram</button>
      ` : `
        <div class="hint-text" style="margin:8px 0 12px;">Vinculá tu Telegram para recibir avisos privados de tickets sin atender, y para poder responder tickets directamente por Telegram sin necesidad de entrar a la plataforma.</div>
        <button type="button" class="btn btn-primary btn-block" onclick="generarCodigoTelegram()">Generar código para vincular</button>
        <div id="codigo-telegram" style="margin-top:10px;"></div>
      `}
    </div>`;
}

function configStyleTag() {
  return `<style id="config-style-v1">
    .config-section-head{display:flex;align-items:center;gap:10px;margin-bottom:4px;}
    .config-section-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex:none;
      background:var(--brand-tint);box-shadow:inset 0 0 0 1px var(--line);}
    .config-section-head span.title{font-family:var(--font-display);font-weight:600;font-size:16.5px;}

    .card-narrow{border-radius:16px !important;box-shadow:0 1px 2px rgba(15,42,77,.05),0 4px 14px -10px rgba(15,42,77,.15) !important;transition:box-shadow .15s ease;}
    .card-narrow:hover{box-shadow:0 10px 26px -14px rgba(15,42,77,.22) !important;}

    /* Interruptores en vez de checkboxes planos, para las opciones de activar/desactivar. */
    .switch-row{display:flex;align-items:center;gap:10px;font-size:13.5px;margin-bottom:10px;cursor:pointer;}
    .switch-row input[type=checkbox]{appearance:none;-webkit-appearance:none;width:38px;height:22px;border-radius:999px;background:var(--line-strong);position:relative;flex:none;cursor:pointer;transition:background .15s ease;outline:none;}
    .switch-row input[type=checkbox]::before{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease;}
    .switch-row input[type=checkbox]:checked{background:linear-gradient(135deg,var(--brand),var(--brand-2));}
    .switch-row input[type=checkbox]:checked::before{transform:translateX(16px);}

    .card-peligro{border:1.5px solid var(--stamp-red-tint) !important;background:linear-gradient(180deg,var(--card) 0%,var(--stamp-red-tint) 250%);}
    :root[data-theme="dark"] .card-peligro .config-section-head *{color:var(--ink) !important;}
    :root[data-theme="dark"] .card-peligro .hint-text{color:var(--ink-soft) !important;}
  </style>`;
}
function configSectionHead(icon, title, hint) {
  return `<div class="config-section-head">
      <div class="config-section-icon">${icon}</div>
      <span class="title">${title}</span>
    </div>
    ${hint ? `<div class="hint-text" style="margin:8px 0 16px;">${hint}</div>` : '<div style="margin-bottom:12px;"></div>'}`;
}

function renderConfigTabs() {
  const tabs = [
    { v: 'correo', label: '📧 Correo' },
    { v: 'telegram', label: '✈️ Telegram' },
    { v: 'notificaciones', label: '🔔 Notificaciones al cliente' },
    { v: 'respaldo', label: '💾 Respaldo' },
    { v: 'checklists', label: '✅ Checklists' },
  ];
  if (currentUser().es_superadmin) tabs.push({ v: 'peligro', label: '⚠️ Zona de peligro' });
  const activa = state.configTab || 'correo';
  return `<div class="reply-tabs" style="flex-wrap:wrap;width:auto;">
    ${tabs.map(t => `<button type="button" class="reply-tab ${activa === t.v ? 'active' : ''}" onclick="setConfigTab('${t.v}')">${t.label}</button>`).join('')}
  </div>`;
}
function setConfigTab(v) { state.configTab = v; render(); }

/* ---------------- Newsletter ---------------- */

function renderNewsletterChips() {
  if (!state.newsletterDestinatarios.length) return '<div class="hint-text">Todavía no agregaste destinatarios.</div>';
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;">${state.newsletterDestinatarios.map(d => `
    <span class="tag tag-cat" style="gap:6px;padding:6px 10px;">${d.esCliente ? '&#128100; ' : ''}${escapeHtml(d.nombre ? d.nombre + ' — ' : '')}${escapeHtml(d.email)}
    <button type="button" onclick="removerDestinatarioNewsletter('${d.email.replace(/'/g, "\\'")}')" style="border:none;background:none;cursor:pointer;color:var(--stamp-red);font-weight:700;padding:0 0 0 4px;">&times;</button></span>`).join('')}</div>`;
}
function refreshNewsletterChips() {
  const el = document.getElementById('newsletter-destinatarios');
  if (el) el.innerHTML = renderNewsletterChips();
}
function agregarDestinatarioNewsletter(inputEl) {
  const raw = (inputEl.value || '').trim().toLowerCase();
  inputEl.value = '';
  if (!raw) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) { showToast('Ingresá un email válido.'); return; }
  if (state.newsletterDestinatarios.some(d => d.email === raw)) { showToast('Ese destinatario ya fue agregado.'); return; }
  const cliente = cache.clientes.find(g => (g.correo || '').trim().toLowerCase() === raw);
  state.newsletterDestinatarios.push({ email: raw, esCliente: !!cliente, nombre: cliente ? cliente.nombre : '' });
  refreshNewsletterChips();
}
function removerDestinatarioNewsletter(email) {
  state.newsletterDestinatarios = state.newsletterDestinatarios.filter(d => d.email !== email);
  refreshNewsletterChips();
}
function newsletterInputKeydown(ev) {
  if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); agregarDestinatarioNewsletter(ev.target); }
}
function renderNewsletterAdjuntosChips() {
  if (!state.newsletterAdjuntos.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">${state.newsletterAdjuntos.map(a => `
    <span class="tag tag-cat" style="gap:6px;padding:6px 10px;">${attachIcon(a.tipo)} ${escapeHtml(a.nombre)} <span style="opacity:.7;">(${fmtSize(a.size)})</span>
    <button type="button" onclick="removeNewsletterAttachment('${a.id}')" style="border:none;background:none;cursor:pointer;color:var(--stamp-red);font-weight:700;padding:0 0 0 4px;">&times;</button></span>`).join('')}</div>`;
}
function refreshNewsletterAdjuntos() {
  const el = document.getElementById('newsletter-adjuntos');
  if (el) el.innerHTML = renderNewsletterAdjuntosChips();
}
function addNewsletterAttachments(input) {
  Array.from(input.files || []).forEach(file => {
    if (file.size > ATTACH_MAX_BYTES) { showToast(`"${file.name}" pesa demasiado (máx. 20 MB).`); return; }
    const reader = new FileReader();
    reader.onload = () => {
      state.newsletterAdjuntos.push({ id: uid(), nombre: file.name, tipo: tipoAdjunto(file.type || ''), size: file.size, dataUrl: reader.result });
      refreshNewsletterAdjuntos();
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
}
function removeNewsletterAttachment(id) {
  state.newsletterAdjuntos = state.newsletterAdjuntos.filter(a => a.id !== id);
  refreshNewsletterAdjuntos();
}
async function enviarNewsletter() {
  const asunto = (document.getElementById('newsletter-asunto') || {}).value || '';
  const cuerpo = (document.getElementById('newsletter-cuerpo') || {}).value || '';
  if (!state.newsletterDestinatarios.length) { showToast('Agregá al menos un destinatario.'); return; }
  if (!asunto.trim()) { showToast('Falta el asunto.'); return; }
  if (!cuerpo.trim()) { showToast('Falta el mensaje.'); return; }
  const btn = document.getElementById('newsletter-enviar-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    const r = await api('POST', '/api/newsletter/enviar', {
      destinatarios: state.newsletterDestinatarios.map(d => ({ email: d.email })),
      asunto: asunto.trim(),
      cuerpo,
      adjuntos: state.newsletterAdjuntos.map(a => ({ nombre: a.nombre, dataUrl: a.dataUrl }))
    });
    showToast(`Enviado a ${r.enviados} de ${r.total} destinatarios.${r.errores && r.errores.length ? ' Errores: ' + r.errores.join(' | ') : ''}`);
    if (!r.errores || !r.errores.length) {
      state.newsletterDestinatarios = [];
      state.newsletterAdjuntos = [];
      render();
    }
  } catch (e) {
    showToast(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar newsletter'; }
  }
}
function renderNewsletter() {
  const opcionesClientes = cache.clientes.filter(g => g.correo).map(g => `<option value="${escapeHtml(g.correo)}">${escapeHtml(g.nombre)}</option>`).join('');
  return `<div class="page-head"><div><h1>Newsletter</h1><div class="sub">Enviá un correo a varios destinatarios a la vez, con texto e imágenes</div></div></div>
    <div class="card card-narrow" style="max-width:560px;">
      ${configSectionHead('📰', 'Destinatarios', 'Escribí un email y presioná Enter (o coma) para agregarlo. Si coincide con un cliente cargado, se marca automáticamente.')}
      <div class="field">
        <label>Agregar destinatario</label>
        <input type="text" list="newsletter-clientes-list" placeholder="nombre@correo.com" onkeydown="newsletterInputKeydown(event)">
        <datalist id="newsletter-clientes-list">${opcionesClientes}</datalist>
      </div>
      <div id="newsletter-destinatarios" style="margin-top:6px;">${renderNewsletterChips()}</div>
    </div>
    <div class="card card-narrow" style="max-width:560px;margin-top:16px;">
      ${configSectionHead('✉️', 'Mensaje', '')}
      <div class="field"><label>Asunto</label><input type="text" id="newsletter-asunto" placeholder="Asunto del correo"></div>
      <div class="field"><label>Mensaje</label><textarea id="newsletter-cuerpo" rows="8" placeholder="Escribí el mensaje..."></textarea></div>
      <div class="field">
        <label>Imágenes / adjuntos</label>
        <input type="file" multiple accept="image/*,application/pdf" onchange="addNewsletterAttachments(this)">
        <div class="hint-text">Imágenes o PDF, máx. 20 MB cada uno.</div>
        <div id="newsletter-adjuntos">${renderNewsletterAdjuntosChips()}</div>
      </div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
        <button type="button" id="newsletter-enviar-btn" class="btn btn-primary btn-block" onclick="enviarNewsletter()">Enviar newsletter</button>
      </div>
    </div>`;
}

/* ---------------- Tags de acceso (edificios / pedidos) ---------------- */
async function renderTagsAsync() {
  if (!state.tagsTab) state.tagsTab = 'nuevo';
  const [edificios, pedidos] = await Promise.all([
    api('GET', '/api/tags/edificios').catch(() => []),
    api('GET', '/api/tags/pedidos').catch(() => [])
  ]);
  cache.tagsEdificios = edificios; cache.tagsPedidos = pedidos;
  return renderTags();
}
function renderTags() {
  const tab = state.tagsTab || 'nuevo';
  const esSuper = currentUser().es_superadmin;
  const tabs = [
    { v: 'nuevo', label: 'Nuevo pedido' }, { v: 'pedidos', label: 'Pedidos pendientes' },
    { v: 'historial', label: 'Historial' },
  ];
  if (esSuper) tabs.push({ v: 'edificios', label: 'Edificios' });
  const tabsHtml = tabs.map(t => `<button class="reply-tab ${tab === t.v ? 'active' : ''}" type="button" onclick="cambiarTagsTab('${t.v}')">${t.label}</button>`).join('');
  let body = '';
  if (tab === 'nuevo') body = renderTagsNuevo();
  else if (tab === 'pedidos') body = renderTagsPedidos();
  else if (tab === 'historial') body = renderTagsHistorial();
  else if (tab === 'edificios') body = renderTagsEdificios();
  return `<div class="page-head"><div><h1>Tags</h1><div class="sub">Control de stock y entrega de tags de acceso por edificio</div></div></div>
    ${renderTagsAvisoStockBajo()}
    <div class="reply-tabs">${tabsHtml}</div>
    ${body}`;
}
const TAGS_STOCK_MINIMO = 10;
function renderTagsAvisoStockBajo() {
  const edificios = cache.tagsEdificios || [];
  const bajos = [];
  edificios.forEach(e => {
    if (e.restante_peatonal <= TAGS_STOCK_MINIMO) bajos.push(`${e.edificio} (peatonales: ${e.restante_peatonal})`);
    if (e.restante_vehicular <= TAGS_STOCK_MINIMO) bajos.push(`${e.edificio} (vehiculares: ${e.restante_vehicular})`);
  });
  if (!bajos.length) return '';
  // Se limita la altura del aviso (con scroll interno) para que la lista de edificios en 0 no estire
  // toda la página y empuje el menú lateral fuera de la pantalla cuando hay muchos casos a la vez.
  return `<div class="card card-narrow" style="max-width:100%;border-color:var(--stamp-red-tint);margin-bottom:14px;">
    <strong style="color:var(--stamp-red);">⚠️ Stock bajo de tags (${bajos.length})</strong>
    <div class="hint-text" style="margin-top:4px;max-height:90px;overflow-y:auto;">Quedan ${TAGS_STOCK_MINIMO} unidades o menos en: ${bajos.map(b => escapeHtml(b)).join(' · ')}.</div>
    <div class="hint-text" style="margin-top:4px;">Hay que cargar nuevos tags al lote.</div>
  </div>`;
}
function cambiarTagsTab(t) { state.tagsTab = t; render(); actualizarCostoTags(); }
const PRECIOS_TAGS_UYU = { peatonales: 250, vehiculares: 350 };
function actualizarCostoTags() {
  const tipoEl = document.getElementById('tags-tipo');
  const cantEl = document.getElementById('tags-cantidad');
  const costoEl = document.getElementById('tags-costo');
  if (!tipoEl || !cantEl || !costoEl) return;
  const precioUnitario = tipoEl.value.toLowerCase().startsWith('peat') ? PRECIOS_TAGS_UYU.peatonales : PRECIOS_TAGS_UYU.vehiculares;
  const cantidad = Number(cantEl.value) || 0;
  costoEl.value = (precioUnitario * cantidad).toFixed(2);
}
function renderTagsNuevo() {
  const edificios = cache.tagsEdificios || [];
  const precarga = state.tagsPrecarga || {};
  return `<div class="card card-narrow" style="max-width:560px;">
    ${configSectionHead('🏷️', 'Ingresar pedido', 'Al guardar se descuenta automáticamente del stock disponible de ese edificio.')}
    ${precarga.ticket ? `<div class="hint-text" style="margin-bottom:10px;">Datos precargados desde el ticket ${escapeHtml(precarga.ticket)}.</div>` : ''}
    <div class="field"><label>Cliente</label><input type="text" id="tags-cliente" placeholder="Nombre del cliente" value="${escapeHtml(precarga.cliente || '')}"></div>
    <div class="field"><label>Edificio</label>
      <select id="tags-edificio">
        <option value="">-- Seleccioná un edificio --</option>
        ${edificios.map(e => `<option value="${escapeHtml(e.edificio)}" ${precarga.edificio === e.edificio ? 'selected' : ''}>${escapeHtml(e.edificio)}</option>`).join('')}
      </select>
      ${precarga.edificio ? `<div class="hint-text">Precargado del Cliente asignado al ticket; cambialo si no corresponde.</div>` : ''}
    </div>
    <div class="field-row">
      <div class="field"><label>Torre</label><input type="text" id="tags-torre" placeholder="Torre"></div>
      <div class="field"><label>Unidad</label><input type="text" id="tags-unidad" placeholder="Unidad"></div>
    </div>
    <div class="field"><label>Tipo de tags</label>
      <select id="tags-tipo" onchange="actualizarCostoTags()"><option value="Peatonales">Peatonales</option><option value="Vehiculares">Vehiculares</option></select>
    </div>
    <div class="field-row">
      <div class="field"><label>Cantidad</label><input type="number" id="tags-cantidad" min="1" placeholder="Cantidad" oninput="actualizarCostoTags()"></div>
      <div class="field"><label>Costo total (UYU)</label><input type="number" id="tags-costo" step="0.01" placeholder="Costo" readonly style="background:var(--bg-soft,#f2f2f2);"></div>
    </div>
    <div class="hint-text">Tags peatonales: $250 c/u · Tags vehiculares: $350 c/u. El costo se calcula solo según el tipo y la cantidad.</div>
    <div class="field"><label>Ticket</label><input type="text" id="tags-ticket" placeholder="Número de ticket (ej: T-2026-0001)" value="${escapeHtml(precarga.ticket || '')}" required></div>
    <div class="hint-text">Al marcar el pedido como entregado, este ticket se cierra solo (pasa a Resuelto) con una respuesta automática al cliente.</div>
    <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
      <button type="button" class="btn btn-primary btn-block" onclick="guardarPedidoTags()">Guardar pedido</button>
    </div>
  </div>`;
}
async function guardarPedidoTags() {
  const nombreCliente = document.getElementById('tags-cliente').value.trim();
  const edificio = document.getElementById('tags-edificio').value.trim();
  const torre = document.getElementById('tags-torre').value.trim();
  const unidad = document.getElementById('tags-unidad').value.trim();
  const tipoTags = document.getElementById('tags-tipo').value;
  const cantidadTags = Number(document.getElementById('tags-cantidad').value);
  const costo = document.getElementById('tags-costo').value;
  const ticket = document.getElementById('tags-ticket').value.trim();
  if (!nombreCliente || !edificio || !cantidadTags) { showToast('Completá cliente, edificio y cantidad.'); return; }
  if (!ticket) { showToast('Falta el número de ticket.'); return; }
  try {
    await api('POST', '/api/tags/pedidos', { nombreCliente, edificio, torre, unidad, tipoTags, cantidadTags, costo, ticket });
    state.tagsPrecarga = null;
    showToast('Pedido guardado.');
    state.tagsTab = 'pedidos';
    render();
    renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } });
  } catch (e) { showToast(e.message); }
}
function renderTagsPedidos() {
  const pendientes = (cache.tagsPedidos || []).filter(p => !p.entregado);
  if (!pendientes.length) return `<div class="empty-state">No hay pedidos pendientes.</div>`;
  const filas = pendientes.map(p => `<tr>
    <td>${escapeHtml(p.ticket || '')}</td><td>${escapeHtml(p.nombre_cliente)}</td><td>${escapeHtml(p.edificio || '')}</td>
    <td>${escapeHtml(p.tipo_tags || '')}</td><td>${p.cantidad_tags}</td><td>${p.costo != null ? p.costo : ''}</td>
    <td><button class="btn btn-sm" onclick="marcarEntregadoTags(${p.id})">Marcar entregado</button>
    ${currentUser().es_superadmin ? `<button class="btn btn-sm btn-danger" onclick="eliminarPedidoTags(${p.id})">Eliminar</button>` : ''}</td>
  </tr>`).join('');
  return `<div class="card"><table class="reportes-table">
    <thead><tr><th>Ticket</th><th>Cliente</th><th>Edificio</th><th>Tipo</th><th>Cant.</th><th>Costo</th><th>Acción</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
async function marcarEntregadoTags(id) {
  const tagNum = prompt('Número de tag entregado:');
  if (tagNum === null) return;
  if (!tagNum.trim()) { showToast('Ingresá un número de tag válido.'); return; }
  try {
    await api('POST', `/api/tags/pedidos/${id}/entregar`, { tagNum: tagNum.trim() });
    showToast('Marcado como entregado.');
    renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } });
  } catch (e) { showToast(e.message); }
}
async function eliminarPedidoTags(id) {
  if (!confirm('¿Eliminar este pedido?')) return;
  try {
    await api('DELETE', `/api/tags/pedidos/${id}`);
    renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } });
  } catch (e) { showToast(e.message); }
}
function renderTagsHistorial() {
  const entregados = (cache.tagsPedidos || []).filter(p => p.entregado);
  if (!entregados.length) return `<div class="empty-state">Todavía no hay tags entregados.</div>`;
  const filas = entregados.map(p => `<tr>
    <td>${escapeHtml(p.nombre_cliente)}</td><td>${escapeHtml(p.tipo_tags || '')}</td><td>${p.cantidad_tags}</td>
    <td>${escapeHtml(p.tag_num || '')}</td><td>${p.fecha_entrega ? new Date(p.fecha_entrega).toLocaleString('es-AR') : ''}</td>
  </tr>`).join('');
  return `<div class="card"><table class="reportes-table">
    <thead><tr><th>Cliente</th><th>Tipo</th><th>Cant.</th><th>Tag N°</th><th>Fecha entrega</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
function renderTagsEdificios() {
  const edificios = cache.tagsEdificios || [];
  const filas = edificios.map(e => `<tr>
    <td>${escapeHtml(e.edificio)}</td>
    <td>${e.restante_peatonal} / ${e.cantidad_peatonal} ${e.restante_peatonal <= TAGS_STOCK_MINIMO ? '<span style="color:var(--stamp-red);font-weight:700;">⚠️</span>' : ''}</td>
    <td>${e.restante_vehicular} / ${e.cantidad_vehicular} ${e.restante_vehicular <= TAGS_STOCK_MINIMO ? '<span style="color:var(--stamp-red);font-weight:700;">⚠️</span>' : ''}</td>
    <td><button class="btn btn-sm" onclick="editarEdificioTags(${e.id}, '${e.edificio.replace(/'/g, "\\'")}', ${e.cantidad_peatonal}, ${e.cantidad_vehicular})">Editar</button>
    <button class="btn btn-sm btn-danger" onclick="eliminarEdificioTags(${e.id})">Eliminar</button></td>
  </tr>`).join('');
  return `<div class="card card-narrow" style="max-width:560px;">
    ${configSectionHead('🏢', 'Agregar / actualizar edificio', 'Si el edificio ya existe, se actualiza su stock total.')}
    <div class="field"><label>Edificio</label><input type="text" id="tags-nuevo-edificio" placeholder="Nombre del edificio"></div>
    <div class="field-row">
      <div class="field"><label>Peatonales (total)</label><input type="number" id="tags-nuevo-peatonal" min="0" value="0"></div>
      <div class="field"><label>Vehiculares (total)</label><input type="number" id="tags-nuevo-vehicular" min="0" value="0"></div>
    </div>
    <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
      <button type="button" class="btn btn-primary btn-block" onclick="guardarEdificioTags()">Guardar edificio</button>
    </div>
  </div>
  <div class="card" style="margin-top:16px;"><table class="reportes-table">
    <thead><tr><th>Edificio</th><th>Peatonales (disp./total)</th><th>Vehiculares (disp./total)</th><th>Acción</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
async function guardarEdificioTags() {
  const edificio = document.getElementById('tags-nuevo-edificio').value.trim();
  const cantidadPeatonal = document.getElementById('tags-nuevo-peatonal').value;
  const cantidadVehicular = document.getElementById('tags-nuevo-vehicular').value;
  if (!edificio) { showToast('Falta el nombre del edificio.'); return; }
  try {
    await api('POST', '/api/tags/edificios', { edificio, cantidadPeatonal, cantidadVehicular });
    showToast('Edificio guardado.');
    renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } });
  } catch (e) { showToast(e.message); }
}
function editarEdificioTags(id, edificio, peatonal, vehicular) {
  const p = prompt(`Cantidad total de tags peatonales en ${edificio}:`, peatonal);
  if (p === null) return;
  const v = prompt(`Cantidad total de tags vehiculares en ${edificio}:`, vehicular);
  if (v === null) return;
  api('PUT', `/api/tags/edificios/${id}`, { cantidadPeatonal: Number(p) || 0, cantidadVehicular: Number(v) || 0 }).then(() => {
    showToast('Edificio actualizado.');
    renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } });
  }).catch(e => showToast(e.message));
}
async function eliminarEdificioTags(id) {
  if (!confirm('¿Eliminar este edificio del control de stock?')) return;
  try {
    await api('DELETE', `/api/tags/edificios/${id}`);
    renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } });
  } catch (e) { showToast(e.message); }
}

/* ---------------- Estadísticas / reportes de productividad (solo Superadmin) ---------------- */

function calcularRangoPreset(preset) {
  const hoy = new Date();
  const y = hoy.getFullYear(), m = hoy.getMonth();
  const fmt = d => d.toISOString().slice(0, 10);
  if (preset === 'mes-pasado') return { desde: fmt(new Date(y, m - 1, 1)), hasta: fmt(new Date(y, m, 0)) };
  if (preset === 'ultimos-3-meses') return { desde: fmt(new Date(y, m - 2, 1)), hasta: fmt(hoy) };
  if (preset === 'ultimos-6-meses') return { desde: fmt(new Date(y, m - 5, 1)), hasta: fmt(hoy) };
  return { desde: fmt(new Date(y, m, 1)), hasta: fmt(hoy) }; // este-mes
}
async function cargarReportes() {
  state.reportesCargando = true; render();
  let desde, hasta;
  if (state.reportesRango === 'personalizado') {
    desde = state.reportesDesde; hasta = state.reportesHasta;
    if (!desde || !hasta) { showToast('Elegí las dos fechas del período.'); state.reportesCargando = false; render(); return; }
  } else {
    const r = calcularRangoPreset(state.reportesRango);
    desde = r.desde; hasta = r.hasta;
  }
  try {
    state.reportes = await api('GET', `/api/reportes?desde=${desde}&hasta=${hasta}`);
  } catch (e) { showToast(e.message); }
  state.reportesCargando = false;
  render();
}
function setReportesRango(v) { state.reportesRango = v; if (v !== 'personalizado') cargarReportes(); else render(); }
function setReportesFechaPersonalizada(campo, v) { state[campo] = v; }
function setReportesUsuario(v) { state.reportesUsuario = v; render(); }
function fmtHoras(h) {
  if (h === null || h === undefined) return '—';
  if (h < 1) return Math.round(h * 60) + ' min';
  if (h < 48) return h.toFixed(1) + ' h';
  return (h / 24).toFixed(1) + ' d';
}
function fmtDateShort(iso) { return new Date(iso).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function pctReporte(a, b) { return b ? Math.round((a / b) * 100) : 0; }
// Ícono + color de acento según el texto del label — puramente cosmético, no cambia los datos.
function kpiIconYColor(label) {
  const l = label.toLowerCase();
  if (l.includes('recibidos')) return ['📥', '#1E56C7'];
  if (l.includes('resueltos/cerrados') || l === 'resueltos/cerrados') return ['✅', '#1F8A5F'];
  if (l.includes('% resueltos')) return ['📈', '#B3811C'];
  if (l.includes('sin asignar')) return ['⚠️', '#C43D3D'];
  if (l.includes('abiertos')) return ['🗂️', '#3D7EF0'];
  if (l.includes('1ra respuesta')) return ['⏱️', '#8B5CF6'];
  if (l.includes('resolución')) return ['⏳', '#0D9488'];
  if (l.includes('atendidos')) return ['🎯', '#1E56C7'];
  if (l.includes('mensajes')) return ['💬', '#0D9488'];
  return ['📊', '#1E56C7'];
}
function kpiCard(label, value) {
  const [icon, color] = kpiIconYColor(label);
  return `<div class="kpi-tile" style="color:${color};">
    <div class="ico-badge" style="background:${color}17;color:${color};">${icon}</div>
    <div class="v" style="color:var(--ink);">${value}</div><div class="l">${escapeHtml(label)}</div>
  </div>`;
}
function barChartSvg(datos) {
  if (!datos.length || datos.every(d => d.value === 0)) return '<div class="hint-text">Sin tickets resueltos en este período.</div>';
  const max = Math.max(1, ...datos.map(d => d.value));
  const barH = 28, gap = 14, leftW = 150, chartW = 380;
  const height = datos.length * (barH + gap) + gap;
  const bars = datos.map((d, i) => {
    const y = gap + i * (barH + gap);
    const w = Math.max(2, Math.round((d.value / max) * chartW));
    const label = d.label.length > 22 ? d.label.slice(0, 21) + '…' : d.label;
    return `<text x="0" y="${y + barH / 2 + 4}" font-size="12.5" fill="var(--ink)">${escapeHtml(label)}</text>
      <rect x="${leftW}" y="${y}" width="${chartW}" height="${barH}" rx="7" fill="var(--paper)"></rect>
      <rect class="chart-bar-3d" x="${leftW}" y="${y}" width="${w}" height="${barH}" rx="7" fill="url(#barGrad3d)" filter="url(#barShadow3d)" style="transform-origin:${leftW}px ${y}px;animation-delay:${i * 70}ms;"></rect>
      <rect x="${leftW}" y="${y}" width="${w}" height="${Math.round(barH * .4)}" rx="6" fill="rgba(255,255,255,.28)"></rect>
      <text x="${leftW + w + 8}" y="${y + barH / 2 + 4}" font-size="12.5" font-weight="600" fill="var(--ink)">${d.value}</text>`;
  }).join('');
  return `<style>
    .chart-bar-3d{animation:chartBarGrow .6s cubic-bezier(.2,.9,.25,1) both;}
    @keyframes chartBarGrow{from{transform:scaleX(0);}to{transform:scaleX(1);}}
    @media (prefers-reduced-motion: reduce){.chart-bar-3d{animation:none;}}
  </style>
  <svg viewBox="0 0 ${leftW + chartW + 50} ${height}" style="width:100%;height:auto;max-width:620px;display:block;">
    <defs>
      <linearGradient id="barGrad3d" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4C8CF5"/><stop offset="55%" stop-color="#1E56C7"/><stop offset="100%" stop-color="#163F94"/>
      </linearGradient>
      <filter id="barShadow3d" x="-20%" y="-40%" width="140%" height="220%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#1E56C7" flood-opacity="0.35"/>
      </filter>
    </defs>
    ${bars}
  </svg>`;
}
function lineChartSvg(serie) {
  if (!serie.length) return '<div class="hint-text">Sin datos suficientes.</div>';
  const w = 640, h = 220, padL = 30, padB = 26, padT = 14, padR = 10;
  const max = Math.max(1, ...serie.map(s => Math.max(s.recibidos, s.resueltos)));
  const stepX = serie.length > 1 ? (w - padL - padR) / (serie.length - 1) : 0;
  const x = i => padL + i * stepX;
  const y = v => padT + (h - padT - padB) * (1 - v / max);
  const pathFor = key => serie.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(s[key]).toFixed(1)}`).join(' ');
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const yy = padT + (h - padT - padB) * (1 - f);
    return `<line x1="${padL}" y1="${yy}" x2="${w - padR}" y2="${yy}" stroke="#e4e8ef" stroke-width="1"></line>`;
  }).join('');
  const labels = serie.map((s, i) => `<text x="${x(i)}" y="${h - 6}" font-size="11" text-anchor="middle" fill="#6b7280">${escapeHtml(s.mes.slice(5))}/${escapeHtml(s.mes.slice(2, 4))}</text>`).join('');
  const areaFor = key => `${pathFor(key)} L ${x(serie.length - 1).toFixed(1)} ${(h - padB).toFixed(1)} L ${x(0).toFixed(1)} ${(h - padB).toFixed(1)} Z`;
  const dotsFor = (key, color) => serie.map((s, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(s[key]).toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5" filter="url(#lineDotShadow)"></circle>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;max-width:680px;display:block;">
      <defs>
        <linearGradient id="areaGradRecibidos" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8aa4c8" stop-opacity="0.35"/><stop offset="100%" stop-color="#8aa4c8" stop-opacity="0"/></linearGradient>
        <linearGradient id="areaGradResueltos" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1E56C7" stop-opacity="0.4"/><stop offset="100%" stop-color="#1E56C7" stop-opacity="0"/></linearGradient>
        <filter id="lineDotShadow" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#0F2A4D" flood-opacity="0.3"/></filter>
      </defs>
      ${gridLines}
      <path d="${areaFor('recibidos')}" fill="url(#areaGradRecibidos)" stroke="none"></path>
      <path d="${areaFor('resueltos')}" fill="url(#areaGradResueltos)" stroke="none"></path>
      <path d="${pathFor('recibidos')}" fill="none" stroke="#8aa4c8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="${pathFor('resueltos')}" fill="none" stroke="#1E56C7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
      ${dotsFor('recibidos', '#8aa4c8')}
      ${dotsFor('resueltos', '#1E56C7')}
      ${labels}
    </svg>
    <div style="display:flex;gap:16px;margin-top:8px;font-size:12.5px;">
      <span><span style="display:inline-block;width:10px;height:10px;background:#8aa4c8;border-radius:2px;margin-right:6px;"></span>Recibidos</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#1E56C7;border-radius:2px;margin-right:6px;"></span>Resueltos</span>
    </div>`;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Arma un .csv (se abre directo en Excel) con todos los números del reporte que está en pantalla
// en ese momento (mismo período y filtro de agente que tengas elegidos).
function descargarReporteExcel() {
  if (!state.reportes) return;
  const r = state.reportes;
  const filas = [];
  filas.push(['Reporte de Estadísticas']);
  filas.push(['Período', `${fmtDateShort(r.rango.desde)} - ${fmtDateShort(r.rango.hasta)}`]);
  filas.push(['Emitido', fmtDateShort(new Date().toISOString())]);
  filas.push([]);
  filas.push(['Resumen general']);
  filas.push(['Tickets recibidos', r.general.recibidos]);
  filas.push(['Resueltos/Cerrados', r.general.resueltos]);
  filas.push(['% resueltos', pctReporte(r.general.resueltos, r.general.recibidos) + '%']);
  filas.push(['Sin asignar (hoy)', r.general.sinAsignar]);
  filas.push(['Abiertos actuales', r.general.abiertosActuales]);
  filas.push(['Prom. 1ra respuesta', fmtHoras(r.general.promedioPrimeraRespuestaHoras)]);
  filas.push(['Prom. resolución', fmtHoras(r.general.promedioResolucionHoras)]);
  filas.push([]);
  filas.push(['Tickets resueltos por técnico']);
  filas.push(['Agente', 'Tickets resueltos']);
  [...r.porUsuario].sort((a, b) => b.ticketsResueltos - a.ticketsResueltos).forEach(u => filas.push([`${u.nombre} ${u.apellido}`, u.ticketsResueltos]));
  filas.push([]);
  filas.push(['Tickets recibidos por categoría']);
  filas.push(['Categoría', 'Cantidad']);
  (r.porCategoria || []).forEach(c => filas.push([c.categoria, c.cantidad]));
  filas.push([]);
  filas.push(['Tickets recibidos por edificio']);
  filas.push(['Edificio', 'Cantidad']);
  (r.porEdificio || []).forEach(e => filas.push([e.edificio, e.cantidad]));
  filas.push([]);
  filas.push(['Evolución mensual']);
  filas.push(['Mes', 'Recibidos', 'Resueltos']);
  (r.evolucion || []).forEach(m => filas.push([m.mes, m.recibidos, m.resueltos]));
  const csv = '﻿' + filas.map(fila => fila.map(csvEscape).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `estadisticas-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast('Excel descargado.');
}
function renderEstadisticas() {
  const rangoOpts = [
    ['este-mes', 'Este mes'], ['mes-pasado', 'Mes pasado'], ['ultimos-3-meses', 'Últimos 3 meses'],
    ['ultimos-6-meses', 'Últimos 6 meses'], ['personalizado', 'Personalizado']
  ].map(([v, l]) => `<option value="${v}" ${state.reportesRango === v ? 'selected' : ''}>${l}</option>`).join('');
  const usuarioOpts = `<option value="todos" ${state.reportesUsuario === 'todos' ? 'selected' : ''}>Todo el equipo</option>` +
    (state.reportes ? state.reportes.porUsuario.map(u => `<option value="${u.id}" ${state.reportesUsuario === u.id ? 'selected' : ''}>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}${u.id === currentUser().id ? ' (Yo)' : ''}</option>`).join('') : '');
  const filtros = `<div class="filters no-print">
      <select onchange="setReportesRango(this.value)">${rangoOpts}</select>
      ${state.reportesRango === 'personalizado' ? `
        <input type="date" value="${escapeHtml(state.reportesDesde)}" onchange="setReportesFechaPersonalizada('reportesDesde', this.value)">
        <input type="date" value="${escapeHtml(state.reportesHasta)}" onchange="setReportesFechaPersonalizada('reportesHasta', this.value)">
        <button class="btn btn-ghost" onclick="cargarReportes()">Aplicar</button>` : ''}
      <select onchange="setReportesUsuario(this.value)">${usuarioOpts}</select>
      <button class="btn btn-ghost" onclick="descargarReporteExcel()">📊 Exportar Excel</button>
      <button class="btn btn-primary" onclick="window.print()">🖨️ Exportar PDF</button>
    </div>`;
  const estilos = `<style>
      @media print {
        .sidebar, .topbar, .bottomnav, .no-print { display:none !important; }
        .main { margin:0 !important; }
        .report-print-head { display:block !important; }
        .card { box-shadow:none !important; border:1px solid #ddd !important; break-inside:avoid; }
      }
      .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
      .kpi-tile { position:relative; overflow:hidden; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px;
        box-shadow:0 1px 2px rgba(15,42,77,.05), 0 10px 22px -12px rgba(15,42,77,.22);
        transition:transform .18s ease, box-shadow .18s ease; }
      .kpi-tile:hover { transform:translateY(-3px); box-shadow:0 1px 2px rgba(15,42,77,.05), 0 16px 30px -12px rgba(15,42,77,.32); }
      .kpi-tile::before { content:''; position:absolute; top:-24px; right:-24px; width:88px; height:88px; border-radius:50%; background:currentColor; opacity:.09; }
      .kpi-tile .ico-badge { position:relative; z-index:1; width:34px; height:34px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:15px; margin-bottom:12px; box-shadow:inset 0 1px 0 rgba(255,255,255,.5); }
      .kpi-tile .v { position:relative; z-index:1; font-family:var(--font-display); font-weight:700; font-size:25px; }
      .kpi-tile .l { position:relative; z-index:1; font-size:12px; color:var(--ink-soft); margin-top:2px; }
      @media print { .kpi-tile{ box-shadow:none !important; } .kpi-tile::before{ display:none; } }
      .reportes-table { width:100%; border-collapse:collapse; font-size:13px; }
      .reportes-table th, .reportes-table td { padding:9px 10px; border-bottom:1px solid var(--line-strong); }
      .reportes-table th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.03em; color:var(--ink-soft); }
      .report-print-head { display:none; margin-bottom:18px; }
    </style>`;
  if (state.reportesCargando || !state.reportes) {
    return `${estilos}<div class="page-head"><div><h1>Estadísticas</h1><div class="sub">Rendimiento del equipo</div></div></div>${filtros}<div class="empty-state">Cargando reporte…</div>`;
  }
  const r = state.reportes;
  const rangoTexto = `${fmtDateShort(r.rango.desde)} — ${fmtDateShort(r.rango.hasta)}`;
  if (state.reportesUsuario !== 'todos') {
    const u = r.porUsuario.find(x => x.id === state.reportesUsuario);
    if (!u) { state.reportesUsuario = 'todos'; return renderEstadisticas(); }
    return `${estilos}
      <div class="page-head"><div><h1>Estadísticas</h1><div class="sub">Reporte individual — ${rangoTexto}</div></div></div>
      ${filtros}
      <div class="report-print-head"><h2 style="font-family:var(--font-display);">Reporte de productividad — ${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</h2>
        <div class="hint-text">Período: ${rangoTexto} · Emitido: ${fmtDateShort(new Date().toISOString())}</div></div>
      <div class="card" style="margin-bottom:18px;">
        <div style="font-family:var(--font-display);font-weight:700;font-size:20px;">${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</div>
        <div class="hint-text" style="margin-bottom:16px;">${escapeHtml(u.cargo || '')}</div>
        <div class="kpi-grid">
          ${kpiCard('Tickets atendidos', u.ticketsAsignados)}
          ${kpiCard('Resueltos/Cerrados', u.ticketsResueltos)}
          ${kpiCard('% resueltos', pctReporte(u.ticketsResueltos, u.ticketsAsignados) + '%')}
          ${kpiCard('Mensajes enviados', u.mensajesEnviados)}
          ${kpiCard('Prom. 1ra respuesta', fmtHoras(u.promedioPrimeraRespuestaHoras))}
          ${kpiCard('Prom. resolución', fmtHoras(u.promedioResolucionHoras))}
        </div>
      </div>
      <div class="card">
        <div style="font-weight:600;font-size:13.5px;margin-bottom:12px;">Evolución del equipo — últimos 6 meses</div>
        ${lineChartSvg(r.evolucion)}
      </div>`;
  }
  const ordenado = [...r.porUsuario].sort((a, b) => b.ticketsResueltos - a.ticketsResueltos);
  const ranking = ordenado.map(u => ({ label: `${u.nombre} ${u.apellido}`, value: u.ticketsResueltos }));
  const filas = ordenado.map(u => `<tr>
      <td>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}${u.id === currentUser().id ? ' <span class="hint-text">(Yo)</span>' : ''}</td>
      <td style="text-align:center;">${u.ticketsAsignados}</td>
      <td style="text-align:center;">${u.ticketsResueltos}</td>
      <td style="text-align:center;">${pctReporte(u.ticketsResueltos, u.ticketsAsignados)}%</td>
      <td style="text-align:center;">${u.mensajesEnviados}</td>
      <td style="text-align:center;">${fmtHoras(u.promedioPrimeraRespuestaHoras)}</td>
      <td style="text-align:center;">${fmtHoras(u.promedioResolucionHoras)}</td>
    </tr>`).join('');
  return `${estilos}
    <div class="page-head"><div><h1>Estadísticas</h1><div class="sub">Rendimiento del equipo — ${rangoTexto}</div></div></div>
    ${filtros}
    <div class="report-print-head"><h2 style="font-family:var(--font-display);">Reporte de productividad del equipo</h2>
      <div class="hint-text">Período: ${rangoTexto} · Emitido: ${fmtDateShort(new Date().toISOString())}</div></div>
    <div class="card" style="margin-bottom:18px;">
      <div class="kpi-grid">
        ${kpiCard('Tickets recibidos', r.general.recibidos)}
        ${kpiCard('Resueltos/Cerrados', r.general.resueltos)}
        ${kpiCard('% resueltos', pctReporte(r.general.resueltos, r.general.recibidos) + '%')}
        ${kpiCard('Sin asignar (hoy)', r.general.sinAsignar)}
        ${kpiCard('Abiertos actuales', r.general.abiertosActuales)}
        ${kpiCard('Prom. 1ra respuesta', fmtHoras(r.general.promedioPrimeraRespuestaHoras))}
        ${kpiCard('Prom. resolución', fmtHoras(r.general.promedioResolucionHoras))}
      </div>
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:12px;">Tickets resueltos por técnico</div>
      ${barChartSvg(ranking)}
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:12px;">Tickets recibidos por categoría — ${rangoTexto}</div>
      ${(r.porCategoria || []).length ? barChartSvg((r.porCategoria || []).map(c => ({ label: c.categoria, value: c.cantidad }))) : `<div class="hint-text">No hay tickets en este período.</div>`}
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:12px;">Tickets recibidos por edificio — ${rangoTexto}</div>
      ${(r.porEdificio || []).length ? barChartSvg((r.porEdificio || []).map(e => ({ label: e.edificio, value: e.cantidad }))) : `<div class="hint-text">No hay datos de edificio en este período.</div>`}
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:12px;">Evolución mensual — recibidos vs. resueltos</div>
      ${lineChartSvg(r.evolucion)}
    </div>
    <div class="card">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:12px;">Detalle por usuario</div>
      <div style="overflow-x:auto;">
      <table class="reportes-table">
        <thead><tr><th>Usuario</th><th style="text-align:center;">Atendidos</th><th style="text-align:center;">Resueltos</th><th style="text-align:center;">% resueltos</th><th style="text-align:center;">Mensajes</th><th style="text-align:center;">1ra respuesta</th><th style="text-align:center;">Resolución</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      </div>
    </div>`;
}

function renderConfiguracion() {
  const c = cache.configuracion;
  const tab = state.configTab || 'correo';
  return `${configStyleTag()}<div class="page-head"><div><h1>Configuración</h1><div class="sub">Ajustes generales del sistema, agrupados por tema</div></div></div>
    ${renderConfigTabs()}
    <div style="height:16px;"></div>
    <form onsubmit="return submitConfiguracion(event)">

      <div class="card card-narrow" style="max-width:560px;${tab === 'correo' ? '' : 'display:none;'}">
        ${configSectionHead('📧', 'Casilla de correo de soporte', 'Conectá tu casilla real para que reciba correos y cree tickets solos, y para que las respuestas le lleguen de verdad al cliente.')}
        <div class="field"><label>Correo electrónico de la casilla</label><input name="casillaEmail" type="email" value="${escapeHtml(c.casillaEmail || '')}" placeholder="tickets@borcam.com.uy" required></div>
        <div class="field"><label>Nombre para mostrar</label><input name="casillaNombre" value="${escapeHtml(c.casillaNombre || '')}" placeholder="Ej: Mesa de Soporte"></div>

        <label class="switch-row" style="margin:6px 0 16px;padding-top:12px;border-top:1px dashed var(--line-strong);">
          <input type="checkbox" name="correoActivo" ${c.correoActivo ? 'checked' : ''}> Activar recepción y envío real (si está apagado, todo sigue funcionando como demo)
        </label>

        <div style="font-weight:600;font-size:13.5px;margin-bottom:8px;">Recibir correo (IMAP)</div>
        <div class="field-row">
          <div class="field"><label>Servidor IMAP</label><input name="imapHost" value="${escapeHtml(c.imapHost || '')}" placeholder="mail.borcam.com.uy"></div>
          <div class="field"><label>Puerto</label><input name="imapPort" type="number" value="${c.imapPort || 993}"></div>
        </div>
        <div class="field"><label>Usuario (normalmente el correo completo)</label><input name="imapUsuario" value="${escapeHtml(c.imapUsuario || '')}" placeholder="tickets@borcam.com.uy"></div>
        <div class="field"><label>Contraseña</label><input name="imapPassword" type="password" placeholder="${c.tieneImapPassword ? 'Dejar en blanco para no cambiarla' : 'Contraseña del correo'}"></div>

        <div style="font-weight:600;font-size:13.5px;margin:12px 0 8px;padding-top:12px;border-top:1px dashed var(--line-strong);">Enviar correo (SMTP)</div>
        <div class="field-row">
          <div class="field"><label>Servidor SMTP</label><input name="smtpHost" value="${escapeHtml(c.smtpHost || '')}" placeholder="mail.borcam.com.uy"></div>
          <div class="field"><label>Puerto</label><input name="smtpPort" type="number" value="${c.smtpPort || 465}"></div>
        </div>
        <div class="field"><label>Usuario</label><input name="smtpUsuario" value="${escapeHtml(c.smtpUsuario || '')}" placeholder="tickets@borcam.com.uy"></div>
        <div class="field"><label>Contraseña</label><input name="smtpPassword" type="password" placeholder="${c.tieneSmtpPassword ? 'Dejar en blanco para no cambiarla' : 'Contraseña del correo'}"></div>

        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
          <button type="button" class="btn btn-ghost btn-block" onclick="probarConexionCorreo()">Probar conexión de correo</button>
          <div id="resultado-prueba" style="margin-top:8px;"></div>
        </div>
      </div>

      <div class="card card-narrow" style="max-width:560px;${tab === 'correo' ? '' : 'display:none;'}">
        ${configSectionHead('🔧', 'Casilla para órdenes de mantenimiento', 'Casilla aparte, solo para mandar las órdenes de mantenimiento por correo — nunca la de tickets. Así, si el cliente contesta ese mail, no se genera un ticket sin querer (esta casilla no se revisa nunca).')}
        <label class="switch-row" style="margin-bottom:16px;">
          <input type="checkbox" name="correoMantenimientoActivo" ${c.correoMantenimientoActivo ? 'checked' : ''}> Activar el envío de órdenes de mantenimiento
        </label>
        <div class="field"><label>Correo de esta casilla</label><input name="smtpUsuarioMant" type="email" value="${escapeHtml(c.smtpUsuarioMant || '')}" placeholder="mantenimiento@borcam.com.uy"></div>
        <div class="field"><label>Nombre para mostrar</label><input name="casillaNombreMant" value="${escapeHtml(c.casillaNombreMant || '')}" placeholder="Ej: Borcam Mantenimiento"></div>
        <div class="field-row">
          <div class="field"><label>Servidor SMTP</label><input name="smtpHostMant" value="${escapeHtml(c.smtpHostMant || '')}" placeholder="mail.borcam.com.uy"></div>
          <div class="field"><label>Puerto</label><input name="smtpPortMant" type="number" value="${c.smtpPortMant || 465}"></div>
        </div>
        <div class="field"><label>Contraseña</label><input name="smtpPasswordMant" type="password" placeholder="${c.tieneSmtpPasswordMant ? 'Dejar en blanco para no cambiarla' : 'Contraseña del correo'}"></div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
          <button type="button" class="btn btn-ghost btn-block" onclick="probarConexionCorreoMantenimiento()">Probar conexión de esta casilla</button>
          <div id="resultado-prueba-mant" style="margin-top:8px;"></div>
        </div>
      </div>

      <div class="card card-narrow" style="max-width:560px;${tab === 'telegram' ? '' : 'display:none;'}">
        ${configSectionHead('✈️', 'Notificaciones en Telegram', `Cada vez que llega un ticket nuevo (no en respuestas posteriores), se manda un aviso a un grupo de Telegram con un resumen y un enlace para abrirlo. Los tickets que contengan la palabra "reserva" no se avisan por acá.${c.telegramConfiguradoServidor ? '' : '<br><strong style="color:var(--stamp-red);">Falta configurar el bot en el servidor (variable TELEGRAM_BOT_TOKEN).</strong>'}`)}
        <label class="switch-row">
          <input type="checkbox" name="telegramActivo" ${c.telegramActivo ? 'checked' : ''}> Activar notificaciones en Telegram
        </label>
        <div class="field"><label>Chat ID del grupo</label><input name="telegramChatId" value="${escapeHtml(c.telegramChatId || '')}" placeholder="-1001234567890"></div>

        <div style="font-weight:600;font-size:13.5px;margin:12px 0 8px;padding-top:12px;border-top:1px dashed var(--line-strong);">Recordatorio diario de tickets sin asignar</div>
        <div class="hint-text" style="margin-bottom:10px;">Todos los días, después de esta hora, se manda al grupo un mensaje aparte por cada ticket sin asignar (excepto los de reserva), para que cualquiera lo pueda tomar. Como mucho se manda una vez por día.</div>
        <label class="switch-row">
          <input type="checkbox" name="recordatorioSinAsignarActivo" ${c.recordatorioSinAsignarActivo !== false ? 'checked' : ''}> Activar recordatorio diario
        </label>
        <div class="field"><label>Mandarlo después de las</label><input type="time" name="recordatorioSinAsignarHora" value="${c.recordatorioSinAsignarHora || '18:00'}" style="max-width:140px;"></div>

        <div style="font-weight:600;font-size:13.5px;margin:12px 0 8px;padding-top:12px;border-top:1px dashed var(--line-strong);">Seguimiento de tickets asignados</div>
        <div class="hint-text" style="margin-bottom:10px;">Si un ticket asignado a alguien lleva varios días sin actividad, se le avisa por Telegram al técnico (necesita vincular su Telegram desde "Mi perfil"). Si sigue sin resolverse, se puede escalar al grupo general.</div>
        <label class="switch-row">
          <input type="checkbox" name="seguimientoActivo" ${c.seguimientoActivo !== false ? 'checked' : ''}> Activar seguimiento de tickets asignados
        </label>
        <div class="field-row">
          <div class="field"><label>Días sin actividad para el 1er recordatorio</label><input type="number" name="seguimientoDiasRecordatorio" min="1" value="${c.seguimientoDiasRecordatorio || 2}"></div>
          <div class="field"><label>Repetir cada (días)</label><input type="number" name="seguimientoRepetirDias" min="1" value="${c.seguimientoRepetirDias || 2}"></div>
        </div>
        <div class="field"><label>Escalar al grupo de Telegram a los (días) — 0 para desactivar</label><input type="number" name="seguimientoDiasEscalar" min="0" value="${c.seguimientoDiasEscalar || 0}"></div>

        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
          <button type="button" class="btn btn-ghost btn-block" onclick="probarTelegram()">Enviar mensaje de prueba a Telegram</button>
          <div id="resultado-telegram" style="margin-top:8px;"></div>
        </div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
          <button type="button" class="btn btn-ghost btn-block" onclick="probarSeguimiento()">Ejecutar revisión de seguimiento ahora (prueba)</button>
          <div class="hint-text" style="margin-top:6px;">Fuerza la revisión al instante, sin esperar los 30 minutos habituales. Útil solo para probar.</div>
          <div id="resultado-seguimiento" style="margin-top:8px;"></div>
        </div>
      </div>

      <div class="card card-narrow" style="max-width:560px;${tab === 'notificaciones' ? '' : 'display:none;'}">
        ${configSectionHead('🔔', 'Aviso automático de fin de semana', 'Los sábados y domingos, cuando llega un mensaje nuevo, el sistema responde solo con este texto (una vez por día por ticket).')}
        <label class="switch-row">
          <input type="checkbox" name="avisoFindeActivo" ${c.avisoFindeActivo !== false ? 'checked' : ''}> Activar aviso de fin de semana
        </label>
        <div class="field"><label>Mensaje del aviso</label><textarea name="avisoFindeMensaje">${escapeHtml(c.avisoFindeMensaje || '')}</textarea></div>

        <div style="font-weight:600;font-size:13.5px;margin:12px 0 8px;padding-top:12px;border-top:1px dashed var(--line-strong);">Aviso automático fuera de horario (días hábiles)</div>
        <div class="hint-text" style="margin-bottom:10px;">De lunes a viernes, fuera del horario que definas acá, el sistema responde solo con este texto (una vez por día por ticket). Los fines de semana los cubre el aviso de arriba, no este.</div>
        <label class="switch-row">
          <input type="checkbox" name="avisoFueraHorarioActivo" ${c.avisoFueraHorarioActivo !== false ? 'checked' : ''}> Activar aviso fuera de horario
        </label>
        <div class="field-row">
          <div class="field"><label>Horario de atención desde</label><input type="time" name="avisoFueraHorarioInicio" value="${c.avisoFueraHorarioInicio || '09:00'}"></div>
          <div class="field"><label>Hasta</label><input type="time" name="avisoFueraHorarioFin" value="${c.avisoFueraHorarioFin || '18:00'}"></div>
        </div>
        <div class="field"><label>Mensaje del aviso</label><textarea name="avisoFueraHorarioMensaje">${escapeHtml(c.avisoFueraHorarioMensaje || '')}</textarea></div>
      </div>

      <div class="card card-narrow" style="max-width:560px;${tab === 'respaldo' ? '' : 'display:none;'}">
        ${configSectionHead('💾', 'Respaldo automático del sistema', 'Manda por correo, cada tantos días, una copia completa de los datos (tickets, conversaciones, clientes, configuración) y un archivo comprimido con los adjuntos guardados (fotos, PDFs, videos). Si los adjuntos pesan demasiado para enviarlos por correo, se avisa en el mismo correo y se pueden descargar a mano abajo.')}
        <label class="switch-row">
          <input type="checkbox" name="respaldoActivo" ${c.respaldoActivo ? 'checked' : ''}> Enviarme un respaldo automático por correo
        </label>
        <div class="field-row">
          <div class="field"><label>Correo de destino</label><input name="respaldoCorreoDestino" type="email" value="${escapeHtml(c.respaldoCorreoDestino || '')}" placeholder="tu-correo-personal@gmail.com"></div>
          <div class="field"><label>Cada cuántos días</label><input type="number" name="respaldoFrecuenciaDias" min="1" value="${c.respaldoFrecuenciaDias || 7}"></div>
        </div>
        ${c.respaldoUltimo ? `<div class="hint-text" style="margin-top:-6px;">Último respaldo enviado: ${new Date(c.respaldoUltimo).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short' })}</div>` : ''}

        ${currentUser().es_superadmin ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);display:flex;flex-direction:column;gap:8px;">
          <button type="button" class="btn btn-ghost btn-block" onclick="descargarRespaldoAhora()">Descargar respaldo (datos)</button>
          <button type="button" class="btn btn-ghost btn-block" onclick="descargarRespaldoArchivos()">Descargar archivos adjuntos</button>
        </div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
          <label style="font-weight:600;font-size:13px;color:var(--stamp-red);display:block;margin-bottom:6px;">Restaurar desde un archivo de respaldo</label>
          <div class="hint-text" style="margin-bottom:8px;">Borra TODOS los datos actuales y los reemplaza por los del archivo. Usar solo en una recuperación real.</div>
          <input type="file" id="input-restaurar" accept="application/json">
          <button type="button" class="btn btn-danger btn-block" style="margin-top:8px;" onclick="restaurarRespaldo()">Restaurar este archivo</button>
        </div>` : ''}
      </div>

      <div class="card card-narrow" style="max-width:560px;margin-top:0;">
        <button type="submit" class="btn btn-primary btn-block">Guardar configuración</button>
        <div class="hint-text" style="margin-top:8px;text-align:center;">Guarda los cambios de todas las pestañas de arriba a la vez.</div>
      </div>
    </form>

    ${currentUser().es_superadmin ? `
    <div class="card card-narrow card-peligro" style="max-width:560px;margin-top:18px;${tab === 'peligro' ? '' : 'display:none;'}">
      ${configSectionHead('⚠️', 'Zona de peligro', 'Solo visible para Superadmin.')}
      <div class="hint-text" style="margin-bottom:12px;">Borra absolutamente todos los tickets del sistema (y sus conversaciones). No se puede deshacer.</div>
      <button type="button" class="btn btn-danger btn-block" onclick="eliminarTodosLosTickets()">Eliminar TODOS los tickets</button>
      <button type="button" class="btn btn-ghost btn-block" style="margin-top:10px;" onclick="saltarAlFinalImap()">Saltar al final de la casilla (recomendado, solo procesa lo nuevo)</button>
      <button type="button" class="btn btn-danger btn-block" style="margin-top:10px;" onclick="reiniciarImap()">Reprocesar toda la casilla de correo desde cero</button>

      <div style="font-weight:600;font-size:13.5px;margin:18px 0 8px;padding-top:14px;border-top:1px dashed var(--line-strong);">Liberar espacio de almacenamiento</div>
      <div class="hint-text" style="margin-bottom:10px;">Al borrar un ticket (arriba o desde el propio ticket), sus adjuntos ya se borran solos de Storage. Marcar un ticket como Resuelto o Cerrado NO libera espacio por sí solo — para eso hay que borrarlo.</div>
      <button type="button" class="btn btn-danger btn-block" onclick="limpiarTicketsAntiguos()">Borrar tickets Resueltos/Cerrados antiguos (elegís desde cuántos meses)</button>
      <button type="button" class="btn btn-ghost btn-block" style="margin-top:10px;" onclick="limpiarAdjuntosHuerfanos()">Limpiar adjuntos huérfanos en Storage (de tickets ya borrados antes de este cambio)</button>
    </div>` : ''}

    <div class="card card-narrow" style="max-width:560px;margin-top:18px;${tab === 'checklists' ? '' : 'display:none;'}">
      ${configSectionHead('✅', 'Checklists por categoría', 'Un paso por línea. Se muestran como checklist dentro de cada ticket de esa categoría, y quedan tildados por ticket.')}
      ${CAT.CATEGORIAS.map(cat => `
        <div class="field">
          <label>${escapeHtml(cat)}</label>
          <textarea id="checklist-cat-${slug(cat)}" style="min-height:90px;">${escapeHtml(((CAT.checklistsCategoria || {})[cat] || []).join('\n'))}</textarea>
        </div>`).join('')}
      <button type="button" class="btn btn-primary btn-block" onclick="guardarChecklistsCategoria()">Guardar checklists</button>
    </div>`;
}
async function guardarChecklistsCategoria() {
  const checklists = {};
  CAT.CATEGORIAS.forEach(cat => {
    const pasos = (document.getElementById(`checklist-cat-${slug(cat)}`).value || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (pasos.length) checklists[cat] = pasos;
  });
  try {
    await api('PUT', '/api/checklists-categoria', { checklists });
    CAT.checklistsCategoria = checklists;
    showToast('Checklists guardados.');
  } catch (e) { showToast(e.message); }
}

/* ---------------- Modales ---------------- */

function renderActiveModal() {
  if (state.modal === 'nuevo-correo') return renderNuevoCorreoModal();
  if (state.modal === 'nueva-respuesta' || state.modal === 'editar-respuesta') return renderRespuestaModal();
  if (state.modal === 'nuevo-grupo' || state.modal === 'editar-grupo') return renderGrupoModal();
  if (state.modal === 'contrato-mantenimiento') return renderContratoMantenimientoModal();
  if (state.modal === 'plantilla-mantenimiento') return renderPlantillaMantenimientoModal();
  if (state.modal === 'nueva-automatizacion' || state.modal === 'editar-automatizacion') return renderAutomatizacionModal();
  if (state.modal === 'editar-usuario') return renderEditarUsuarioModal();
  if (state.modal === 'nuevo-usuario') return renderNuevoUsuarioModal();
  if (state.modal === 'nuevo-documento' || state.modal === 'editar-documento') return renderDocumentoModal();
  if (state.modal === 'agendar-servicio') return renderAgendarServicioModal();
  if (state.modal === 'detalle-cita') return renderDetalleCitaModal();
  if (state.modal === 'detalle-servicio-tecnico') return renderDetalleServicioTecnicoModal();
  if (state.modal === 'nuevo-servicio-tecnico') return renderNuevoServicioTecnicoModal();
  if (state.modal === 'catalogo-costo') return renderCatalogoCostoModal();
  if (state.modal === 'nuevo-ticket-cliente') return renderNuevoTicketClienteModal();
  if (state.modal === 'nuevo-documento-edificio') return renderNuevoDocumentoEdificioModal();
  if (state.modal === 'nuevo-proveedor') return renderNuevoProveedorModal();
  if (state.modal === 'nuevo-proveedor-cliente') return renderNuevoProveedorClienteModal();
  if (state.modal === 'fusionar-ticket') return renderFusionarTicketModal();
  if (state.modal === 'firma-servicio') return renderModalFirmaServicio();
  if (state.modal === 'reprogramar-servicio') return renderReprogramarServicioModal();
  if (state.modal === 'reporte-mensual-servicios') return renderReporteMensualServiciosModal();
  if (state.modal === 'detalle-reserva-calendario') return renderDetalleReservaCalendarioModal();
  if (state.modal === 'reprogramar-reserva') return renderReprogramarReservaModal();
  return '';
}
function renderDocumentoModal() {
  const editing = state.modal === 'editar-documento';
  const d = editing ? cache.documentosLegales.find(x => x.id === state.editDocumentoId) : null;
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal" style="max-width:640px;">
    <h2>${editing ? 'Editar documento' : 'Nuevo documento'}</h2>
    <p class="sub">Este texto se le muestra al cliente para que lo lea y acepte con firma electrónica al responder un ticket.</p>
    <form onsubmit="return submitDocumento(event)">
      <div class="field"><label>Nombre</label><input name="nombre" value="${d ? escapeHtml(d.nombre) : ''}" placeholder="Ej: Descargo de Responsabilidad — Entrega de grabaciones CCTV" required></div>
      <div class="field"><label>Contenido</label><textarea name="texto" style="min-height:260px;" required>${d ? escapeHtml(d.texto) : ''}</textarea></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:16px;"><input type="checkbox" name="activo" ${!d || d.activo ? 'checked' : ''}> Documento activo (disponible para elegir al responder)</label>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">${editing ? 'Guardar cambios' : 'Crear documento'}</button></div>
    </form>
  </div></div>`;
}

function renderAceptacionesTicket(t) {
  const lista = t.aceptaciones || [];
  if (!lista.length) return '';
  return `<div class="card" style="margin-bottom:18px;">
    <div style="font-weight:600;font-size:13.5px;margin-bottom:10px;">Documentos enviados para firma</div>
    ${lista.map(a => {
      if (a.estado === 'aceptado') {
        const fecha = fmtDateTime(a.fecha_aceptacion);
        return `<div style="padding:10px 0;border-bottom:1px dashed var(--line-strong);">
          <div><span class="tag tag-resuelto">✅ Aceptado</span> <strong>${escapeHtml(a.documento_nombre)}</strong></div>
          <div class="hint-text" style="margin-top:6px;">Firmado por <strong>${escapeHtml(a.nombre_solicitante || '')}</strong> el ${fecha} · IP: ${escapeHtml(a.ip_aceptante || '—')}</div>
          ${a.motivo_solicitud ? `<div class="hint-text">Motivo: ${escapeHtml(a.motivo_solicitud)}</div>` : ''}
          ${a.descripcion_material ? `<div class="hint-text">Material: ${escapeHtml(a.descripcion_material)}</div>` : ''}
        </div>`;
      }
      return `<div style="padding:10px 0;border-bottom:1px dashed var(--line-strong);">
        <div><span class="tag tag-en-progreso">⏳ Pendiente</span> <strong>${escapeHtml(a.documento_nombre)}</strong></div>
        <div class="hint-text" style="margin-top:6px;">Todavía no fue aceptado por el cliente.</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderNuevoTicketClienteModal() {
  const multiEdificio = cache.edificiosCliente.length > 1;
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>Nuevo ticket</h2><p class="sub">Contanos qué necesitás y, si hace falta, adjuntá fotos o un video.</p>
    <form onsubmit="return submitNuevoTicketCliente(event)">
      ${multiEdificio ? `<div class="field"><label>Edificio</label><select name="edificioClienteId" required><option value="" disabled selected>Elegí para qué edificio es</option>${cache.edificiosCliente.map(e => `<option value="${e.id}">${escapeHtml(e.nombre)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Asunto</label><input name="asunto" placeholder="Ej: Cámara del garage sin imagen" required></div>
      <div class="field"><label>Descripción</label><textarea name="cuerpo" placeholder="Contanos con el mayor detalle posible qué está pasando…" required></textarea></div>
      <div class="field"><label>Adjuntar fotos o video (opcional)</label><input type="file" multiple accept="image/*,video/*,application/pdf" onchange="addPendingAttachments(this)"><div class="hint-text">Imágenes, PDF o video, máx. 20 MB.</div><div id="pending-attachments">${renderPendingChips()}</div></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">Crear ticket</button></div>
    </form></div></div>`;
}
function renderNuevoCorreoModal() {
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>Simular correo entrante</h2><p class="sub">Crea un ticket nuevo como si llegara a ${cache.configuracion.casillaEmail ? `<strong>${escapeHtml(cache.configuracion.casillaEmail)}</strong>` : 'la casilla de soporte'}.</p>
    <form onsubmit="return submitNuevoCorreo(event)">
      <div class="field-row"><div class="field"><label>Nombre del remitente</label><input name="remitenteNombre" required></div><div class="field"><label>Correo del remitente</label><input name="remitenteEmail" type="email" required></div></div>
      <div class="field"><label>Asunto</label><input name="asunto" required></div>
      <div class="field"><label>Mensaje</label><textarea name="cuerpo" required></textarea></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">Crear ticket</button></div>
    </form></div></div>`;
}
function renderRespuestaModal() {
  const editing = state.modal === 'editar-respuesta';
  const c = editing ? cache.respuestas.find(x => x.id === state.editRespuestaId) : null;
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>${editing ? 'Editar respuesta' : 'Nueva respuesta predefinida'}</h2>
    <form onsubmit="return submitRespuesta(event)">
      <div class="field"><label>Título</label><input name="titulo" value="${c ? escapeHtml(c.titulo) : ''}" required></div>
      <div class="field"><label>Contenido</label><textarea name="cuerpo" required>${c ? escapeHtml(c.cuerpo) : ''}</textarea></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">${editing ? 'Guardar cambios' : 'Crear respuesta'}</button></div>
    </form></div></div>`;
}
// Qué puede elegirse como "padre" (Administrado por) depende del Rol elegido: un Apartamento cuelga
// de un Edificio, y cualquier otro rol (Edificio, etc.) cuelga de una Administración. Se usa tanto
// para armar el select la primera vez como para recalcularlo cuando cambia el Rol (onchange), así
// nunca se mezclan edificios y administraciones en la misma lista.
function opcionesAdministradoPorHtml(rolSeleccionado, excludeId, selectedId) {
  const rolPadre = rolSeleccionado === 'Apartamento' ? 'Edificio' : 'Administración';
  const candidatos = cache.clientes.filter(c => c.rolCliente === rolPadre && c.id !== excludeId);
  const vacio = rolSeleccionado === 'Apartamento' ? 'Ninguno (no depende de un edificio)' : 'Ninguno (cliente independiente)';
  return `<option value="">${vacio}</option>${candidatos.map(c => `<option value="${c.id}" ${selectedId === c.id ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`).join('')}`;
}
function actualizarAdministradoPorSegunRol() {
  const rolSelect = document.getElementById('grupo-rol-select');
  const administradoSelect = document.getElementById('grupo-administrado-por-select');
  if (!rolSelect || !administradoSelect) return;
  administradoSelect.innerHTML = opcionesAdministradoPorHtml(rolSelect.value, state.editGrupoId, null);
}
function renderGrupoModal() {
  const editing = state.modal === 'editar-grupo';
  const g = editing ? cache.clientes.find(x => x.id === state.editGrupoId) : null;
  const rolOptions = CAT.ROLES_CLIENTE.map(r => `<option value="${r}" ${g && g.rol === r ? 'selected' : ''}>${r}</option>`).join('');
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>${editing ? 'Editar cliente' : 'Nuevo cliente'}</h2>
    <form onsubmit="return submitGrupo(event)">
      <div class="field"><label>Nombre de cliente</label><input name="nombre" value="${g ? escapeHtml(g.nombre) : ''}" required></div>
      <div class="field"><label>Dirección</label><input name="direccion" value="${g ? escapeHtml(g.direccion || '') : ''}"></div>
      <div class="field"><label>Correo electrónico</label><input name="correo" type="email" value="${g ? escapeHtml(g.correo || '') : ''}"></div>
      <div class="field"><label>Rol</label><select name="rolCliente" id="grupo-rol-select" onchange="actualizarAdministradoPorSegunRol()"><option value="" ${!g || !g.rolCliente ? 'selected' : ''}>Sin especificar</option>${CAT.ROLES_CLIENTE.map(r => `<option value="${r}" ${g && g.rolCliente === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <div class="field"><label>Administrado por</label>
        <select name="administradoPorId" id="grupo-administrado-por-select">${opcionesAdministradoPorHtml(g ? g.rolCliente : '', g ? g.id : null, g ? g.administradoPorId : null)}</select>
        <div class="hint-text">Si este cliente es un edificio que gestiona una administración, elegila acá; si es un apartamento, elegí a qué edificio pertenece. La lista cambia según el Rol de arriba.</div></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin:12px 0 4px;padding-top:12px;border-top:1px dashed var(--line-strong);"><input type="checkbox" name="esMantenimiento" ${g && g.esMantenimiento ? 'checked' : ''}> 🔧 Cliente de mantenimiento</label>
      <div class="hint-text" style="margin-bottom:8px;">Tiene un contrato de visitas periódicas de mantenimiento (se configura desde la ficha del cliente una vez creado).</div>
      <div style="font-weight:600;font-size:13.5px;margin:12px 0 8px;padding-top:12px;border-top:1px dashed var(--line-strong);">Datos de contacto</div>
      <div class="field-row"><div class="field"><label>Nombre</label><input name="contactoNombre" value="${g ? escapeHtml(g.contactoNombre || '') : ''}"></div><div class="field"><label>Teléfono</label><input name="telefono" value="${g ? escapeHtml(g.telefono || '') : ''}"></div></div>
      <div class="field"><label>Rol</label><select name="rol" required><option value="" disabled ${!g ? 'selected' : ''}>Elegí un rol</option>${rolOptions}</select></div>
      <div class="field" style="margin-top:6px;padding-top:14px;border-top:1px dashed var(--line-strong);"><label>Acceso al portal (contraseña)</label>
        <input name="portalPassword" type="password" placeholder="${editing ? 'Dejar en blanco para no cambiarla' : 'Definí una contraseña de acceso'}" autocomplete="new-password">
        <div class="hint-text">Con el correo de arriba y esta contraseña, el cliente entra al portal a ver sus tickets.</div></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">${editing ? 'Guardar cambios' : 'Crear cliente'}</button></div>
    </form></div></div>`;
}
function renderAutomatizacionModal() {
  const editing = state.modal === 'editar-automatizacion';
  const a = editing ? cache.automatizaciones.find(x => x.id === state.editAutomatizacionId) : null;
  if (!cache.respuestas.length) {
    return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal"><h2>Necesitás una respuesta predefinida primero</h2>
      <p class="sub">Creá al menos una en "Respuestas" antes de armar la cadena.</p><div class="modal-actions"><button type="button" class="btn btn-primary" onclick="closeModal()">Entendido</button></div></div></div>`;
  }
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal" style="max-width:560px;">
    <h2>${editing ? 'Editar automatización' : 'Nueva automatización'}</h2>
    <p class="sub">Cada paso responde solo, espera la próxima respuesta del cliente y ahí se dispara el siguiente.</p>
    <form onsubmit="return submitAutomatizacion(event)">
      <div class="field"><label>Nombre</label><input name="nombre" value="${a ? escapeHtml(a.nombre) : ''}" required></div>
      <div id="pasos-container">${renderPasosEditor()}</div>
      <button type="button" class="btn btn-ghost btn-block" style="margin-bottom:16px;" onclick="agregarPasoEditor()">+ Agregar paso a la cadena</button>
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:16px;"><input type="checkbox" name="activo" ${!a || a.activo ? 'checked' : ''}> Automatización activa</label>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button type="submit" class="btn btn-primary">${editing ? 'Guardar cambios' : 'Crear automatización'}</button></div>
    </form></div></div>`;
}

/* ---------------- Portal de cliente ---------------- */

function navItemsCliente(activeView) {
  const items = [
    { v: 'cliente-dashboard', label: 'Mis tickets', ico: '&#9776;' },
    { v: 'cliente-documentos', label: 'Documentos', ico: '&#128193;' },
    // Por ahora solo lo ve una cuenta con rol "Administración" (puede cargar proveedores para los
    // edificios que administra).
    ...(cache.perfilCliente && cache.perfilCliente.rol_cliente === 'Administración' ? [{ v: 'cliente-proveedores', label: 'Proveedores y Servicios', ico: '&#128295;' }] : []),
    { v: 'cliente-perfil', label: 'Mi perfil', ico: '&#9998;' }
  ];
  const activo = (v) => v === activeView || (v === 'cliente-dashboard' && activeView === 'cliente-ticket');
  return items.map(it => `<button class="nav-btn ${activo(it.v) ? 'active' : ''}" onclick="goCliente('${it.v}')"><span class="ico">${it.ico}</span><span>${it.label}</span></button>`).join('');
}
function renderClientShell(inner) {
  const g = currentGrupo();
  return `<div class="shell">
    <aside class="sidebar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div>
      <nav>${navItemsCliente(state.view)}</nav>
      <div class="sidebar-foot"><div class="who"><strong>${escapeHtml(g.nombre)}</strong>Portal de cliente</div><button class="nav-btn" onclick="logout()"><span class="ico">&#8630;</span><span>Cerrar sesión</span></button></div>
    </aside>
    <div class="main"><div class="topbar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div><button class="nav-btn" style="color:#fff" onclick="logout()">Salir</button></div>
      <div class="content">${inner}</div>
      <div class="bottomnav">${navItemsCliente(state.view)}</div>
    </div></div>
  ${renderActiveModal()}
  ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}`;
}
function clienteResumenStyleTag() {
  if (document.getElementById('cliente-resumen-style-v2')) return '';
  return `<style id="cliente-resumen-style-v2">
    .cliente-resumen{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px;}
    .cliente-resumen-card{
      position:relative;display:flex;align-items:center;gap:12px;background:var(--card);
      border:1px solid var(--line);border-radius:14px;padding:16px 18px;overflow:hidden;
      box-shadow:0 1px 2px rgba(15,42,77,.04),0 6px 16px -8px rgba(15,42,77,.18);
      transition:transform .15s ease,box-shadow .15s ease;
    }
    .cliente-resumen-card:hover{transform:translateY(-3px);box-shadow:0 2px 4px rgba(15,42,77,.06),0 14px 26px -10px rgba(15,42,77,.26);}
    .cliente-resumen-card::after{content:'';position:absolute;inset:0;border-radius:14px;pointer-events:none;
      background:linear-gradient(160deg,rgba(255,255,255,.35),rgba(255,255,255,0) 45%);}
    :root[data-theme="dark"] .cliente-resumen-card::after{background:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,0) 45%);}
    .cliente-resumen-ico{
      flex:none;width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;
      font-size:19px;box-shadow:inset 0 1px 1px rgba(255,255,255,.4),0 3px 8px -2px rgba(0,0,0,.25);
    }
    .cliente-resumen-ico-total{background:linear-gradient(145deg,#3D7EF0,#1E56C7);}
    .cliente-resumen-ico-resueltos{background:linear-gradient(145deg,#4CAF6E,#2E7D32);}
    .cliente-resumen-ico-curso{background:linear-gradient(145deg,#FFB84D,#E08A00);}
    .cliente-resumen-ico-tiempo{background:linear-gradient(145deg,#8E7CF0,#6247C7);}
    .cliente-resumen-num{font-size:22px;font-weight:700;line-height:1.15;}
    .cliente-resumen-label{font-size:12px;color:var(--ink-soft);margin-top:1px;}
    @media (max-width:480px){.cliente-resumen{grid-template-columns:repeat(2,1fr);}}
  </style>`;
}
// Resumen simple para que el cliente vea de un vistazo cómo le viene funcionando el soporte:
// cuántos tickets tuvo, cuántos ya se resolvieron, y en cuánto tiempo en promedio (aproximado por
// la diferencia entre "creado" y "actualizado" del ticket, que se pisa cada vez que cambia de
// estado, así que en un ticket resuelto queda muy cerca del momento real de resolución).
function renderClienteResumen(tickets) {
  const total = tickets.length;
  if (!total) return '';
  const resueltos = tickets.filter(t => t.estado === 'Resuelto' || t.estado === 'Cerrado');
  const abiertos = total - resueltos.length;
  let promedioTexto = '—';
  if (resueltos.length) {
    const horasProm = resueltos.reduce((acc, t) => acc + (new Date(t.actualizado) - new Date(t.creado)), 0) / resueltos.length / 3600000;
    promedioTexto = horasProm < 24 ? `${Math.max(1, Math.round(horasProm))} h` : `${(horasProm / 24).toFixed(1)} días`;
  }
  const tarjetas = [
    { ico: '&#127919;', clase: 'total', num: total, label: 'Tickets totales' },
    { ico: '&#9989;', clase: 'resueltos', num: resueltos.length, label: 'Resueltos' },
    { ico: '&#9203;', clase: 'curso', num: abiertos, label: 'En curso' },
    { ico: '&#9889;', clase: 'tiempo', num: promedioTexto, label: 'Tiempo prom. de resolución' }
  ];
  return `${clienteResumenStyleTag()}<div class="cliente-resumen">${tarjetas.map(t => `
    <div class="cliente-resumen-card">
      <div class="cliente-resumen-ico cliente-resumen-ico-${t.clase}">${t.ico}</div>
      <div><div class="cliente-resumen-num">${t.num}</div><div class="cliente-resumen-label">${t.label}</div></div>
    </div>`).join('')}</div>`;
}
function renderClienteDashboard() {
  const g = currentGrupo();
  const tickets = [...cache.tickets].sort((a, b) => new Date(b.actualizado) - new Date(a.actualizado));
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t, true)).join('')}</div>` : `<div class="empty-state"><div class="big">Todavía no tenés tickets</div></div>`;
  return `<div class="page-head"><div><h1>Mis tickets</h1><div class="sub">Todos los tickets abiertos a nombre de ${escapeHtml(g.nombre)}</div></div>
    <button class="btn btn-primary" onclick="openNuevoTicketClienteModal()">+ Nuevo ticket</button></div>${renderClienteResumen(tickets)}${list}`;
}
function clienteTicketStyleTag() {
  if (document.getElementById('cliente-ticket-style-v1')) return '';
  return `<style id="cliente-ticket-style-v1">
    .estado-timeline{display:flex;align-items:flex-start;margin-top:18px;padding-top:16px;border-top:1px dashed var(--line-strong);}
    .estado-paso{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none;width:110px;text-align:center;}
    .estado-paso-punto{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;border:2px solid var(--line-strong);color:var(--ink-soft);background:var(--card);}
    .estado-paso-label{font-size:11.5px;font-weight:600;color:var(--ink-soft);}
    .estado-paso-hecho .estado-paso-punto{background:var(--stamp-green);border-color:var(--stamp-green);color:#fff;}
    .estado-paso-hecho .estado-paso-label{color:var(--stamp-green);}
    .estado-paso-activo .estado-paso-punto{background:var(--brand);border-color:var(--brand);color:#fff;box-shadow:0 0 0 4px var(--brand-tint);}
    .estado-paso-activo .estado-paso-label{color:var(--brand);}
    .estado-paso-linea{flex:1;height:2px;background:var(--line-strong);margin-top:14px;min-width:16px;}
    @media (max-width:560px){.estado-paso{width:auto;}.estado-paso-label{font-size:10px;}}
  </style>`;
}
// Traduce el estado real del ticket a un paso (0 a 3) de una línea de tiempo simple, pensada para
// que el cliente entienda de un vistazo en qué anda su ticket sin tener que leer el nombre técnico
// del estado. "Cerrado" se muestra igual que "Resuelto" (para el cliente es lo mismo: ya terminó).
const ESTADO_TIMELINE_PASOS = ['Recibido', 'En progreso', 'Esperando tu respuesta', 'Resuelto'];
function pasoDeEstadoCliente(estado) {
  if (estado === 'En progreso') return 1;
  if (estado === 'Esperando al Cliente') return 2;
  if (estado === 'Resuelto' || estado === 'Cerrado') return 3;
  return 0; // Abierto
}
function renderEstadoTimelineCliente(estado) {
  const actual = pasoDeEstadoCliente(estado);
  const pasos = ESTADO_TIMELINE_PASOS.map((label, i) => {
    const clase = i < actual ? 'hecho' : i === actual ? 'activo' : 'pendiente';
    return `<div class="estado-paso estado-paso-${clase}"><div class="estado-paso-punto">${i < actual ? '✓' : i + 1}</div><div class="estado-paso-label">${label}</div></div>`;
  }).join('<div class="estado-paso-linea"></div>');
  return `<div class="estado-timeline">${pasos}</div>`;
}
function renderClienteTicket(id) {
  const t = cache.tickets.find(x => x.id === id);
  if (!t) return `<button class="back-link" onclick="go('cliente-dashboard')">&larr; Volver</button><div class="empty-state">Cargando…</div>`;
  const thread = renderThreadHtml(t);
  const edificio = cache.edificiosCliente.length > 1 ? cache.edificiosCliente.find(e => e.id === t.grupoId) : null;
  return `${clienteTicketStyleTag()}<button class="back-link" onclick="go('cliente-dashboard')">&larr; Volver a mis tickets</button>
    <div class="ticket-head"><div class="ticket-head-top"><div><div class="ticket-num-big">${t.numero}</div><h1>${escapeHtml(t.asunto)}</h1>
      <div class="ticket-from">${edificio ? `Edificio: <strong>${escapeHtml(edificio.nombre)}</strong> · ` : ''}Categoría: ${escapeHtml(t.categoria)} · Prioridad: ${t.prioridad} · Creado ${fmtDateTime(t.creado)}</div></div>
      <div class="stamp stamp-${slug(t.estado)}">${t.estado}</div></div>
      ${renderEstadoTimelineCliente(t.estado)}</div>
    ${renderPresupuestosClienteTicket(t)}
    <div class="thread">${thread}</div>
    <div class="reply-box"><form onsubmit="return submitClienteReply(event, '${t.id}')">
      <div class="field" style="margin-bottom:0;"><textarea name="cuerpo" placeholder="Escribí tu respuesta…" required></textarea></div>
      <div class="field" style="margin-top:12px;"><label>Adjuntar fotos o video (opcional)</label><input type="file" multiple accept="image/*,video/*,application/pdf" onchange="addPendingAttachments(this)"><div class="hint-text">Imágenes, PDF o video, máx. 20 MB.</div><div id="pending-attachments">${renderPendingChips()}</div></div>
      <div class="reply-actions"><button type="submit" class="btn btn-primary">Enviar respuesta</button></div>
    </form></div>`;
}
// Presupuestos de servicio técnico que el equipo ya envió sobre este ticket: costos, archivos
// adjuntos, y el botón para dar conformidad (obligatorio antes de que se avance con la tarea).
function renderPresupuestosClienteTicket(t) {
  const servicios = (t.serviciosTecnicos || []).filter(s => s.presupuesto_enviado);
  if (!servicios.length) return '';
  return servicios.map(s => {
    const costos = s.costos || [];
    const adjuntos = s.presupuesto_adjuntos || [];
    return `<div class="card card-narrow" style="max-width:560px;margin:14px 0;">
      ${configSectionHead('📋', `Presupuesto — ${escapeHtml(s.titulo)}`, 'Revisá el detalle y dá tu conformidad para que podamos avanzar con la tarea.')}
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
        ${costos.length ? costos.map(c => `<div style="display:flex;justify-content:space-between;font-size:13.5px;border-bottom:1px dashed var(--line);padding-bottom:6px;"><span>${escapeHtml(c.descripcion)} x${c.cantidad}</span><strong>${c.moneda} ${Math.round(Number(c.cantidad) * Number(c.precio_unitario))}${s.aplica_iva !== false ? ' <span style="font-weight:400;color:var(--ink-soft);">+ IVA</span>' : ''}</strong></div>`).join('') : ''}
      </div>
      <div style="margin-bottom:10px;">${renderTotalesPorMoneda(costos, s.aplica_iva !== false)}</div>
      ${adjuntos.length ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">${adjuntos.map(a => `<a href="/api/servicios-tecnicos/${s.id}/presupuesto/${a.id}/descargar" target="_blank" rel="noopener" class="btn btn-ghost" style="width:fit-content;">${attachIcon(tipoAdjunto(a.mime || ''))} ${escapeHtml(a.nombre)}</a>`).join('')}</div>` : ''}
      ${s.presupuesto_aprobado
        ? `<div class="tag tag-resuelto">✅ Diste tu conformidad${s.presupuesto_aprobado_fecha ? ' el ' + fmtDateTime(s.presupuesto_aprobado_fecha) : ''}</div>`
        : `<button type="button" class="btn btn-primary" onclick="aprobarPresupuestoCliente('${s.id}')">✅ Dar conformidad con este presupuesto</button>`}
    </div>`;
  }).join('');
}
async function aprobarPresupuestoCliente(servicioId) {
  if (!confirm('¿Confirmás que das conformidad con este presupuesto? El equipo va a poder avanzar con la tarea.')) return;
  try {
    const t = await api('POST', `/api/portal/servicios/${servicioId}/aprobar`);
    const idx = cache.tickets.findIndex(x => x.id === t.id);
    const mapeado = mapTicket(t);
    if (idx >= 0) cache.tickets[idx] = mapeado; else cache.tickets.push(mapeado);
    showToast('¡Gracias! Ya avisamos al equipo.');
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Auth screens ---------------- */

// Estilos + fondo animado de las pantallas de auth: se inyectan una sola vez, sin tocar index.html,
// así este rediseño se puede sacar borrando este bloque y authStyleTag()/authBgHtml() de abajo.
function authStyleTag() {
  if (document.getElementById('auth-style-v2')) return '';
  return `<style id="auth-style-v2">
    .auth-wrap{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden;background:linear-gradient(160deg,#0A1830 0%,#0F2A4D 45%,#132F5C 100%);}
    .auth-bg-anim{position:absolute;inset:0;overflow:hidden;z-index:0;}
    .auth-blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.55;animation:authBlobFloat 18s ease-in-out infinite;}
    .auth-blob-1{width:420px;height:420px;background:radial-gradient(circle,#3D7EF0,transparent 70%);top:-120px;left:-100px;animation-duration:22s;}
    .auth-blob-2{width:360px;height:360px;background:radial-gradient(circle,#8B5CF6,transparent 70%);bottom:-100px;right:-80px;animation-duration:26s;animation-delay:-6s;}
    .auth-blob-3{width:280px;height:280px;background:radial-gradient(circle,#1E9E7C,transparent 70%);bottom:20%;left:8%;animation-duration:20s;animation-delay:-11s;}
    @keyframes authBlobFloat{0%,100%{transform:translate(0,0) scale(1);}33%{transform:translate(30px,-40px) scale(1.08);}66%{transform:translate(-25px,25px) scale(.95);}}
    .auth-grid-overlay{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:42px 42px;mask-image:radial-gradient(ellipse at center,#000 0%,transparent 75%);}
    @media (prefers-reduced-motion: reduce){.auth-blob{animation:none;}}

    .auth-card{position:relative;z-index:1;width:100%;max-width:400px;background:rgba(255,255,255,.9);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.5);border-radius:20px;box-shadow:0 25px 60px -15px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.04);padding:0;overflow:hidden;animation:authCardIn .55s cubic-bezier(.2,.9,.25,1);}
    @keyframes authCardIn{from{opacity:0;transform:translateY(18px) scale(.98);}to{opacity:1;transform:translateY(0) scale(1);}}
    .auth-card-brand{position:relative;background:linear-gradient(135deg,#0F2A4D 0%,#1B3F73 60%,#264d8f 100%);padding:26px 28px;display:flex;justify-content:center;align-items:center;overflow:hidden;}
    .auth-card-brand::after{content:'';position:absolute;inset:0;background:linear-gradient(120deg,transparent 30%,rgba(255,255,255,.12) 50%,transparent 70%);background-size:220% 100%;animation:authSheen 5s ease-in-out infinite;}
    @keyframes authSheen{0%{background-position:150% 0;}100%{background-position:-50% 0;}}
    .auth-card-brand img{position:relative;z-index:1;height:36px;width:auto;max-width:100%;display:block;}
    .auth-card-body{padding:34px 30px 30px;}
    .auth-card h1{font-family:var(--font-display);font-size:23px;font-weight:600;margin:0 0 4px;letter-spacing:.01em;}
    .auth-card .sub{color:var(--ink-soft);font-size:13.5px;margin:0 0 24px;}
    .auth-field-icon{position:relative;}
    .auth-field-icon svg{position:absolute;left:12px;top:38px;width:16px;height:16px;color:var(--ink-soft);opacity:.7;pointer-events:none;}
    .auth-field-icon input{padding-left:36px !important;}
    .field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--brand-2);box-shadow:0 0 0 4px rgba(61,126,240,.15);}
    .field input,.field select,.field textarea{transition:box-shadow .15s ease,border-color .15s ease;}
    .auth-card .btn-primary{background:linear-gradient(135deg,var(--brand) 0%,#2E6BE0 55%,#3D7EF0 100%);box-shadow:0 8px 20px -6px rgba(30,86,199,.55);transition:transform .15s ease,box-shadow .15s ease,filter .15s ease;}
    .auth-card .btn-primary:hover{transform:translateY(-1px);box-shadow:0 12px 26px -6px rgba(30,86,199,.65);filter:brightness(1.05);}
    .auth-card .btn-primary:active{transform:translateY(0);}
    .auth-toggle{text-align:center;margin-top:16px;font-size:13.5px;color:var(--ink-soft);} .auth-toggle button{background:none;border:none;color:var(--brand);font-weight:600;padding:0;font-size:13.5px;}
    @media (max-width:480px){.auth-blob{filter:blur(40px);}}
  </style>`;
}
function authBgHtml() {
  return `<div class="auth-bg-anim"><div class="auth-blob auth-blob-1"></div><div class="auth-blob auth-blob-2"></div><div class="auth-blob auth-blob-3"></div><div class="auth-grid-overlay"></div></div>`;
}
const icoMail = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6 8.5 7 8.5-7"/></svg>`;
const icoLock = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`;
function renderAuth() {
  const mode = state.authView || 'login';
  if (mode === 'login') {
    return `${authStyleTag()}<div class="auth-wrap">${authBgHtml()}<div class="auth-card">
      <div class="auth-card-brand">${logoSvg('white')}</div>
      <div class="auth-card-body">
      <h1>Iniciar sesión</h1><p class="sub">Accedé con tu correo y contraseña.</p>
      <form onsubmit="return handleLogin(event)">
        <div class="field auth-field-icon">${icoMail}<label>Correo electrónico</label><input name="email" type="email" required></div>
        <div class="field auth-field-icon">${icoLock}<label>Contraseña</label><input name="password" type="password" required></div>
        ${state.authError ? `<div class="error-text">${escapeHtml(state.authError)}</div>` : ''}
        <button type="submit" class="btn btn-primary btn-block">Ingresar</button>
      </form>
      <div class="auth-toggle">¿No tenés cuenta? <button onclick="goAuth('register-choice')">Registrate</button></div>
      </div>
    </div></div>`;
  }
  if (mode === 'register-choice') {
    return `${authStyleTag()}<div class="auth-wrap">${authBgHtml()}<div class="auth-card">
      <div class="auth-card-brand">${logoSvg('white')}</div>
      <div class="auth-card-body">
      <h1>Crear cuenta</h1><p class="sub">Contanos primero quién sos, así te llevamos al formulario correcto.</p>
      <button type="button" class="btn btn-primary btn-block" style="margin-bottom:12px;" onclick="goAuth('register-cliente')">Soy cliente</button>
      <div class="hint-text" style="margin:-6px 0 14px;">Para ver tus tickets y responder consultas del servicio técnico.</div>
      <button type="button" class="btn btn-ghost btn-block" onclick="goAuth('register')">Soy empleado de Borcam</button>
      <div class="hint-text" style="margin-top:6px;">Para gestionar tickets desde la plataforma interna.</div>
      <div class="auth-toggle">¿Ya tenés cuenta? <button onclick="goAuth('login')">Iniciar sesión</button></div>
      </div>
    </div></div>`;
  }
  if (mode === 'register-cliente') {
    const rolOptions = (CAT.ROLES_CLIENTE && CAT.ROLES_CLIENTE.length ? CAT.ROLES_CLIENTE : ['Administración', 'Integrante de Comisión', 'Intendente', 'Edificio', 'Apartamento']).map(r => `<option value="${r}">${r}</option>`).join('');
    return `${authStyleTag()}<div class="auth-wrap">${authBgHtml()}<div class="auth-card">
    <div class="auth-card-brand">${logoSvg('white')}</div>
    <div class="auth-card-body">
    <h1>Crear cuenta de cliente</h1><p class="sub">Registrate para ver y responder tus tickets desde el portal.</p>
    <form onsubmit="return handleRegisterCliente(event)">
      <div class="field"><label>Nombre</label><input name="nombre" required></div>
      <div class="field"><label>Dirección</label><input name="direccion"></div>
      <div class="field-row"><div class="field"><label>Teléfono</label><input name="telefono"></div><div class="field"><label>Correo electrónico</label><input name="correo" type="email" required></div></div>
      <div class="field"><label>Rol</label><select name="rol" required><option value="" disabled selected>Elegí un rol</option>${rolOptions}</select></div>
      <div class="field-row"><div class="field"><label>Contraseña</label><input name="password" type="password" required></div><div class="field"><label>Repetir contraseña</label><input name="password2" type="password" required></div></div>
      ${state.regError ? `<div class="error-text">${escapeHtml(state.regError)}</div>` : ''}
      <button type="submit" class="btn btn-primary btn-block">Crear cuenta</button>
    </form>
    <div class="auth-toggle"><button onclick="goAuth('register-choice')">&larr; Volver</button> · ¿Ya tenés cuenta? <button onclick="goAuth('login')">Iniciar sesión</button></div>
    </div>
  </div></div>`;
  }
  return `${authStyleTag()}<div class="auth-wrap">${authBgHtml()}<div class="auth-card">
    <div class="auth-card-brand">${logoSvg('white')}</div>
    <div class="auth-card-body">
    <h1>Crear cuenta de empleado</h1><p class="sub">Registrate para gestionar tickets.</p>
    <form onsubmit="return handleRegister(event)">
      <div class="field-row"><div class="field"><label>Nombre</label><input name="nombre" required></div><div class="field"><label>Apellido</label><input name="apellido" required></div></div>
      <div class="field"><label>Teléfono</label><input name="telefono"></div>
      <div class="field"><label>Correo electrónico</label><input name="email" type="email" required></div>
      <div class="field"><label>Cargo</label><select name="cargo" required><option value="" disabled selected>Elegí un cargo</option>${(CAT.CARGOS.length ? CAT.CARGOS : ['Técnico', 'Encargado', 'Administrativo', 'Director']).map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
      <div class="field-row"><div class="field"><label>Contraseña</label><input name="password" type="password" required></div><div class="field"><label>Repetir contraseña</label><input name="password2" type="password" required></div></div>
      ${state.regError ? `<div class="error-text">${escapeHtml(state.regError)}</div>` : ''}
      <button type="submit" class="btn btn-primary btn-block">Crear cuenta</button>
    </form>
    <div class="auth-toggle"><button onclick="goAuth('register-choice')">&larr; Volver</button> · ¿Ya tenés cuenta? <button onclick="goAuth('login')">Iniciar sesión</button></div>
    </div>
  </div></div>`;
}

/* ---------------- Master render ---------------- */

function render() {
  const app = document.getElementById('app');
  if (!session) { app.innerHTML = renderAuth(); return; }
  if (session.type === 'cliente') {
    let inner;
    if (state.view === 'cliente-ticket' && state.ticketId) inner = renderClienteTicket(state.ticketId);
    else if (state.view === 'cliente-documentos') inner = renderClienteDocumentos();
    else if (state.view === 'cliente-proveedores') inner = renderClienteProveedores();
    else if (state.view === 'cliente-perfil') inner = renderClientePerfil();
    else inner = renderClienteDashboard();
    app.innerHTML = renderClientShell(inner);
    return;
  }
  let inner = '';
  if (state.view === 'ticket' && state.ticketId) inner = renderTicket(state.ticketId);
  else if (state.view === 'perfil') inner = renderPerfil();
  else if (state.view === 'usuarios') inner = renderUsuarios();
  else if (state.view === 'respuestas') inner = renderRespuestas();
  else if (state.view === 'grupos') inner = renderGrupos();
  else if (state.view === 'reservas') { inner = renderReservas(); cargarReservasCalendario().then(() => { if (state.view === 'reservas') refrescarVistaReservas(); }); }
  else if (state.view === 'documentos') inner = renderDocumentos();
  else if (state.view === 'documentos-edificio') inner = renderDocumentosEdificio();
  else if (state.view === 'grupo') { inner = '<div class="empty-state">Cargando…</div>'; renderGrupoDetailAsync(state.grupoId).then(html => { const el = document.querySelector('.content'); if (el && state.view === 'grupo') el.innerHTML = html; }); }
  else if (state.view === 'calendario') { inner = '<div class="empty-state">Cargando…</div>'; renderCalendarioAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'calendario') el.innerHTML = html; }); }
  else if (state.view === 'servicio-tecnico') { inner = '<div class="empty-state">Cargando…</div>'; renderServicioTecnicoModuloAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'servicio-tecnico') el.innerHTML = html; }); }
  else if (state.view === 'automatizaciones') inner = renderAutomatizaciones();
  else if (state.view === 'newsletter') inner = renderNewsletter();
  else if (state.view === 'estadisticas') inner = renderEstadisticas();
  else if (state.view === 'tags') { inner = '<div class="empty-state">Cargando…</div>'; renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } }); }
  else if (state.view === 'configuracion') inner = renderConfiguracion();
  else inner = renderDashboard();
  app.innerHTML = renderShell(inner);
}

boot();
