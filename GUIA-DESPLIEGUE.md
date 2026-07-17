# Guía de despliegue — Pulso Noticioso

Cómo está montado el portal y cómo tocarlo sin romperlo.

> **Estado a 17/07/2026:** el Worker está desplegado y verificado. Lo único que
> puede faltar es el push del sitio al repo `Q`.

---

## 1. Arquitectura

El sitio y su API viven en **sitios distintos**, y esa es la decisión de fondo:

```
┌──────────────────────────────────────────────────────────────────────┐
│  VISITANTE                                                           │
│                                                                      │
│  pulsonoticioso.org  ◄────── GitHub Pages ◄────── repo Q (público)   │
│  index.html + datos/*.json                                           │
│  (lectura pura, sin servidor)                                        │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  ADMINISTRADOR                                                       │
│                                                                      │
│  pulsonoticioso.org/admin.html                                       │
│      │                                                               │
│      │  POST https://pulso-api.riosdigitali.workers.dev/api/*        │
│      │  { clave: "...", ... }                    ⚠️ OTRO DOMINIO      │
│      ▼                                              → CORS aplica    │
│  Cloudflare Worker "pulso-api"                                       │
│      ├── ADMIN_PASSWORD  (Secret, cifrada)                           │
│      ├── GITHUB_TOKEN    (Secret, cifrada)                           │
│      ├── GITHUB_REPO     = riosdigitali-create/Q                     │
│      └── GITHUB_BRANCH   = main                                      │
│      │                                                               │
│      │  1. ¿el origen está en la lista blanca?  → si no, 403         │
│      │  2. ¿la clave es correcta? (tiempo constante) → si no, 401    │
│      │  3. ¿el path pasa la allowlist? → si no, 400                  │
│      │  4. API de GitHub con el token                                │
│      ▼                                                               │
│  commit en repo Q → GitHub Pages reconstruye → dominio (30-60 s)     │
└──────────────────────────────────────────────────────────────────────┘
```

### Por qué así, y no todo en Cloudflare

`pulsonoticioso.org` está registrado en **GoDaddy** y su DNS apunta a GitHub
Pages. Mover el dominio a Cloudflare habría permitido tenerlo todo en Pages
(sitio + función juntos, sin CORS), pero implicaba cambiar nameservers y esperar
propagación. Se descartó.

La consecuencia: **GitHub Pages no ejecuta código**. Por eso la API tuvo que
salirse a un Worker independiente, y por eso existe toda la parte de CORS.

**El repositorio de Git es la base de datos.** Cada cambio del panel es un
commit, con historial completo y rollback a cualquier punto.

---

## 2. Estructura de archivos

```
repo Q (público, GitHub Pages)
├─ CNAME                     ⚠️ NO BORRAR: es lo que ata el dominio a Pages
├─ index.html                Sitio público. Autónomo. Sin secretos.
├─ admin.html                Panel. Autónomo. Sin secretos. Llama a API_BASE.
├─ fuentes/                  Anton, Playfair Display, Source Sans 3 (SIL OFL)
├─ datos/
│  ├─ contenido.json         Notas y ticker. Lo escribe el panel.
│  └─ ajustes.json           Radio, YouTube, redes, noticias en vivo.
├─ contenido/imagenes/       Fotos subidas desde el panel.
└─ worker/pulso-api.js       Copia de referencia del Worker (NO se ejecuta aquí)

Cloudflare (aparte del repo)
└─ Worker "pulso-api"        El código que sí se ejecuta.
```

Sin `package.json`, sin build step. Lo que hay en el repo es lo que se sirve.

> **Ojo con `worker/pulso-api.js`:** es solo una copia para leer. El código que
> corre de verdad es el que está pegado en el dashboard de Cloudflare. Si cambias
> uno, cambia el otro a mano o quedarán desincronizados.

---

## 3. El Worker

**URL:** `https://pulso-api.riosdigitali.workers.dev`

Si la abres en el navegador te dirá **"Origen no permitido"**. Eso es correcto,
no es un fallo: solo acepta peticiones que vengan de `pulsonoticioso.org`.

### Variables (Settings → Variables and Secrets)

| Variable | Tipo | Valor |
|---|---|---|
| `ADMIN_PASSWORD` | **Secret** | la contraseña del panel |
| `GITHUB_TOKEN` | **Secret** | token fine-grained, sin caducidad |
| `GITHUB_REPO` | Text | `riosdigitali-create/Q` |
| `GITHUB_BRANCH` | Text | `main` |

