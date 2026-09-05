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
let cache = { tickets: [], usuarios: [], clientes: [], respuestas: [], automatizaciones: [], configuracion: {} };
let CAT = { ESTADOS: [], CATEGORIAS: [], PRIORIDADES: [], CARGOS: [], ROLES_CLIENTE: [] };
let state = {
  view: 'login', authView: 'login', ticketId: null,
  filters: { estado: 'todos', categoria: 'todas', prioridad: 'todas', grupo: 'todos', agente: 'todos', fecha: '', search: '' },
  replyTab: 'saliente', authError: '', regError: '', modal: null, toast: null,
  pendingAttachments: [], editandoPasos: [], editAutomatizacionId: null, editGrupoId: null, selectedTickets: new Set(), paginaTickets: 1,
  filtersReservas: { estado: 'todos', prioridad: 'todas', search: '' }, paginaReservas: 1,
  newsletterDestinatarios: [], newsletterAdjuntos: [],
  reportes: null, reportesCargando: false, reportesUsuario: 'todos', reportesRango: 'este-mes',
  reportesDesde: '', reportesHasta: ''
};

function uid() { return 'tmp-' + Math.random().toString(36).slice(2, 10); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDateTime(iso) { return new Date(iso).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function fmtRel(iso) { const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'ahora'; if (m < 60) return m + ' min'; const h = Math.floor(m / 60); if (h < 24) return h + ' h'; return Math.floor(h / 24) + ' d'; }
function slug(s) { return s.toLowerCase().replace(/\s+/g, '-'); }
function initials(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase(); }
function showToast(msg) { state.toast = msg; render(); setTimeout(() => { state.toast = null; render(); }, 2600); }

function mapTicket(row) {
  return {
    id: row.id, numero: row.numero, asunto: row.asunto, categoria: row.categoria, prioridad: row.prioridad, estado: row.estado,
    remitenteNombre: row.remitente_nombre, remitenteEmail: row.remitente_email,
    asignadoA: row.asignado_a, grupoId: row.cliente_id, creado: row.creado, actualizado: row.actualizado,
    necesitaAtencion: !!row.necesita_atencion,
    mensajes: (row.mensajes || []).map(mapMensaje),
    serviciosTecnicos: row.serviciosTecnicos || [],
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
      const idDesdeUrl = new URLSearchParams(window.location.search).get('ticket');
      if (idDesdeUrl) { state.view = 'ticket'; state.ticketId = idDesdeUrl; }
    } else if (r.session && r.session.type === 'cliente') {
      session = r.session; state.view = 'cliente-dashboard'; await loadClienteTickets();
    }
  } catch (e) {}
  render();
  if (state.view === 'ticket' && state.ticketId) refreshTicket(state.ticketId).then(render);
}

async function loadStaffData() {
  const [tickets, usuarios, clientes, respuestas, automatizaciones, configuracion, catalogos, documentosLegales] = await Promise.all([
    api('GET', '/api/tickets'), api('GET', '/api/usuarios'), api('GET', '/api/clientes'),
    api('GET', '/api/respuestas'), api('GET', '/api/automatizaciones'), api('GET', '/api/configuracion'),
    api('GET', '/api/catalogos'), api('GET', '/api/documentos-legales')
  ]);
  cache.tickets = tickets.map(mapTicket);
  cache.usuarios = usuarios;
  cache.clientes = clientes.map(c => ({ id: c.id, nombre: c.nombre, direccion: c.direccion, telefono: c.telefono, correo: c.correo, rol: c.rol, contactoNombre: c.contacto_nombre, rolCliente: c.rol_cliente, tienePortal: c.tiene_portal }));
  cache.respuestas = respuestas;
  cache.automatizaciones = automatizaciones.map(a => ({ id: a.id, nombre: a.nombre, activo: a.activo, pasos: a.pasos.map(p => ({ id: p.id, matchAny: p.match_any, palabras: p.palabras || [], respuestaId: p.respuesta_id, accionEstado: p.accion_estado, soloNuevoTicket: !!p.solo_nuevo_ticket })) }));
  cache.configuracion = configuracion;
  cache.documentosLegales = documentosLegales;
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
    if (r.type === 'staff') { state.view = 'dashboard'; await loadStaffData(); }
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
  session = null; state.view = 'login'; state.authView = 'login';
  cache = { tickets: [], usuarios: [], clientes: [], respuestas: [], automatizaciones: [], configuracion: {} };
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
    .filter(t => { if (!f.search) return true; const s = f.search.toLowerCase(); return t.asunto.toLowerCase().includes(s) || t.numero.toLowerCase().includes(s) || t.remitenteNombre.toLowerCase().includes(s) || t.remitenteEmail.toLowerCase().includes(s); })
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

function openNuevoCorreoModal() { state.modal = 'nuevo-correo'; render(); }
function closeModal() { state.modal = null; state.editandoPasos = []; state.editandoServicioTecnicoId = null; render(); }

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
  const payload = { nombre: fd.get('nombre'), direccion: fd.get('direccion'), telefono: fd.get('telefono'), correo: fd.get('correo'), rol: fd.get('rol'), contactoNombre: fd.get('contactoNombre'), rolCliente: fd.get('rolCliente'), portalPassword: (fd.get('portalPassword') || '').trim() };
  try {
    if (state.modal === 'editar-grupo') await api('PUT', '/api/clientes/' + state.editGrupoId, payload);
    else await api('POST', '/api/clientes', payload);
    cache.clientes = (await api('GET', '/api/clientes')).map(c => ({ id: c.id, nombre: c.nombre, direccion: c.direccion, telefono: c.telefono, correo: c.correo, rol: c.rol, contactoNombre: c.contacto_nombre, rolCliente: c.rol_cliente, tienePortal: c.tiene_portal }));
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
    { v: 'domotica', label: '🏠 Domótica' },
    { v: 'servicio-tecnico', label: '🛠️ Servicio Técnico' }
  ].map(s => `<button class="reply-tab ${subTab === s.v ? 'active' : ''}" type="button" onclick="cambiarCalendarioSubTab('${s.v}')">${s.label}</button>`).join('');

  const tab = state.calendarioTab || 'turnos';
  const tabsHtml = [
    { v: 'turnos', label: 'Próximos turnos' },
    { v: 'realizados', label: 'Agenda realizada' }
  ].map(t => `<button class="reply-tab ${tab === t.v ? 'active' : ''}" type="button" onclick="cambiarCalendarioTab('${t.v}')">${t.label}</button>`).join('');

  let contenido;
  if (subTab === 'config') {
    contenido = renderCalendarioConfigTab(c, filasDias);
  } else if (subTab === 'domotica') {
    contenido = `
      <div class="reply-tabs">${tabsHtml}</div>
      ${tab === 'turnos' ? renderCalendarioListaCitas(ci => ci.estado !== 'realizada', 'No hay turnos próximos ni pendientes.') : ''}
      ${tab === 'realizados' ? renderCalendarioListaCitas(ci => ci.estado === 'realizada', 'Todavía no hay ninguna instalación marcada como realizada.') : ''}`;
  } else {
    contenido = renderServicioTecnicoTab();
  }

  return `
    <div class="page-head"><div><h1>Calendario</h1><div class="sub">Configuración general, agenda de instalaciones (domótica) y turnos de servicio técnico</div></div></div>
    <div class="reply-tabs" style="margin-bottom:14px;">${subTabsHtml}</div>
    ${contenido}`;
}
function cambiarCalendarioSubTab(t) { state.calendarioSubTab = t; render(); }
function cambiarCalendarioTab(t) { state.calendarioTab = t; render(); }
/* ---------------- Servicio Técnico (submenú de Calendario) ----------------
   Turnos que se cargan desde el botón "📅 Agendar servicio técnico" de cualquier ticket. */
function renderServicioTecnicoTab() {
  const tab = state.servicioTecnicoTab || 'turnos';
  const tabsHtml = [
    { v: 'turnos', label: 'Próximos turnos' },
    { v: 'realizados', label: 'Servicios Realizados' }
  ].map(t => `<button class="reply-tab ${tab === t.v ? 'active' : ''}" type="button" onclick="cambiarServicioTecnicoTab('${t.v}')">${t.label}</button>`).join('');
  const filtro = tab === 'realizados' ? (s => s.estado === 'realizado') : (s => s.estado !== 'realizado');
  const mensajeVacio = tab === 'realizados' ? 'Todavía no hay ningún servicio técnico marcado como realizado.' : 'No hay turnos de servicio técnico próximos ni pendientes.';
  return `
    <div class="reply-tabs">${tabsHtml}</div>
    ${renderServicioTecnicoLista(filtro, mensajeVacio)}`;
}
function cambiarServicioTecnicoTab(t) { state.servicioTecnicoTab = t; render(); }
function renderServicioTecnicoLista(filtro, mensajeVacio) {
  const turnos = (cache.serviciosTecnicos || []).filter(filtro);
  const html = turnos.length ? turnos.map(s => `
    <button type="button" class="user-row" style="width:100%;text-align:left;border:1px solid var(--line);cursor:pointer;" onclick="abrirDetalleServicioTecnico('${s.id}')">
      <div class="avatar">🛠️</div>
      <div><div class="u-name">${escapeHtml(s.titulo)}${s.estado === 'realizado' ? ' <span class="tag tag-resuelto" style="margin-left:6px;">Realizado</span>' : ''}</div>
      <div class="u-sub">${s.todo_el_dia ? new Date(s.fecha_hora).toLocaleDateString('es-UY', { dateStyle: 'medium', timeZone: 'America/Montevideo' }) + ' · Todo el día' : new Date(s.fecha_hora).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' })}${s.ticket_numero ? ` · Ticket ${escapeHtml(s.ticket_numero)}` : ''}</div></div>
    </button>`).join('') : `<div class="hint-text">${mensajeVacio}</div>`;
  return `<div class="page-head" style="margin-top:6px;"><div><h1 style="font-size:18px;">${turnos.length} turno${turnos.length === 1 ? '' : 's'}</h1></div></div>
    <div class="user-list">${html}</div>`;
}
function abrirDetalleServicioTecnico(id) {
  state.modal = 'detalle-servicio-tecnico';
  state.servicioTecnicoDetalleId = id;
  render();
}
function renderDetalleServicioTecnicoModal() {
  const s = (cache.serviciosTecnicos || []).find(x => String(x.id) === String(state.servicioTecnicoDetalleId));
  if (!s) return '';
  if (state.editandoServicioTecnicoId != null && String(state.editandoServicioTecnicoId) === String(s.id)) return renderEditarServicioTecnicoModal(s);
  const filas = [
    ['Título', escapeHtml(s.titulo)],
    ['Ticket', s.ticket_numero ? escapeHtml(s.ticket_numero) : '—'],
    ['Fecha y hora', s.todo_el_dia ? new Date(s.fecha_hora).toLocaleDateString('es-UY', { dateStyle: 'full', timeZone: 'America/Montevideo' }) + ' (todo el día)' : new Date(s.fecha_hora).toLocaleString('es-UY', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Montevideo' })],
    ['Duración', s.todo_el_dia ? '—' : `${s.duracion_minutos || 60} min`],
    ['Cargado por', s.creado_por ? escapeHtml(s.creado_por) : '—'],
    ['Estado', s.estado === 'realizado' ? 'Realizado' : 'Pendiente']
  ];
  const puedeMarcar = s.estado !== 'realizado';
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>🛠️ Detalle del servicio técnico</h2>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:${puedeMarcar ? '18px' : '4px'};">
      ${filas.map(([label, valor]) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;border-bottom:1px dashed var(--line);padding-bottom:6px;"><span style="color:var(--ink-soft);">${label}</span><strong>${valor}</strong></div>`).join('')}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()">Cerrar</button>
      ${s.ticket_id ? `<button type="button" class="btn btn-ghost" onclick="closeModal(); openTicket('${s.ticket_id}')">Ver ticket</button>` : ''}
      <button type="button" class="btn btn-ghost" onclick="state.editandoServicioTecnicoId='${s.id}'; render();">✏️ Editar</button>
      ${puedeMarcar ? `<button type="button" class="btn btn-primary" onclick="marcarServicioTecnicoRealizado('${s.id}')">✅ Marcar como realizado</button>` : ''}
    </div>
  </div></div>`;
}
function renderEditarServicioTecnicoModal(s) {
  const d = new Date(s.fecha_hora);
  const fechaDefault = d.toISOString().slice(0, 10);
  const horaDefault = d.toTimeString().slice(0, 5);
  return `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">
    <h2>✏️ Editar servicio técnico</h2>
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
  const titulo = document.getElementById('servicio-edit-titulo').value;
  const fecha = document.getElementById('servicio-edit-fecha').value;
  const hora = document.getElementById('servicio-edit-hora').value;
  const duracion = document.getElementById('servicio-edit-duracion').value;
  const todoElDia = document.getElementById('servicio-edit-ics-todo-el-dia').checked;
  if (!fecha) { showToast('Elegí una fecha.'); return; }
  if (!todoElDia && !hora) { showToast('Elegí una hora, o tildá "Todo el día".'); return; }
  try {
    const actualizado = await api('PUT', `/api/servicios-tecnicos/${id}`, { titulo, fecha, hora, duracion, todoElDia });
    const idx = (cache.serviciosTecnicos || []).findIndex(x => String(x.id) === String(id));
    if (idx >= 0) cache.serviciosTecnicos[idx] = actualizado;
    state.editandoServicioTecnicoId = null;
    showToast('Servicio técnico actualizado.');
    render();
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
          ${s.estado === 'realizado' ? `<span class="tag tag-resuelto">Realizado</span>` : `<button type="button" class="btn btn-ghost" onclick="marcarServicioTecnicoRealizadoDesdeTicket('${s.id}', '${t.id}')">✅ Marcar realizado</button>`}
        </div>`).join('')}
    </div>
  </div>`;
}
async function marcarServicioTecnicoRealizadoDesdeTicket(servicioId, ticketId) {
  try {
    await api('POST', `/api/servicios-tecnicos/${servicioId}/marcar-realizado`);
    showToast('Servicio técnico marcado como realizado.');
    await refreshTicket(ticketId);
    render();
  } catch (e) { showToast(e.message); }
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
async function marcarServicioTecnicoRealizado(id) {
  try {
    await api('POST', `/api/servicios-tecnicos/${id}/marcar-realizado`);
    const s = (cache.serviciosTecnicos || []).find(x => String(x.id) === String(id));
    if (s) s.estado = 'realizado';
    showToast('Servicio técnico marcado como realizado.');
    closeModal();
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
    recordatorioSinAsignarHora: fd.get('recordatorioSinAsignarHora') || '18:00'
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
  const rows = await api('GET', '/api/portal/tickets');
  cache.tickets = rows.map(mapTicket);
}
function openClienteTicket(id) { state.view = 'cliente-ticket'; state.ticketId = id; render(); loadClienteTicketDetalle(id); }
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
  await api('POST', `/api/portal/tickets/${ticketId}/mensajes`, { cuerpo });
  ev.target.reset();
  await loadClienteTicketDetalle(ticketId);
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
    { v: 'respuestas', label: 'Respuestas', ico: '&#128172;' }, { v: 'documentos', label: 'Documentos', ico: '&#128220;' }, { v: 'automatizaciones', label: 'Automatizaciones', ico: '&#9889;' },
    { v: 'calendario', label: 'Calendario', ico: '&#128197;' }, { v: 'newsletter', label: 'Newsletter', ico: '&#128240;' },
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

    .tag{position:relative;padding-left:20px;font-weight:700;box-shadow:0 1px 2px rgba(15,42,77,.06);transition:transform .12s ease;}
    .tag::before{content:'';position:absolute;left:9px;top:50%;transform:translateY(-50%);width:6px;height:6px;border-radius:50%;background:currentColor;}
    .tag-urgente{animation:tagPulseUrgente 1.8s ease-in-out infinite;}
    @keyframes tagPulseUrgente{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.35);}50%{box-shadow:0 0 0 5px rgba(196,61,61,0);}}
    .badge-atencion{box-shadow:0 1px 3px rgba(196,61,61,.25);animation:badgeGlow 2s ease-in-out infinite;}
    @keyframes badgeGlow{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.3);}50%{box-shadow:0 0 0 6px rgba(196,61,61,0);}}
    @media (prefers-reduced-motion: reduce){.tag-urgente,.badge-atencion{animation:none;}}

    .stub{border-radius:12px;transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease;}
    .stub:hover{transform:translateY(-2px);box-shadow:0 10px 24px -8px rgba(15,42,77,.22);border-color:var(--line-strong);}
    .stub-num{background:linear-gradient(160deg,var(--ink) 0%,#1B3F73 100%);position:relative;overflow:hidden;}
    .stub-num::before,.stub-num::after{background:var(--paper);}
    .stub-num > *{position:relative;z-index:1;}

    .stamp{border-radius:8px;padding:7px 16px;box-shadow:0 4px 10px -4px currentColor;background:#fff;}
  </style>
  <div class="shell">
    <aside class="sidebar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div>
      <nav>${navItems(state.view)}</nav>
      <div class="sidebar-foot"><div class="who"><div class="sidebar-avatar">${avatarInner(u)}</div><div class="who-text"><strong>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</strong>${escapeHtml(u.cargo)}</div></div>
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
    .stub:hover{transform:translateY(-2px);box-shadow:0 10px 24px -8px rgba(15,42,77,.22);border-color:var(--line-strong);}
    .stub-num{background:linear-gradient(160deg,var(--ink) 0%,#1B3F73 100%);}
    .stub-num::before,.stub-num::after{background:var(--paper);}

    .tag{position:relative;padding-left:20px;font-weight:700;box-shadow:0 1px 2px rgba(15,42,77,.06);}
    .tag::before{content:'';position:absolute;left:9px;top:50%;transform:translateY(-50%);width:6px;height:6px;border-radius:50%;background:currentColor;}
    .tag-urgente{animation:tagPulseUrgente 1.8s ease-in-out infinite;}
    @keyframes tagPulseUrgente{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.35);}50%{box-shadow:0 0 0 5px rgba(196,61,61,0);}}

    .badge-atencion{box-shadow:0 1px 3px rgba(196,61,61,.25);animation:badgeGlow 2s ease-in-out infinite;}
    @keyframes badgeGlow{0%,100%{box-shadow:0 0 0 0 rgba(196,61,61,.3);}50%{box-shadow:0 0 0 6px rgba(196,61,61,0);}}
    @media (prefers-reduced-motion: reduce){.tag-urgente,.badge-atencion{animation:none;}}

    .dash-profile-chip{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);border-radius:99px;padding:5px 14px 5px 5px;box-shadow:0 1px 2px rgba(15,42,77,.05),0 8px 18px -10px rgba(15,42,77,.25);transition:transform .15s ease,box-shadow .15s ease;}
    .dash-profile-chip:hover{transform:translateY(-2px);box-shadow:0 1px 2px rgba(15,42,77,.05),0 12px 22px -8px rgba(15,42,77,.32);border-color:var(--line-strong);}
    .dash-profile-avatar{width:30px;height:30px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-weight:600;font-size:12px;color:#fff;background:linear-gradient(135deg,var(--brand-2),#8B5CF6);box-shadow:0 2px 6px rgba(30,86,199,.4);overflow:hidden;}
    .dash-profile-name{font-size:13.5px;font-weight:600;color:var(--ink);}
    @media (max-width:600px){.dash-profile-name{display:none;}}
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
        <span class="tag tag-${slug(t.estado)}">${t.estado}</span><span class="tag tag-${slug(t.prioridad)}">${t.prioridad}</span><span class="tag tag-cat">${escapeHtml(t.categoria)}</span>
        ${!clientMode && grupo ? `<span class="tag tag-cliente">${escapeHtml(grupo.nombre)}</span>` : ''}
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
/* ---------------- Agendar reserva (.ics) ----------------
   Bloque autocontenido: no toca ninguna otra parte del sistema ni crea tablas nuevas.
   Se puede sacar en cualquier momento borrando este bloque y su llamada en renderTicket(). */
function renderReservaCalendario(t) {
  const ahora = new Date(Date.now() + 60 * 60000); // por defecto, dentro de una hora
  const fechaDefault = ahora.toISOString().slice(0, 10);
  const horaDefault = ahora.toTimeString().slice(0, 5);
  return `<div class="card card-narrow" style="max-width:560px;margin:14px 0;">
    ${configSectionHead('📅', 'Agendar esta reserva', 'Generá un archivo .ics con la fecha y hora que seleccionás, para abrirlo con tu app de calendario (One Calendar, Outlook, Google Calendar, etc.).')}
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" id="reserva-ics-todo-el-dia" onchange="toggleTodoElDiaIcs('reserva')"> Todo el día</label>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="reserva-ics-fecha" value="${fechaDefault}"></div>
      <div class="field" id="reserva-ics-hora-wrap"><label>Hora</label><input type="time" id="reserva-ics-hora" value="${horaDefault}"></div>
    </div>
    <div class="field" id="reserva-ics-duracion-wrap"><label>Duración (minutos)</label><input type="number" id="reserva-ics-duracion" min="15" step="15" value="60"></div>
    <div style="margin-top:10px;"><button type="button" class="btn btn-primary" onclick="descargarIcsReserva('${t.id}')">📅 Descargar evento (.ics)</button></div>
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
// Función compartida: arma y descarga el .ics. La usan tanto el bloque de Reservas como el
// modal de "Agendar servicio técnico" (mismo formato, dos entradas distintas).
function generarYDescargarIcs(t, { fecha, hora, duracion, titulo, prefijoArchivo, todoElDia }) {
  if (!fecha) { showToast('Elegí una fecha.'); return false; }
  if (!todoElDia && !hora) { showToast('Elegí una hora, o tildá "Todo el día".'); return false; }
  const toIcsUtc = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const escapeIcs = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const descripcion = `Ticket ${t.numero}\\nCliente: ${t.remitenteNombre} (${t.remitenteEmail})`;
  let lineasFecha;
  if (todoElDia) {
    // Evento de día completo: DTSTART/DTEND van solo con fecha (VALUE=DATE), y el DTEND es el día
    // siguiente porque en formato .ics el final de un evento de todo el día es "exclusivo" (así lo
    // interpretan One Calendar, Outlook y Google Calendar para mostrar un solo día marcado).
    const inicioDate = new Date(`${fecha}T00:00:00`);
    if (isNaN(inicioDate.getTime())) { showToast('Fecha inválida.'); return false; }
    const finDate = new Date(inicioDate.getTime() + 24 * 60 * 60000);
    const toIcsDate = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    lineasFecha = [`DTSTART;VALUE=DATE:${toIcsDate(inicioDate)}`, `DTEND;VALUE=DATE:${toIcsDate(finDate)}`];
  } else {
    const inicio = new Date(`${fecha}T${hora}:00`);
    if (isNaN(inicio.getTime())) { showToast('Fecha u hora inválida.'); return false; }
    const dur = Number(duracion) || 60;
    const fin = new Date(inicio.getTime() + dur * 60000);
    lineasFecha = [`DTSTART:${toIcsUtc(inicio)}`, `DTEND:${toIcsUtc(fin)}`];
  }
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ticketera Borcam//Agenda//ES', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${prefijoArchivo}-${t.id}-${Date.now()}@ticketera-borcam`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    ...lineasFecha,
    `SUMMARY:${escapeIcs(titulo || t.asunto)}`,
    `DESCRIPTION:${escapeIcs(descripcion)}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${prefijoArchivo}-${t.numero}.ics`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}
function descargarIcsReserva(id) {
  const t = cache.tickets.find(x => x.id === id);
  if (!t) return;
  generarYDescargarIcs(t, {
    fecha: document.getElementById('reserva-ics-fecha').value,
    hora: document.getElementById('reserva-ics-hora').value,
    duracion: document.getElementById('reserva-ics-duracion').value,
    titulo: t.asunto,
    prefijoArchivo: 'reserva',
    todoElDia: document.getElementById('reserva-ics-todo-el-dia').checked
  });
}
// Atajo "🏷️ Pedido de Tag" desde la ficha del ticket: te lleva directo a Tags → Nuevo pedido
// con el número de ticket (y el nombre del solicitante) ya cargados.
function irAPedidoDeTagDesdeTicket(ticketId) {
  const t = cache.tickets.find(x => x.id === ticketId);
  if (!t) return;
  state.tagsPrecarga = { ticket: t.numero, cliente: t.remitenteNombre || '' };
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
  render();
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
  if (!fecha) { showToast('Elegí una fecha.'); return; }
  if (!todoElDia && !hora) { showToast('Elegí una hora, o tildá "Todo el día".'); return; }
  // Ya no se descarga ningún .ics: el turno queda guardado en el sistema, visible en Calendario → Servicio Técnico.
  try {
    await api('POST', '/api/servicios-tecnicos', { ticketId: t.id, ticketNumero: t.numero, titulo, fecha, hora, duracion, todoElDia });
    showToast('Servicio técnico agendado.');
    closeModal();
  } catch (e) { showToast(e.message); }
}
function filteredReservas() {
  const f = state.filtersReservas;
  return cache.tickets
    .filter(esTicketDeReserva)
    .filter(t => f.estado === 'todos' ? (t.estado !== 'Cerrado' && t.estado !== 'Resuelto') : t.estado === f.estado)
    .filter(t => f.prioridad === 'todas' || t.prioridad === f.prioridad)
    .filter(t => { if (!f.search) return true; const s = f.search.toLowerCase(); return t.asunto.toLowerCase().includes(s) || t.numero.toLowerCase().includes(s) || t.remitenteNombre.toLowerCase().includes(s) || t.remitenteEmail.toLowerCase().includes(s); })
    .sort((a, b) => new Date(b.actualizado) - new Date(a.actualizado));
}
function setFilterReservas(k, v) { state.filtersReservas[k] = v; state.paginaReservas = 1; render(); }
function irAPaginaReservas(n) { state.paginaReservas = n; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function renderReservas() {
  const todos = filteredReservas();
  const totalPaginas = Math.max(1, Math.ceil(todos.length / TICKETS_POR_PAGINA));
  if (state.paginaReservas > totalPaginas) state.paginaReservas = totalPaginas;
  if (state.paginaReservas < 1) state.paginaReservas = 1;
  const desde = (state.paginaReservas - 1) * TICKETS_POR_PAGINA;
  const tickets = todos.slice(desde, desde + TICKETS_POR_PAGINA);

  const estOptions = ['todos', ...CAT.ESTADOS].map(e => `<option value="${e}" ${state.filtersReservas.estado === e ? 'selected' : ''}>${e === 'todos' ? 'Todo estado (sin cerrados ni resueltos)' : e}</option>`).join('');
  const prioOptions = ['todas', ...CAT.PRIORIDADES].map(p => `<option value="${p}" ${state.filtersReservas.prioridad === p ? 'selected' : ''}>${p === 'todas' ? 'Toda prioridad' : p}</option>`).join('');
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t, false, true)).join('')}</div>` : `<div class="empty-state"><div class="big">No hay reservas que coincidan</div><div>Acá aparecen automáticamente los tickets cuyo asunto contiene la palabra "reserva".</div></div>`;

  const paginacion = todos.length > TICKETS_POR_PAGINA ? `
    <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:18px;">
      <button class="btn btn-ghost" ${state.paginaReservas <= 1 ? 'disabled' : ''} onclick="irAPaginaReservas(${state.paginaReservas - 1})">&larr; Anterior</button>
      <span style="font-size:13.5px;color:var(--ink-soft);">Página ${state.paginaReservas} de ${totalPaginas}</span>
      <button class="btn btn-ghost" ${state.paginaReservas >= totalPaginas ? 'disabled' : ''} onclick="irAPaginaReservas(${state.paginaReservas + 1})">Siguiente &rarr;</button>
    </div>` : '';

  return `
    <div class="page-head"><div><h1>Reservas</h1><div class="sub">${todos.length} ticket${todos.length === 1 ? '' : 's'} con "reserva" en el asunto</div></div></div>
    <div class="filters">
      <select onchange="setFilterReservas('estado', this.value)">${estOptions}</select>
      <select onchange="setFilterReservas('prioridad', this.value)">${prioOptions}</select>
      <input type="search" placeholder="Buscar y presioná Enter…" value="${escapeHtml(state.filtersReservas.search)}" onkeydown="if(event.key==='Enter'){ setFilterReservas('search', this.value); }" onsearch="setFilterReservas('search', this.value)">
    </div>
    ${state.selectedTickets.size ? renderBulkActionBar() : ''}
    ${list}
    ${paginacion}`;
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
  return `${dashboardStyleTag()}
    <div class="page-head"><div><h1>Bandeja de entrada general</h1><div class="sub">${todos.length} ticket${todos.length === 1 ? '' : 's'} visibles${state.filters.fecha ? ` · mostrando tickets del ${state.filters.fecha.split('-').reverse().join('/')}` : ''}</div></div>
      <div style="display:flex;align-items:center;gap:12px;">
        <button class="btn btn-primary" onclick="openNuevoCorreoModal()">+ Simular correo entrante</button>
        <button type="button" class="dash-profile-chip" onclick="go('perfil')" title="Ir a mi perfil">
          <span class="dash-profile-avatar">${avatarInner(u)}</span>
          <span class="dash-profile-name">${escapeHtml(u.nombre)}</span>
        </button>
      </div></div>
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
function renderAdjuntos(ticketId, mensajeId, adjuntos) {
  return `<div class="msg-attachments">${adjuntos.map(a => {
    const url = `/api/adjuntos/${ticketId}/${mensajeId}/${a.id}`;
    if (a.tipo === 'imagen') return `<a href="${url}" download="${escapeHtml(a.nombre)}"><img src="${url}" alt="${escapeHtml(a.nombre)}"></a>`;
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

    /* Cuadro del número de ticket (arriba de la ficha) — antes era solo texto gris, ahora un
       "sello" a juego con el resto del diseño (mismo estilo que el número en la bandeja). */
    .ticket-num-big{display:inline-block;font-family:var(--font-mono) !important;font-size:13px !important;font-weight:700;letter-spacing:.03em;color:#fff !important;background:linear-gradient(160deg,var(--ink) 0%,#1B3F73 100%);padding:6px 14px;border-radius:8px;box-shadow:0 4px 10px -4px rgba(15,42,77,.4);margin-bottom:6px;}
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
          <div class="stamp stamp-${slug(t.estado)}">${t.estado}</div>
        </div>
      </div>
      <div class="ticket-actions-row" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;">
        ${t.asignadoA !== uid_ ? `<button type="button" class="btn btn-ghost" onclick="tomarTicket('${t.id}')">Tomar este ticket</button>` : ''}
        ${!esTicketDeReserva(t) ? `<button type="button" class="btn btn-ghost" onclick="openAgendarServicioModal('${t.id}')">📅 Agendar servicio técnico</button>` : ''}
        ${!esTicketDeReserva(t) ? `<button type="button" class="btn btn-ghost" onclick="irAPedidoDeTagDesdeTicket('${t.id}')">🏷️ Pedido de Tag</button>` : ''}
        <button type="button" class="btn btn-danger" onclick="eliminarTicket('${t.id}')">Eliminar ticket</button>
      </div>
      <div class="meta-grid">
        <div class="field"><label>Categoría</label><select onchange="updateTicketField('${t.id}','categoria', this.value)">${catOptions}</select></div>
        <div class="field"><label>Prioridad</label><select onchange="updateTicketField('${t.id}','prioridad', this.value)">${prioOptions}</select></div>
        <div class="field"><label>Estado</label><select onchange="updateTicketField('${t.id}','estado', this.value)">${estOptions}</select></div>
        <div class="field"><label>Asignado a</label><select onchange="updateTicketField('${t.id}','asignadoA', this.value)">${asignOptions}</select></div>
        <div class="field"><label>Cliente</label><select onchange="updateTicketField('${t.id}','clienteId', this.value)">${grupoOptions}</select></div>
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
        <div class="field" style="margin-top:12px;"><label>CC (copia a)</label><input name="cc" type="text" value="${escapeHtml((t.mensajes || []).flatMap(m => m.cc || []).filter((v, i, arr) => v && arr.indexOf(v) === i).join(', '))}" placeholder="otro-correo@ejemplo.com, otro2@ejemplo.com"><div class="hint-text">Se completa solo con quienes estuvieron en copia en este ticket. Podés editarlo antes de enviar.</div></div>
        <div class="field"><label>Adjuntar archivos</label><input type="file" multiple accept="image/*,video/*,application/pdf" onchange="addPendingAttachments(this)"><div class="hint-text">Imágenes, PDF o video, máx. 20 MB.</div><div id="pending-attachments">${renderPendingChips()}</div></div>
        ${cache.documentosLegales.filter(d => d.activo).length ? `
        <div class="field"><label>Pedir aceptación de un documento (opcional)</label><select name="documentoLegalId"><option value="">Ninguno</option>${cache.documentosLegales.filter(d => d.activo).map(d => `<option value="${d.id}">${escapeHtml(d.nombre)}</option>`).join('')}</select><div class="hint-text">Se le agrega al cliente un enlace para leer y aceptar ese documento, con registro de fecha, hora e IP.</div></div>` : ''}` : ''}
        <div class="reply-actions"><button type="submit" class="btn btn-primary">${state.replyTab === 'saliente' ? 'Enviar respuesta' : state.replyTab === 'nota' ? 'Guardar nota interna' : 'Simular correo entrante'}</button></div>
      </form>
    </div>`;
}

/* ---------------- Clientes ---------------- */

function renderGrupos() {
  const rows = cache.clientes.map(g => `
    <button class="stub" style="align-items:stretch;" onclick="openGrupoDetail('${g.id}')">
      <div class="stub-num" style="width:64px;"><div class="n" style="font-size:18px;">${g.tienePortal ? '🔐' : '—'}</div><div class="y">portal</div></div>
      <div class="stub-body"><div class="stub-top"><div class="stub-asunto">${escapeHtml(g.nombre)}</div></div>
        <div class="stub-remitente">${[g.telefono, g.correo].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        ${g.direccion ? `<div class="stub-snippet">${escapeHtml(g.direccion)}</div>` : ''}
        ${g.rolCliente ? `<div class="stub-meta"><span class="tag tag-cliente">${escapeHtml(g.rolCliente)}</span></div>` : ''}
      </div></button>`).join('');
  const list = cache.clientes.length ? `<div class="stub-list">${rows}</div>` : `<div class="empty-state"><div class="big">Todavía no hay clientes</div><div>Dá de alta un cliente para agrupar sus tickets.</div></div>`;
  return `<div class="page-head"><div><h1>Clientes</h1><div class="sub">Listado de clientes, cada uno con sus propios tickets</div></div><button class="btn btn-primary" onclick="openNuevoGrupoModal()">+ Nuevo cliente</button></div>${list}`;
}

async function renderGrupoDetailAsync(id) {
  const g = cache.clientes.find(x => x.id === id);
  if (!g) return `<div class="empty-state">Cliente no encontrado.</div>`;
  const tickets = await loadClienteDetalleTickets(id);
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t)).join('')}</div>` : `<div class="empty-state"><div class="big">Este cliente todavía no tiene tickets</div></div>`;
  return `${ticketStyleTag()}
    <button class="back-link" onclick="go('grupos')">&larr; Volver a clientes</button>
    <div class="ticket-head">
      <div class="ticket-head-top"><div><div class="ticket-num-big">CLIENTE</div><h1>${escapeHtml(g.nombre)}</h1>
        <div class="ticket-from">${[g.direccion, g.telefono, g.correo].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        <div class="ticket-from">Portal de cliente: ${g.tienePortal ? `<strong style="color:var(--stamp-green);">habilitado</strong>` : '<strong style="color:var(--gray);">sin configurar</strong>'}</div></div>
        ${g.rolCliente ? `<div class="stamp stamp-abierto">${escapeHtml(g.rolCliente)}</div>` : ''}</div>
      <div style="display:flex;gap:8px;margin-top:16px;padding-top:16px;border-top:1px dashed var(--line-strong);">
        <button class="btn btn-ghost" onclick="openEditarGrupoModal('${g.id}')">Editar cliente</button>
        <button class="btn btn-danger" onclick="deleteGrupo('${g.id}')">Eliminar</button></div>
    </div>
    <div class="page-head"><div><h1 style="font-size:18px;">Tickets de este cliente</h1><div class="sub">${tickets.length} en total</div></div></div>
    ${list}`;
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
      background:linear-gradient(135deg,var(--ink) 0%,#1B3F73 55%,var(--brand-2) 100%);color:#fff;
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

    .card-peligro{border:1.5px solid var(--stamp-red-tint) !important;background:linear-gradient(180deg,#fff 0%,#FDF4F4 100%);}
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
  const opciones = edificios.map(e => `<option value="${escapeHtml(e.edificio)}">${escapeHtml(e.edificio)}</option>`).join('');
  const precarga = state.tagsPrecarga || {};
  return `<div class="card card-narrow" style="max-width:560px;">
    ${configSectionHead('🏷️', 'Ingresar pedido', 'Al guardar se descuenta automáticamente del stock disponible de ese edificio.')}
    ${precarga.ticket ? `<div class="hint-text" style="margin-bottom:10px;">Datos precargados desde el ticket ${escapeHtml(precarga.ticket)}.</div>` : ''}
    <div class="field"><label>Cliente</label><input type="text" id="tags-cliente" placeholder="Nombre del cliente" value="${escapeHtml(precarga.cliente || '')}"></div>
    <div class="field"><label>Edificio</label>
      <select id="tags-edificio">
        <option value="">-- Seleccioná un edificio --</option>
        ${opciones}
      </select>
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
    return `<text x="0" y="${y + barH / 2 + 4}" font-size="12.5" fill="#1a2233">${escapeHtml(label)}</text>
      <rect x="${leftW}" y="${y}" width="${chartW}" height="${barH}" rx="7" fill="var(--paper)"></rect>
      <rect class="chart-bar-3d" x="${leftW}" y="${y}" width="${w}" height="${barH}" rx="7" fill="url(#barGrad3d)" filter="url(#barShadow3d)" style="transform-origin:${leftW}px ${y}px;animation-delay:${i * 70}ms;"></rect>
      <rect x="${leftW}" y="${y}" width="${w}" height="${Math.round(barH * .4)}" rx="6" fill="rgba(255,255,255,.28)"></rect>
      <text x="${leftW + w + 8}" y="${y + barH / 2 + 4}" font-size="12.5" font-weight="600" fill="#1a2233">${d.value}</text>`;
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
      .kpi-tile { position:relative; overflow:hidden; background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px 18px;
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
        ${configSectionHead('💾', 'Respaldo automático del sistema', 'Manda por correo, cada tantos días, una copia completa de los datos (tickets, conversaciones, clientes, configuración). No incluye los archivos adjuntos en sí ni contraseñas.')}
        <label class="switch-row">
          <input type="checkbox" name="respaldoActivo" ${c.respaldoActivo ? 'checked' : ''}> Enviarme un respaldo automático por correo
        </label>
        <div class="field-row">
          <div class="field"><label>Correo de destino</label><input name="respaldoCorreoDestino" type="email" value="${escapeHtml(c.respaldoCorreoDestino || '')}" placeholder="tu-correo-personal@gmail.com"></div>
          <div class="field"><label>Cada cuántos días</label><input type="number" name="respaldoFrecuenciaDias" min="1" value="${c.respaldoFrecuenciaDias || 7}"></div>
        </div>
        ${c.respaldoUltimo ? `<div class="hint-text" style="margin-top:-6px;">Último respaldo enviado: ${new Date(c.respaldoUltimo).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short' })}</div>` : ''}

        ${currentUser().es_superadmin ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
          <button type="button" class="btn btn-ghost btn-block" onclick="descargarRespaldoAhora()">Descargar respaldo ahora</button>
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
  if (state.modal === 'nueva-automatizacion' || state.modal === 'editar-automatizacion') return renderAutomatizacionModal();
  if (state.modal === 'editar-usuario') return renderEditarUsuarioModal();
  if (state.modal === 'nuevo-usuario') return renderNuevoUsuarioModal();
  if (state.modal === 'nuevo-documento' || state.modal === 'editar-documento') return renderDocumentoModal();
  if (state.modal === 'agendar-servicio') return renderAgendarServicioModal();
  if (state.modal === 'detalle-cita') return renderDetalleCitaModal();
  if (state.modal === 'detalle-servicio-tecnico') return renderDetalleServicioTecnicoModal();
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
      <div class="field"><label>Rol</label><select name="rolCliente"><option value="" ${!g || !g.rolCliente ? 'selected' : ''}>Sin especificar</option>${CAT.ROLES_CLIENTE.map(r => `<option value="${r}" ${g && g.rolCliente === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
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

function renderClientShell(inner) {
  const g = currentGrupo();
  return `<div class="shell">
    <aside class="sidebar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div>
      <nav><button class="nav-btn active"><span class="ico">&#9776;</span><span>Mis tickets</span></button></nav>
      <div class="sidebar-foot"><div class="who"><strong>${escapeHtml(g.nombre)}</strong>Portal de cliente</div><button class="nav-btn" onclick="logout()"><span class="ico">&#8630;</span><span>Cerrar sesión</span></button></div>
    </aside>
    <div class="main"><div class="topbar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div><button class="nav-btn" style="color:#fff" onclick="logout()">Salir</button></div>
      <div class="content">${inner}</div>
      <div class="bottomnav"><button class="nav-btn active"><span class="ico">&#9776;</span><span>Tickets</span></button></div>
    </div></div>
  ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}`;
}
function renderClienteDashboard() {
  const g = currentGrupo();
  const tickets = [...cache.tickets].sort((a, b) => new Date(b.actualizado) - new Date(a.actualizado));
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t, true)).join('')}</div>` : `<div class="empty-state"><div class="big">Todavía no tenés tickets</div></div>`;
  return `<div class="page-head"><div><h1>Mis tickets</h1><div class="sub">Todos los tickets abiertos a nombre de ${escapeHtml(g.nombre)}</div></div></div>${list}`;
}
function renderClienteTicket(id) {
  const t = cache.tickets.find(x => x.id === id);
  if (!t) return `<button class="back-link" onclick="go('cliente-dashboard')">&larr; Volver</button><div class="empty-state">Cargando…</div>`;
  const thread = renderThreadHtml(t);
  return `<button class="back-link" onclick="go('cliente-dashboard')">&larr; Volver a mis tickets</button>
    <div class="ticket-head"><div class="ticket-head-top"><div><div class="ticket-num-big">${t.numero}</div><h1>${escapeHtml(t.asunto)}</h1>
      <div class="ticket-from">Categoría: ${escapeHtml(t.categoria)} · Prioridad: ${t.prioridad} · Creado ${fmtDateTime(t.creado)}</div></div>
      <div class="stamp stamp-${slug(t.estado)}">${t.estado}</div></div></div>
    <div class="thread">${thread}</div>
    <div class="reply-box"><form onsubmit="return submitClienteReply(event, '${t.id}')">
      <div class="field" style="margin-bottom:0;"><textarea name="cuerpo" placeholder="Escribí tu respuesta…" required></textarea></div>
      <div class="reply-actions"><button type="submit" class="btn btn-primary">Enviar respuesta</button></div>
    </form></div>`;
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
    .auth-card-brand{position:relative;background:linear-gradient(135deg,var(--ink) 0%,#1B3F73 60%,#264d8f 100%);padding:26px 28px;display:flex;justify-content:center;align-items:center;overflow:hidden;}
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
    const rolOptions = (CAT.ROLES_CLIENTE && CAT.ROLES_CLIENTE.length ? CAT.ROLES_CLIENTE : ['Administración', 'Integrante de Comisión', 'Intendente', 'Edificio']).map(r => `<option value="${r}">${r}</option>`).join('');
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
    const inner = (state.view === 'cliente-ticket' && state.ticketId) ? renderClienteTicket(state.ticketId) : renderClienteDashboard();
    app.innerHTML = renderClientShell(inner);
    return;
  }
  let inner = '';
  if (state.view === 'ticket' && state.ticketId) inner = renderTicket(state.ticketId);
  else if (state.view === 'perfil') inner = renderPerfil();
  else if (state.view === 'usuarios') inner = renderUsuarios();
  else if (state.view === 'respuestas') inner = renderRespuestas();
  else if (state.view === 'grupos') inner = renderGrupos();
  else if (state.view === 'reservas') inner = renderReservas();
  else if (state.view === 'documentos') inner = renderDocumentos();
  else if (state.view === 'grupo') { inner = '<div class="empty-state">Cargando…</div>'; renderGrupoDetailAsync(state.grupoId).then(html => { const el = document.querySelector('.content'); if (el && state.view === 'grupo') el.innerHTML = html; }); }
  else if (state.view === 'calendario') { inner = '<div class="empty-state">Cargando…</div>'; renderCalendarioAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'calendario') el.innerHTML = html; }); }
  else if (state.view === 'automatizaciones') inner = renderAutomatizaciones();
  else if (state.view === 'newsletter') inner = renderNewsletter();
  else if (state.view === 'estadisticas') inner = renderEstadisticas();
  else if (state.view === 'tags') { inner = '<div class="empty-state">Cargando…</div>'; renderTagsAsync().then(html => { const el = document.querySelector('.content'); if (el && state.view === 'tags') { el.innerHTML = html; actualizarCostoTags(); } }); }
  else if (state.view === 'configuracion') inner = renderConfiguracion();
  else inner = renderDashboard();
  app.innerHTML = renderShell(inner);
}

boot();
