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
  pendingAttachments: [], editandoPasos: [], editAutomatizacionId: null, editGrupoId: null
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
    mensajes: (row.mensajes || []).map(mapMensaje)
  };
}
function mapMensaje(m) {
  return { id: m.id, tipo: m.tipo, autor: m.autor, cuerpo: m.cuerpo, cc: m.cc || [], adjuntos: m.adjuntos || [], firmaHtml: m.firma_html || '', destinatarios: m.destinatarios || [], automatico: m.automatico, fecha: m.fecha };
}

/* ---------------- Bootstrap / sesión ---------------- */

async function boot() {
  try {
    const r = await api('GET', '/api/auth/me');
    if (r.session && r.session.type === 'staff') {
      session = r.session; state.view = 'dashboard'; await loadStaffData();
    } else if (r.session && r.session.type === 'cliente') {
      session = r.session; state.view = 'cliente-dashboard'; await loadClienteTickets();
    }
  } catch (e) {}
  render();
}

async function loadStaffData() {
  const [tickets, usuarios, clientes, respuestas, automatizaciones, configuracion, catalogos] = await Promise.all([
    api('GET', '/api/tickets'), api('GET', '/api/usuarios'), api('GET', '/api/clientes'),
    api('GET', '/api/respuestas'), api('GET', '/api/automatizaciones'), api('GET', '/api/configuracion'),
    api('GET', '/api/catalogos')
  ]);
  cache.tickets = tickets.map(mapTicket);
  cache.usuarios = usuarios;
  cache.clientes = clientes.map(c => ({ id: c.id, nombre: c.nombre, direccion: c.direccion, telefono: c.telefono, correo: c.correo, rol: c.rol, tienePortal: c.tiene_portal }));
  cache.respuestas = respuestas;
  cache.automatizaciones = automatizaciones.map(a => ({ id: a.id, nombre: a.nombre, activo: a.activo, pasos: a.pasos.map(p => ({ id: p.id, matchAny: p.match_any, palabras: p.palabras || [], respuestaId: p.respuesta_id, accionEstado: p.accion_estado })) }));
  cache.configuracion = configuracion;
  CAT = catalogos;
}

async function refreshTicket(id) {
  const t = await api('GET', '/api/tickets/' + id);
  const mapped = mapTicket(t);
  const idx = cache.tickets.findIndex(x => x.id === id);
  if (idx >= 0) cache.tickets[idx] = mapped; else cache.tickets.unshift(mapped);
  return mapped;
}

/* ---------------- Auth ---------------- */

function currentUser() { return session && session.type === 'staff' ? session.usuario : null; }
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

async function logout() {
  await api('POST', '/api/auth/logout');
  session = null; state.view = 'login'; state.authView = 'login';
  cache = { tickets: [], usuarios: [], clientes: [], respuestas: [], automatizaciones: [], configuracion: {} };
  render();
}
function goAuth(mode) { state.authView = mode; state.authError = ''; state.regError = ''; render(); }
function go(view) { state.view = view; render(); }

/* ---------------- Tickets (staff) ---------------- */

function fechaLocal(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hoyStr() { return fechaLocal(new Date().toISOString()); }

function filteredTickets() {
  const f = state.filters;
  return cache.tickets
    .filter(t => f.estado === 'todos' || t.estado === f.estado)
    .filter(t => f.categoria === 'todas' || t.categoria === f.categoria)
    .filter(t => f.prioridad === 'todas' || t.prioridad === f.prioridad)
    .filter(t => f.grupo === 'todos' || t.grupoId === f.grupo)
    .filter(t => f.agente === 'todos' ? true : (f.agente === 'sin-asignar' ? !t.asignadoA : t.asignadoA === f.agente))
    .filter(t => !f.fecha || fechaLocal(t.creado) === f.fecha)
    .filter(t => { if (!f.search) return true; const s = f.search.toLowerCase(); return t.asunto.toLowerCase().includes(s) || t.numero.toLowerCase().includes(s) || t.remitenteNombre.toLowerCase().includes(s) || t.remitenteEmail.toLowerCase().includes(s); })
    .sort((a, b) => new Date(b.actualizado) - new Date(a.actualizado));
}
function setFilter(k, v) { state.filters[k] = v; render(); }

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
  await api('POST', '/api/tickets/' + id + '/tomar');
  await refreshTicket(id);
  render();
}

