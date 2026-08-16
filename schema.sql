-- Esquema de la base de datos de Ticketera
-- Pegar este archivo completo en Supabase → SQL Editor → Run (una sola vez)

create extension if not exists "pgcrypto";

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  apellido text not null,
  telefono text default '',
  email text unique not null,
  password_hash text not null,
  cargo text not null,
  firma_html text default '',
  creado timestamptz default now()
);

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  direccion text default '',
  telefono text default '',
  correo text default '',
  rol text default '',
  portal_password_hash text default null,
  creado timestamptz default now()
);

create table if not exists respuestas_predefinidas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  cuerpo text not null
);

create table if not exists automatizaciones (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  activo boolean default true
);

create table if not exists automatizacion_pasos (
  id uuid primary key default gen_random_uuid(),
  automatizacion_id uuid references automatizaciones(id) on delete cascade,
  orden int not null,
  match_any boolean default false,
  palabras text[] default '{}',
  respuesta_id uuid references respuestas_predefinidas(id),
  accion_estado text default 'Sin cambio'
);

create table if not exists contadores (
  anio int primary key,
  valor int not null default 0
);

create table if not exists configuracion (
  id int primary key default 1,
  casilla_email text default '',
  casilla_nombre text default '',
  check (id = 1)
);
insert into configuracion (id, casilla_email, casilla_nombre)
  values (1, '', '') on conflict (id) do nothing;

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  numero text unique not null,
  asunto text not null,
  categoria text default 'Otro',
  prioridad text default 'Media',
  estado text default 'Abierto',
  remitente_nombre text not null,
  remitente_email text not null,
  asignado_a uuid references usuarios(id) on delete set null,
  cliente_id uuid references clientes(id) on delete set null,
  automatizacion_activa_id uuid references automatizaciones(id) on delete set null,
  automatizacion_activa_paso int,
  creado timestamptz default now(),
  actualizado timestamptz default now()
);

create table if not exists mensajes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references tickets(id) on delete cascade,
  tipo text not null, -- entrante | saliente | sistema
  autor text not null,
  cuerpo text not null,
  cc text[] default '{}',
  adjuntos jsonb default '[]',
  firma_html text default '',
  destinatarios text[] default '{}',
  automatico boolean default false,
  fecha timestamptz default now()
);

create index if not exists idx_mensajes_ticket on mensajes(ticket_id);
create index if not exists idx_tickets_cliente on tickets(cliente_id);