> **Las variables no se aplican hasta que redespliegas.** Es el error nº1.

### Cambiar el código del Worker

1. Cloudflare → Workers & Pages → `pulso-api` → **Edit code**
2. Clic dentro del editor, **Ctrl+A**, **Ctrl+V**
3. Comprueba abajo a la izquierda que ponga **0 errores** antes de desplegar
4. **Deploy**

Si ves errores de "ya declarado", es que el código se pegó dos veces: Ctrl+A,
Suprimir, y pega una sola vez.

### El token de GitHub

Fine-grained, **sin fecha de caducidad**, con acceso a un solo repo
(`riosdigitali-create/Q`) y un solo permiso (`Contents: Read and write`).

Al no caducar, solo deja de servir si lo revocas a mano en
[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens).
Si alguna vez sospechas que se filtró: revócalo ahí, genera otro y cambia la
variable en Cloudflare. Cinco minutos, sin tocar código.

---

## 4. Seguridad

### Qué protege el sistema, y cómo

| Capa | Qué hace |
|---|---|
| **Token del lado del servidor** | Vive solo en Cloudflare. Nunca viaja al navegador. Ver el código fuente de `admin.html` no revela nada. |
| **CORS con lista blanca** | Solo `pulsonoticioso.org` puede llamar a la API. Sin esto, cualquier web podría probar contraseñas desde los navegadores de sus visitantes, saltándose el freno por IP. Nunca se responde `Allow-Origin: *`. |
| **Clave validada en todas las rutas** | No solo en `/api/login`. Si solo se validara ahí, `/api/save` quedaría abierta a cualquiera que supiera la URL. |
| **Comparación en tiempo constante** | XOR byte a byte, no `===`. `===` aborta en el primer byte distinto, y esa diferencia de microsegundos permite reconstruir la clave midiendo tiempos. |
| **Allowlist de rutas** | Lo más importante. El Worker no es un proxy a GitHub. |
| **Token de alcance mínimo** | Un repo, permiso `Contents`. El peor escenario es que alguien toque ese repositorio. |
| **Rate limiting** | 8 fallos por IP → un minuto de bloqueo. |

### La allowlist, en concreto

```js
const RE_UPLOAD = /^contenido\/imagenes\/[\w.\-]+\.(?:jpe?g|png|webp|gif)$/;
const RE_SAVE   = /^datos\/(contenido|ajustes)\.json$/;
const RE_DELETE = /^contenido\/imagenes\/[\w.\-]+\.(?:jpe?g|png|webp|gif)$/;
```

Ni con la contraseña correcta se puede escribir sobre `index.html` ni sobre
`admin.html`. Sin estas tres líneas, `/api/upload` sería "escribe cualquier
archivo del repo con una contraseña" — es decir, ejecutar código arbitrario en
tu dominio. `[\w.\-]+` no admite `/` ni `..`, así que tampoco hay path traversal.

Van **sin el flag `/i` a propósito**: con `/i`, `CONTENIDO/IMAGENES/x.jpg` pasaría
el filtro, y como Git distingue mayúsculas eso crearía una carpeta paralela real
con archivos huérfanos que el panel nunca vería.

### 🔴 Deuda de seguridad conocida

El repo `Q` es **público** y su historial conserva para siempre las contraseñas
del sistema anterior (`pulso2026`, `zivcreativo`). Subir el sitio nuevo **no las
borra**: siguen en los commits viejos.

- **Impacto real: bajo.** Aquel panel solo escribía en el navegador de quien lo
  abría; nadie podía tocar el sitio con esas claves.
- **El riesgo verdadero es la reutilización.** Si esas contraseñas se usan en
  algún otro servicio, hay que cambiarlas ahí. Dalas por quemadas.

El repo tiene que seguir público: GitHub Pages desde repos privados requiere
plan de pago. No es un problema — el código nuevo no lleva secretos dentro.

### Sobre la contraseña del panel

Si es corta (6 dígitos = un millón de combinaciones), el rate limiting es un
freno real pero imperfecto: vive en la memoria del isolate, así que no cuenta de
forma global entre centros de datos ni sobrevive al reciclado del proceso.

