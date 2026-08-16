# Ticketera — Guía de puesta en marcha (sin tocar código ni consola)

Esta carpeta es la aplicación completa: backend real (Node.js), base de datos
(PostgreSQL) y el frontend. Seguí estos pasos una sola vez para tenerla
funcionando en una página web propia.

## Resumen de lo que vamos a usar (las 3 gratis, sin tarjeta)

1. **Supabase** → la base de datos donde se guardan tickets, usuarios y clientes.
2. **GitHub** → donde queda guardado el código (se sube arrastrando la carpeta).
3. **Render** → "enciende" la aplicación y te da la página web con una URL.

---

## Paso 1 — Crear la base de datos en Supabase

1. Entrá a https://supabase.com y creá una cuenta gratis.
2. Click en **"New project"**. Ponele un nombre (ej: `ticketera-borcam`),
   elegí una contraseña para la base (guardala, la vas a necesitar) y una
   región cercana. Click en **"Create new project"** y esperá 1-2 minutos.
3. En el menú de la izquierda, andá a **SQL Editor** → **New query**.
4. Abrí el archivo `schema.sql` de esta carpeta, copiá **todo** su contenido,
   pegalo en el editor de Supabase, y click en **"Run"**. Esto crea todas las
   tablas necesarias (usuarios, tickets, clientes, etc.).
5. Andá a **Project Settings** (ícono de engranaje) → **Database** →
   **Connection string** → pestaña **URI**. Copiá ese texto completo
   (empieza con `postgresql://postgres:...`). Reemplazá donde dice
   `[YOUR-PASSWORD]` por la contraseña que pusiste en el paso 2.
   Guardalo, es tu `DATABASE_URL`.

## Paso 2 — Subir el código a GitHub

1. Entrá a https://github.com y creá una cuenta gratis (si no tenés).
2. Click en el **"+"** arriba a la derecha → **"New repository"**.
   Nombre: `ticketera-borcam`. Dejalo en **Public** o **Private** (cualquiera
   sirve). Click en **"Create repository"**.
3. En la página del repositorio recién creado, buscá el link
   **"uploading an existing file"** (o el botón **"Add file" → "Upload files"**).
4. Arrastrá **todos los archivos y carpetas** de esta carpeta del proyecto
   (incluida la carpeta `public`) a esa página. Esperá a que terminen de
   cargar y click en **"Commit changes"**.

## Paso 3 — Publicar la aplicación en Render

1. Entrá a https://render.com y creá una cuenta gratis (podés usar tu
   cuenta de GitHub para entrar más rápido). No pide tarjeta.
2. Click en **"New +"** → **"Blueprint"**.
3. Conectá tu cuenta de GitHub si te lo pide, y elegí el repositorio
   `ticketera-borcam` que creaste. Render va a detectar automáticamente el
   archivo `render.yaml` de esta carpeta.
4. Te va a pedir el valor de **DATABASE_URL**: pegá ahí el connection
   string que copiaste de Supabase en el Paso 1.
5. Click en **"Apply"** / **"Deploy"**. Esperá 2-3 minutos mientras se instala
   y arranca.
6. Cuando termine, arriba vas a ver la URL de tu aplicación, algo como
   `https://ticketera-borcam.onrender.com`. **Esa es tu página**, se puede
   abrir desde cualquier lugar, en la compu o el celular.

> Nota: en el plan gratis, si nadie entra durante 15 minutos la aplicación
> "se duerme" y tarda unos segundos en despertar la próxima vez que alguien
> entra. No se pierde ningún dato — solo tarda un poco el primer ingreso del
> día.

## Paso 4 — Crear tu primer usuario

1. Abrí la URL que te dio Render.
2. Click en **"Registrate"** y creá tu primer usuario del equipo (vos).
3. Desde ahí ya podés dar de alta a los demás usuarios, clientes,
   respuestas predefinidas y automatizaciones — todo lo que armamos.

---

## Si necesitás ayuda

Si algo no carga o da error, contame en qué paso quedaste y qué mensaje
viste (una captura de pantalla ayuda mucho) y seguimos de ahí.