function openNuevoCorreoModal() { state.modal = 'nuevo-correo'; render(); }
function closeModal() { state.modal = null; state.editandoPasos = []; render(); }

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

const ATTACH_MAX_BYTES = 3 * 1024 * 1024;
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
    if (file.size > ATTACH_MAX_BYTES) { showToast(`"${file.name}" pesa demasiado (máx. 3 MB).`); return; }
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
        tipo: 'saliente', cuerpo, cc, adjuntos: state.pendingAttachments, incluirFirma: fd.get('incluirFirma') === 'on'
      });
      state.pendingAttachments = [];
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
  const payload = { nombre: fd.get('nombre'), direccion: fd.get('direccion'), telefono: fd.get('telefono'), correo: fd.get('correo'), rol: fd.get('rol'), portalPassword: (fd.get('portalPassword') || '').trim() };
  try {
    if (state.modal === 'editar-grupo') await api('PUT', '/api/clientes/' + state.editGrupoId, payload);
    else await api('POST', '/api/clientes', payload);
    cache.clientes = (await api('GET', '/api/clientes')).map(c => ({ id: c.id, nombre: c.nombre, direccion: c.direccion, telefono: c.telefono, correo: c.correo, rol: c.rol, tienePortal: c.tiene_portal }));
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

/* ---------------- Automatizaciones ---------------- */

function openNuevaAutomatizacionModal() {
  state.modal = 'nueva-automatizacion'; state.editAutomatizacionId = null;
  state.editandoPasos = [{ id: uid(), matchAny: false, palabras: '', respuestaId: cache.respuestas[0] ? cache.respuestas[0].id : '', accionEstado: 'Sin cambio' }];
  render();
}
function openEditarAutomatizacionModal(id) {
  const a = cache.automatizaciones.find(x => x.id === id);
  state.modal = 'editar-automatizacion'; state.editAutomatizacionId = id;
  state.editandoPasos = a ? a.pasos.map(p => ({ id: p.id, matchAny: !!p.matchAny, palabras: (p.palabras || []).join(', '), respuestaId: p.respuestaId, accionEstado: p.accionEstado || 'Sin cambio' })) : [];
  render();
}
function leerPasosDesdeDom() {
  return Array.from(document.querySelectorAll('.paso-row')).map(row => ({
    id: row.dataset.pasoId, matchAny: row.querySelector('[data-field="matchAny"]').checked,
    palabras: row.querySelector('[data-field="palabras"]').value, respuestaId: row.querySelector('[data-field="respuestaId"]').value,
    accionEstado: row.querySelector('[data-field="accionEstado"]').value
  }));
}
function refreshPasosEditor() { const el = document.getElementById('pasos-container'); if (el) el.innerHTML = renderPasosEditor(); }
function agregarPasoEditor() {
  state.editandoPasos = leerPasosDesdeDom();
  state.editandoPasos.push({ id: uid(), matchAny: true, palabras: '', respuestaId: cache.respuestas[0] ? cache.respuestas[0].id : '', accionEstado: 'Sin cambio' });
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
    pasos.push({ matchAny: p.matchAny, palabras: p.matchAny ? [] : p.palabras.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), respuestaId: p.respuestaId, accionEstado: p.accionEstado });
  }
  try {
    if (state.modal === 'editar-automatizacion') await api('PUT', '/api/automatizaciones/' + state.editAutomatizacionId, { nombre, activo, pasos });
    else await api('POST', '/api/automatizaciones', { nombre, activo, pasos });
    const autos = await api('GET', '/api/automatizaciones');
    cache.automatizaciones = autos.map(a => ({ id: a.id, nombre: a.nombre, activo: a.activo, pasos: a.pasos.map(p => ({ id: p.id, matchAny: p.match_any, palabras: p.palabras || [], respuestaId: p.respuesta_id, accionEstado: p.accion_estado })) }));
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
async function saveFirma() {
  const html = document.getElementById('firma-editor').innerHTML.trim();
  await api('PUT', '/api/usuarios/me/firma', { html });
  session.usuario.firma_html = html;
  showToast('Firma guardada.');
  render();
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
    smtpHost: fd.get('smtpHost').trim(), smtpPort: Number(fd.get('smtpPort')) || 465, smtpUsuario: fd.get('smtpUsuario').trim(), smtpPassword: fd.get('smtpPassword').trim()
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
    { v: 'dashboard', label: 'Tickets', ico: '&#9776;' }, { v: 'grupos', label: 'Clientes', ico: '&#128100;' },
    { v: 'respuestas', label: 'Respuestas', ico: '&#128172;' }, { v: 'automatizaciones', label: 'Automatizaciones', ico: '&#9889;' },
    { v: 'configuracion', label: 'Configuración', ico: '&#9881;' }, { v: 'perfil', label: 'Mi perfil', ico: '&#9998;' },
    { v: 'usuarios', label: 'Usuarios', ico: '&#128101;' },
  ];
  return items.map(it => `<button class="nav-btn ${activeView === it.v ? 'active' : ''}" onclick="go('${it.v}')"><span class="ico">${it.ico}</span><span>${it.label}</span></button>`).join('');
}
function renderShell(inner) {
  const u = currentUser();
  return `
  <div class="shell">
    <aside class="sidebar"><div class="brand-mark">${logoSvg('white')}<span class="name">Sistema de Tickets</span></div>
      <nav>${navItems(state.view)}</nav>
      <div class="sidebar-foot"><div class="who"><strong>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</strong>${escapeHtml(u.cargo)}</div>
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

function renderStub(t, clientMode) {
  const lastMsg = t.mensajes[t.mensajes.length - 1];
  const grupo = t.grupoId ? cache.clientes.find(g => g.id === t.grupoId) : null;
  const agente = t.asignadoA ? cache.usuarios.find(u => u.id === t.asignadoA) : null;
  const onclick = clientMode ? `openClienteTicket('${t.id}')` : `openTicket('${t.id}')`;
  return `
  <button class="stub" onclick="${onclick}">
    <div class="stub-num"><div class="n">${t.numero.split('-').slice(1).join('-')}</div><div class="y">${t.numero.split('-')[0]}</div></div>
    <div class="stub-body">
      <div class="stub-top"><div class="stub-asunto">${escapeHtml(t.asunto)}</div><div class="stub-time">${fmtRel(t.actualizado)}</div></div>
      <div class="stub-remitente">${escapeHtml(t.remitenteNombre)} · ${escapeHtml(t.remitenteEmail)}${lastMsg ? ' · última respuesta: ' + escapeHtml(lastMsg.autor) : ''}</div>
      <div class="stub-snippet">${escapeHtml(lastMsg ? lastMsg.cuerpo : '')}</div>
      <div class="stub-meta">
        <span class="tag tag-${slug(t.estado)}">${t.estado}</span><span class="tag tag-${slug(t.prioridad)}">${t.prioridad}</span><span class="tag tag-cat">${escapeHtml(t.categoria)}</span>
        ${!clientMode && grupo ? `<span class="tag tag-cliente">${escapeHtml(grupo.nombre)}</span>` : ''}
        ${!clientMode ? `<span class="tag tag-agente">${agente ? '👤 ' + escapeHtml(agente.nombre) + ' ' + escapeHtml(agente.apellido) : 'Sin asignar'}</span>` : ''}
      </div>
    </div>
  </button>`;
}

function renderDashboard() {
  const tickets = filteredTickets();
  const catOptions = ['todas', ...CAT.CATEGORIAS].map(c => `<option value="${c}" ${state.filters.categoria === c ? 'selected' : ''}>${c === 'todas' ? 'Todas las categorías' : c}</option>`).join('');
  const prioOptions = ['todas', ...CAT.PRIORIDADES].map(p => `<option value="${p}" ${state.filters.prioridad === p ? 'selected' : ''}>${p === 'todas' ? 'Toda prioridad' : p}</option>`).join('');
  const estOptions = ['todos', ...CAT.ESTADOS].map(e => `<option value="${e}" ${state.filters.estado === e ? 'selected' : ''}>${e === 'todos' ? 'Todo estado' : e}</option>`).join('');
  const grupoOptions = `<option value="todos">Todos los clientes</option>` + cache.clientes.map(g => `<option value="${g.id}" ${state.filters.grupo === g.id ? 'selected' : ''}>${escapeHtml(g.nombre)}</option>`).join('');
  const agenteOptions = `<option value="todos">Todo el equipo</option><option value="sin-asignar">Sin asignar</option>` + cache.usuarios.map(u => `<option value="${u.id}" ${state.filters.agente === u.id ? 'selected' : ''}>${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</option>`).join('');
  const list = tickets.length ? `<div class="stub-list">${tickets.map(renderStub).join('')}</div>` : `<div class="empty-state"><div class="big">No hay tickets que coincidan</div><div>Probá cambiar los filtros o simulá un correo entrante nuevo.</div></div>`;
  return `
    <div class="page-head"><div><h1>Bandeja de entrada general</h1><div class="sub">${cache.tickets.length} tickets en total · visibles para todo el equipo${state.filters.fecha ? ` · mostrando tickets del ${state.filters.fecha.split('-').reverse().join('/')}` : ''}</div></div>
      <button class="btn btn-primary" onclick="openNuevoCorreoModal()">+ Simular correo entrante</button></div>
    <div class="filters">
      <button class="btn ${state.filters.fecha === hoyStr() ? 'btn-primary' : 'btn-ghost'}" onclick="setFilter('fecha', hoyStr())">Tickets de hoy</button>
      <input type="date" value="${state.filters.fecha}" onchange="setFilter('fecha', this.value)" title="Buscar tickets de un día específico">
      ${state.filters.fecha ? `<button class="btn btn-ghost" onclick="setFilter('fecha','')">Ver todos los días</button>` : ''}
      <select onchange="setFilter('estado', this.value)">${estOptions}</select>
      <select onchange="setFilter('categoria', this.value)">${catOptions}</select>
      <select onchange="setFilter('prioridad', this.value)">${prioOptions}</select>
      <select onchange="setFilter('grupo', this.value)">${grupoOptions}</select>
      <select onchange="setFilter('agente', this.value)">${agenteOptions}</select>
      <input type="search" placeholder="Buscar…" value="${escapeHtml(state.filters.search)}" oninput="setFilter('search', this.value)">
    </div>
    ${list}`;
}

/* ---------------- Ticket detail ---------------- */

function renderThreadHtml(t) {
  return t.mensajes.map(m => {
    if (m.tipo === 'sistema') {
      return `<div class="msg msg-sistema"><div class="msg-head"><span class="msg-autor">&#9993; ${escapeHtml(m.autor)}</span><span>${fmtDateTime(m.fecha)}</span></div>
        <div class="msg-body">${escapeHtml(m.cuerpo)}</div>${m.destinatarios.length ? `<div class="msg-destinatarios">Enviado a: ${m.destinatarios.map(escapeHtml).join(', ')}</div>` : ''}</div>`;
    }
    return `<div class="msg msg-${m.tipo}"><div class="msg-head">
        <span class="msg-autor">${escapeHtml(m.autor)}${m.tipo === 'entrante' ? ' · ' + escapeHtml(t.remitenteEmail) : ''}${m.automatico ? ' <span class="auto-badge">&#9889; Automático</span>' : ''}</span>
        <span>${fmtDateTime(m.fecha)}</span></div>
      ${m.cc.length ? `<div class="msg-cc">CC: ${m.cc.map(escapeHtml).join(', ')}</div>` : ''}
      <div class="msg-body">${escapeHtml(m.cuerpo)}</div>
      ${m.adjuntos.length ? renderAdjuntos(m.adjuntos) : ''}
      ${m.firmaHtml ? `<div class="msg-firma">${m.firmaHtml}</div>` : ''}</div>`;
  }).join('');
}
function renderAdjuntos(adjuntos) {
  return `<div class="msg-attachments">${adjuntos.map(a => {
    if (a.tipo === 'imagen') return `<a href="${a.dataUrl}" download="${escapeHtml(a.nombre)}"><img src="${a.dataUrl}" alt="${escapeHtml(a.nombre)}"></a>`;
    if (a.tipo === 'video') return `<video controls src="${a.dataUrl}" class="attach-video"></video>`;
    return `<a class="attach-file" href="${a.dataUrl}" download="${escapeHtml(a.nombre)}">${attachIcon(a.tipo)} ${escapeHtml(a.nombre)} <span style="opacity:.7;">(${fmtSize(a.size)})</span></a>`;
  }).join('')}</div>`;
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
  return `
    <button class="back-link" onclick="go('dashboard')">&larr; Volver a la bandeja general</button>
    <div class="ticket-head">
      <div class="ticket-head-top">
        <div><div class="ticket-num-big">${t.numero}</div><h1>${escapeHtml(t.asunto)}</h1>
          <div class="ticket-from">De ${escapeHtml(t.remitenteNombre)} · ${escapeHtml(t.remitenteEmail)} · creado ${fmtDateTime(t.creado)}</div>
          ${lastMsg ? `<div class="ticket-from">Última respuesta: <strong>${escapeHtml(lastMsg.autor)}</strong> · ${fmtDateTime(lastMsg.fecha)}</div>` : ''}</div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
          <div class="stamp stamp-${slug(t.estado)}">${t.estado}</div>
          ${t.asignadoA !== uid_ ? `<button type="button" class="btn btn-ghost" onclick="tomarTicket('${t.id}')">Tomar este ticket</button>` : ''}
        </div>
      </div>
      <div class="meta-grid">
        <div class="field"><label>Categoría</label><select onchange="updateTicketField('${t.id}','categoria', this.value)">${catOptions}</select></div>
        <div class="field"><label>Prioridad</label><select onchange="updateTicketField('${t.id}','prioridad', this.value)">${prioOptions}</select></div>
        <div class="field"><label>Estado</label><select onchange="updateTicketField('${t.id}','estado', this.value)">${estOptions}</select></div>
        <div class="field"><label>Asignado a</label><select onchange="updateTicketField('${t.id}','asignadoA', this.value)">${asignOptions}</select></div>
        <div class="field"><label>Cliente</label><select onchange="updateTicketField('${t.id}','clienteId', this.value)">${grupoOptions}</select></div>
      </div>
    </div>
    <div class="thread">${thread}</div>
    <div class="reply-box">
      <div class="reply-tabs">
        <button class="reply-tab ${state.replyTab === 'saliente' ? 'active' : ''}" onclick="setReplyTab('saliente')">Responder como agente</button>
        <button class="reply-tab ${state.replyTab === 'entrante' ? 'active' : ''}" onclick="setReplyTab('entrante')">Simular respuesta del solicitante</button>
      </div>
      <form onsubmit="return submitReply(event, '${t.id}')">
        ${state.replyTab === 'saliente' && cache.respuestas.length ? `
        <div class="field"><label>Respuesta predefinida</label><select onchange="insertCanned(this)"><option value="">Elegir una respuesta…</option>${cache.respuestas.map(r => `<option value="${r.id}">${escapeHtml(r.titulo)}</option>`).join('')}</select></div>` : ''}
        <div class="field" style="margin-bottom:0;"><textarea name="cuerpo" placeholder="${state.replyTab === 'saliente' ? 'Escribí tu respuesta…' : 'Escribí el correo que llegaría del solicitante…'}" required></textarea></div>
        ${state.replyTab === 'saliente' && u.firma_html ? `<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--ink-soft);"><input type="checkbox" name="incluirFirma" checked> Incluir mi firma</label>` : ''}
        ${state.replyTab === 'saliente' ? `
        <div class="field" style="margin-top:12px;"><label>CC (copia a)</label><input name="cc" type="text" placeholder="otro-correo@ejemplo.com, otro2@ejemplo.com"><div class="hint-text">Opcional, separá con coma.</div></div>
        <div class="field"><label>Adjuntar archivos</label><input type="file" multiple accept="image/*,video/*,application/pdf" onchange="addPendingAttachments(this)"><div class="hint-text">Imágenes, PDF o video, máx. 3 MB.</div><div id="pending-attachments">${renderPendingChips()}</div></div>` : ''}
        <div class="reply-actions"><button type="submit" class="btn btn-primary">${state.replyTab === 'saliente' ? 'Enviar respuesta' : 'Simular correo entrante'}</button></div>
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
        ${g.rol ? `<div class="stub-meta"><span class="tag tag-cliente">${escapeHtml(g.rol)}</span></div>` : ''}
      </div></button>`).join('');
  const list = cache.clientes.length ? `<div class="stub-list">${rows}</div>` : `<div class="empty-state"><div class="big">Todavía no hay clientes</div><div>Dá de alta un cliente para agrupar sus tickets.</div></div>`;
  return `<div class="page-head"><div><h1>Clientes</h1><div class="sub">Listado de clientes, cada uno con sus propios tickets</div></div><button class="btn btn-primary" onclick="openNuevoGrupoModal()">+ Nuevo cliente</button></div>${list}`;
}

async function renderGrupoDetailAsync(id) {
  const g = cache.clientes.find(x => x.id === id);
  if (!g) return `<div class="empty-state">Cliente no encontrado.</div>`;
  const tickets = await loadClienteDetalleTickets(id);
  const list = tickets.length ? `<div class="stub-list">${tickets.map(t => renderStub(t)).join('')}</div>` : `<div class="empty-state"><div class="big">Este cliente todavía no tiene tickets</div></div>`;
  return `
    <button class="back-link" onclick="go('grupos')">&larr; Volver a clientes</button>
    <div class="ticket-head">
      <div class="ticket-head-top"><div><div class="ticket-num-big">CLIENTE</div><h1>${escapeHtml(g.nombre)}</h1>
        <div class="ticket-from">${[g.direccion, g.telefono, g.correo].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        <div class="ticket-from">Portal de cliente: ${g.tienePortal ? `<strong style="color:var(--stamp-green);">habilitado</strong>` : '<strong style="color:var(--gray);">sin configurar</strong>'}</div></div>
        ${g.rol ? `<div class="stamp stamp-abierto">${escapeHtml(g.rol)}</div>` : ''}</div>
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
      <div class="field"><label>Respuesta a enviar</label><select data-field="respuestaId">${respOpts(p.respuestaId)}</select></div>
      <div class="field" style="margin-bottom:0;"><label>Cambiar estado a</label><select data-field="accionEstado">${estadoOpts(p.accionEstado)}</select></div>
    </div>`).join('');
}

function renderAutomatizaciones() {
  const rows = cache.automatizaciones.map(a => {
    const pasosHtml = a.pasos.map((p, idx) => {
      const resp = cache.respuestas.find(r => r.id === p.respuestaId);
      const disparador = p.matchAny ? 'cualquier respuesta del cliente' : (p.palabras || []).join(', ');
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

function renderUsuarios() {
  const rows = cache.usuarios.map(u => `<div class="user-row"><div class="avatar">${initials(u.nombre, u.apellido)}</div>
    <div><div class="u-name">${escapeHtml(u.nombre)} ${escapeHtml(u.apellido)}</div><div class="u-sub">${escapeHtml(u.email)}${u.telefono ? ' · ' + escapeHtml(u.telefono) : ''}</div></div>
    <span class="tag tag-cat cargo-pill">${escapeHtml(u.cargo)}</span></div>`).join('');
  return `<div class="page-head"><div><h1>Usuarios</h1><div class="sub">${cache.usuarios.length} personas con acceso a la plataforma</div></div></div><div class="user-list">${rows}</div>`;
}

function renderPerfil() {
  const u = currentUser();
  const cargoOptions = CAT.CARGOS.map(c => `<option value="${c}" ${u.cargo === c ? 'selected' : ''}>${c}</option>`).join('');
  return `
    <div class="page-head"><div><h1>Mi perfil</h1><div class="sub">Tus datos dentro de la plataforma</div></div></div>
    <div class="card card-narrow"><form onsubmit="return submitPerfil(event)">
      <div class="field-row"><div class="field"><label>Nombre</label><input name="nombre" value="${escapeHtml(u.nombre)}" required></div><div class="field"><label>Apellido</label><input name="apellido" value="${escapeHtml(u.apellido)}" required></div></div>
      <div class="field"><label>Teléfono</label><input name="telefono" value="${escapeHtml(u.telefono || '')}"></div>
      <div class="field"><label>Correo electrónico</label><input value="${escapeHtml(u.email)}" disabled></div>
      <div class="field"><label>Cargo</label><select name="cargo">${cargoOptions}</select></div>
      <div class="field"><label>Nueva contraseña (opcional)</label><input name="password" type="password" placeholder="Dejar en blanco para no cambiarla"></div>
      <button type="submit" class="btn btn-primary btn-block">Guardar cambios</button>
    </form></div>
    <div class="card card-narrow" style="margin-top:18px;">
      <div style="font-weight:600;font-size:14.5px;margin-bottom:4px;">Firma</div>
      <div class="hint-text" style="margin-bottom:12px;">Se agrega automáticamente al responder tickets.</div>
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
    </div>`;
}

function renderConfiguracion() {
  const c = cache.configuracion;
  return `<div class="page-head"><div><h1>Configuración</h1><div class="sub">Ajustes generales del sistema</div></div></div>
    <div class="card card-narrow" style="max-width:560px;">
      <div style="font-weight:600;font-size:14.5px;margin-bottom:4px;">Casilla de correo de soporte</div>
      <div class="hint-text" style="margin-bottom:16px;">Conectá tu casilla real para que reciba correos y cree tickets solos, y para que las respuestas le lleguen de verdad al cliente.</div>
      <form onsubmit="return submitConfiguracion(event)">
        <div class="field"><label>Correo electrónico de la casilla</label><input name="casillaEmail" type="email" value="${escapeHtml(c.casillaEmail || '')}" placeholder="tickets@borcam.com.uy" required></div>
        <div class="field"><label>Nombre para mostrar</label><input name="casillaNombre" value="${escapeHtml(c.casillaNombre || '')}" placeholder="Ej: Mesa de Soporte"></div>

        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin:6px 0 16px;padding-top:12px;border-top:1px dashed var(--line-strong);">
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

        <button type="submit" class="btn btn-primary btn-block">Guardar configuración</button>
      </form>
      <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--line-strong);">
        <button type="button" class="btn btn-ghost btn-block" onclick="probarConexionCorreo()">Probar conexión</button>
        <div id="resultado-prueba" style="margin-top:8px;"></div>
      </div>
    </div>`;
}

/* ---------------- Modales ---------------- */

function renderActiveModal() {
  if (state.modal === 'nuevo-correo') return renderNuevoCorreoModal();
  if (state.modal === 'nueva-respuesta' || state.modal === 'editar-respuesta') return renderRespuestaModal();
  if (state.modal === 'nuevo-grupo' || state.modal === 'editar-grupo') return renderGrupoModal();
  if (state.modal === 'nueva-automatizacion' || state.modal === 'editar-automatizacion') return renderAutomatizacionModal();
  return '';
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
      <div class="field-row"><div class="field"><label>Teléfono</label><input name="telefono" value="${g ? escapeHtml(g.telefono || '') : ''}"></div><div class="field"><label>Correo electrónico</label><input name="correo" type="email" value="${g ? escapeHtml(g.correo || '') : ''}"></div></div>
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

function renderAuth() {
  const mode = state.authView || 'login';
  if (mode === 'login') {
    return `<div class="auth-wrap"><div class="auth-card"><div class="brand-mark">${logoSvg()}<span class="name">Sistema de Tickets</span></div>
      <h1>Iniciar sesión</h1><p class="sub">Accedé con tu correo y contraseña.</p>
      <form onsubmit="return handleLogin(event)">
        <div class="field"><label>Correo electrónico</label><input name="email" type="email" required></div>
        <div class="field"><label>Contraseña</label><input name="password" type="password" required></div>
        ${state.authError ? `<div class="error-text">${escapeHtml(state.authError)}</div>` : ''}
        <button type="submit" class="btn btn-primary btn-block">Ingresar</button>
      </form>
      <div class="auth-toggle">¿No tenés cuenta? <button onclick="goAuth('register')">Registrate</button></div>
    </div></div>`;
  }
  return `<div class="auth-wrap"><div class="auth-card"><div class="brand-mark">${logoSvg()}<span class="name">Sistema de Tickets</span></div>
    <h1>Crear cuenta</h1><p class="sub">Registrate para gestionar tickets.</p>
    <form onsubmit="return handleRegister(event)">
      <div class="field-row"><div class="field"><label>Nombre</label><input name="nombre" required></div><div class="field"><label>Apellido</label><input name="apellido" required></div></div>
      <div class="field"><label>Teléfono</label><input name="telefono"></div>
      <div class="field"><label>Correo electrónico</label><input name="email" type="email" required></div>
      <div class="field"><label>Cargo</label><select name="cargo" required><option value="" disabled selected>Elegí un cargo</option>${(CAT.CARGOS.length ? CAT.CARGOS : ['Técnico', 'Encargado', 'Administrativo', 'Director']).map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
      <div class="field-row"><div class="field"><label>Contraseña</label><input name="password" type="password" required></div><div class="field"><label>Repetir contraseña</label><input name="password2" type="password" required></div></div>
      ${state.regError ? `<div class="error-text">${escapeHtml(state.regError)}</div>` : ''}
      <button type="submit" class="btn btn-primary btn-block">Crear cuenta</button>
    </form>
    <div class="auth-toggle">¿Ya tenés cuenta? <button onclick="goAuth('login')">Iniciar sesión</button></div>
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
  else if (state.view === 'grupo') { inner = '<div class="empty-state">Cargando…</div>'; renderGrupoDetailAsync(state.grupoId).then(html => { const el = document.querySelector('.content'); if (el && state.view === 'grupo') el.innerHTML = html; }); }
  else if (state.view === 'automatizaciones') inner = renderAutomatizaciones();
  else if (state.view === 'configuracion') inner = renderConfiguracion();
  else inner = renderDashboard();
  app.innerHTML = renderShell(inner);
}

boot();