Lo que sí limita el daño es la allowlist: aun adivinando la clave, lo peor que se
puede hacer es alterar notas y subir imágenes — todo con historial en Git y
revertible con un clic.

Cambiar `ADMIN_PASSWORD` por una frase larga (`pulso-late-verdad-2026-saltillo`)
y redesplegar convierte el ataque en inviable. No hay que tocar código.

---

## 5. Costes

| Concepto | Plan | Coste |
|---|---|---|
| GitHub Pages — hosting y CDN | Free | 0 € |
| Cloudflare Workers | Free | 0 € — 100.000 peticiones/día |
| GitHub repositorio público | Free | 0 € |
| GitHub API | Free | 0 € — 5.000 peticiones/hora |
| Dominio pulsonoticioso.org | GoDaddy | lo que ya pagas |
| **Total añadido** | | **0 €/mes** |

Las 100.000 peticiones/día del Worker son para el panel, no para los visitantes:
el sitio público no toca el Worker jamás. Un administrador no se acerca ni de
lejos a ese número.

---

## 6. Límites del sistema

Consecuencias directas de "sin base de datos, sin servidor, 0 €/mes". No son bugs.

- **30-60 segundos** entre pulsar Publicar y verlo en el sitio. **No sirve para
  nada en tiempo real.**
- **Quien ya tenga la página abierta no ve el cambio hasta que recargue.** El
  sitio lee los JSON una sola vez, al arrancar. Lo único que se refresca solo cada
  5 minutos son las noticias en vivo del RSS, no tus notas. *(Se puede añadir una
  relectura automática cada 2 minutos; está sin hacer.)*
- **Un solo usuario, una sola contraseña.** Sin roles ni auditoría por persona.
  El historial de Git dice qué cambió y cuándo, pero todos los commits los firma
  el mismo token.
- **Sin edición simultánea.** Dos pestañas editando a la vez: la última en
  publicar pisa a la otra sin avisar.
- **El borrador vive en un solo navegador** (`localStorage`). Cambias de equipo y
  se queda atrás. Solo lo publicado es permanente.
- **Las noticias en vivo dependen de `api.rss2json.com`**, un servicio gratuito de
  terceros sin garantías. Si cae, el portal sigue mostrando las notas propias.
- **El repo no es infinito.** Cada imagen es un commit y Git guarda todas las
  versiones para siempre. Con cientos al año no pasa nada; con miles, conviene
  archivar. El Worker avisa si el árbol de GitHub llega a truncarse.
- **Dos copias del Worker** (dashboard y `worker/pulso-api.js`) que hay que
  sincronizar a mano.

---

## 7. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| El panel dice **"Modo vista previa"** en el sitio publicado | No alcanza el Worker | Comprueba que `API_BASE` en `admin.html` coincida con la URL real del Worker y que el Worker esté desplegado. |
| **"Origen no permitido"** desde el panel | El sitio se abrió desde una URL que no está en la lista blanca del Worker | Entra por `https://pulsonoticioso.org/admin.html`, no por otra dirección. |
| **"Faltan variables..."** | Configuradas pero sin redesplegar | Worker → Deploy. |
| **"Contraseña incorrecta"** con la clave buena | `ADMIN_PASSWORD` tiene un espacio al final | Vuelve a escribirla y redespliega. |
| **"GitHub 404"** al publicar | `GITHUB_REPO` mal escrito | Debe ser `riosdigitali-create/Q`, sin `https://` ni `.git`. |
| **"GitHub 403"** al publicar | Al token le falta `Contents: Read and write`, o fue revocado | Revisa el token en GitHub. |
| Publiqué y el sitio no cambia | Caché / rebuild de Pages | Espera 60 s y recarga con Ctrl+F5. Comprueba que el commit existe en el repo `Q`. |
| **El dominio dejó de funcionar** | Se borró el `CNAME` del repo | Recréalo con `pulsonoticioso.org` dentro. |
| Las tipografías se ven mal | La carpeta `fuentes/` no se subió | Verifica que los 8 `.woff2` están en el repo. |

---

## 8. Rollback

Todo cambio es un commit, así que deshacer cualquier cosa es trivial:

1. Repo `Q` → **Commits**
2. Busca el commit anterior al desastre
3. **Revert** (o edita `datos/contenido.json` a mano en la web de GitHub)
4. GitHub Pages redespliega solo en 30-60 s
