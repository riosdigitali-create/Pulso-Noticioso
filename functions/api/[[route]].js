/**
 * PULSO NOTICIOSO — Función edge (Cloudflare Pages Functions)
 * =============================================================================
 * Única pieza de servidor de todo el proyecto. Su trabajo es exactamente uno:
 * ser el intermediario entre el panel de administración (navegador, sin
 * credenciales) y la API de GitHub (que sí las necesita).
 *
 * El token de GitHub vive aquí, como variable de entorno cifrada en Cloudflare,
 * y NUNCA se envía al navegador. Por eso el panel puede ser un HTML público:
 * no contiene ningún secreto, solo sabe hablar con esta función.
 *
 * Rutas (todas POST):
 *   /api/login    valida la contraseña, no crea sesión
 *   /api/list     lista los archivos del repo (Git Trees API)
 *   /api/upload   sube una imagen
 *   /api/save     guarda un JSON de estado
 *   /api/delete   borra una imagen
 */

/* =============================================================================
   ALLOWLIST — la parte más importante del archivo
   -----------------------------------------------------------------------------
   Esta función NO es un proxy genérico a GitHub. Con la contraseña correcta,
   un atacante podría, si no existieran estas tres regex, sobrescribir
   index.html, admin.html o esta misma función y ejecutar lo que quisiera en el
   dominio. La contraseña es UNA capa; la allowlist es la que de verdad limita
   el daño.

   Regla: cada ruta de escritura solo puede tocar los paths que coincidan con su
   patrón. Nada más. Ni con la clave correcta.
   ========================================================================== */

// Solo imágenes, solo dentro de contenido/imagenes/, sin subcarpetas.
//
// [\w.\-]+ no puede contener "/" ni "..", así que no hay path traversal posible.
//
// Sin el flag /i, y esto NO es un descuido: con /i, la ruta
// "CONTENIDO/IMAGENES/x.jpg" pasaría el filtro. Git distingue mayúsculas, así
// que eso crearía una carpeta paralela real que el panel nunca listaría —
// archivos huérfanos en el repo, invisibles desde la interfaz. El directorio y
// la extensión se exigen en minúsculas; el panel ya los genera así.
// El nombre en sí (\w) sí admite mayúsculas.
const RE_UPLOAD = /^contenido\/imagenes\/[\w.\-]+\.(?:jpe?g|png|webp|gif)$/;

// Lista cerrada y explícita. Solo estos dos archivos son escribibles.
const RE_SAVE = /^datos\/(contenido|ajustes)\.json$/;

// Solo imágenes. Los JSON de estado no se borran nunca desde la API:
// si se pudieran borrar, un fallo del panel dejaría el sitio sin contenido.
const RE_DELETE = /^contenido\/imagenes\/[\w.\-]+\.(?:jpe?g|png|webp|gif)$/;

// Tamaño máximo por imagen. GitHub admite hasta 100 MB vía API, pero una foto
// de portada que pese más de 5 MB es siempre un error del usuario, no una
// necesidad. Cortarlo aquí evita commits gigantes e irreversibles en el repo.
const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;

/* =============================================================================
   RATE LIMITING
   -----------------------------------------------------------------------------
   Hay un solo usuario y una sola contraseña: sin freno, la clave se puede
   probar por fuerza bruta a la velocidad que aguante el edge.

   Este Map vive en la memoria del isolate de Cloudflare. Es deliberadamente
   simple porque la regla nº1 del proyecto es "sin base de datos":
   Cloudflare KV daría un contador global real, pero añade un binding y un
   servicio más que mantener.

   Lo que esto SÍ hace: convierte un ataque de miles de intentos por segundo en
   uno de unos pocos por minuto por PoP. Lo que NO hace: contar de forma global
   ni sobrevivir al reciclado del isolate. Es un freno, no una puerta blindada.
   La defensa real es una contraseña larga. Está documentado en GUIA-DESPLIEGUE.md.
   ========================================================================== */
const intentosFallidos = new Map(); // ip -> { n, ultimo, bloqueadoHasta }
const MAX_INTENTOS = 8;             // fallos consecutivos antes de bloquear
const BLOQUEO_MS = 60 * 1000;       // duración del bloqueo
const VENTANA_MS = 10 * 60 * 1000;  // tras este silencio, los fallos caducan
const MAX_IPS = 5000;               // techo del Map

function estaBloqueada(ip) {
  const registro = intentosFallidos.get(ip);
  if (!registro) return false;
  if (registro.bloqueadoHasta > Date.now()) return true;

  // Ojo con esta condición: la versión ingenua era borrar el registro siempre
  // que la IP no estuviera bloqueada, y eso reseteaba el contador en CADA
  // petición — el bloqueo no llegaba a dispararse nunca. Solo se limpia si el
  // bloqueo ya expiró, o si la IP lleva callada más de la ventana.
  if (registro.bloqueadoHasta > 0 || Date.now() - registro.ultimo > VENTANA_MS) {
    intentosFallidos.delete(ip);
  }
  return false;
}

function apuntarFallo(ip) {
  // Techo defensivo: un atacante rotando IPs haría crecer el Map hasta agotar
  // la memoria del isolate. Vaciarlo entero es aceptable — perder contadores
  // solo relaja el freno, nunca abre una puerta.
  if (intentosFallidos.size > MAX_IPS) intentosFallidos.clear();

  const registro = intentosFallidos.get(ip) || { n: 0, ultimo: 0, bloqueadoHasta: 0 };
  registro.n++;
  registro.ultimo = Date.now();
  if (registro.n >= MAX_INTENTOS) {
    registro.bloqueadoHasta = Date.now() + BLOQUEO_MS;
    registro.n = 0;
  }
  intentosFallidos.set(ip, registro);
}

function limpiarFallos(ip) {
  intentosFallidos.delete(ip);
}

/* =============================================================================
   UTILIDADES
   ========================================================================== */

const json = (datos, estado = 200) =>
  new Response(JSON.stringify(datos), {
    status: estado,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Ninguna respuesta de la API debe cachearse: el panel siempre necesita
      // el estado real del repo, no una copia de hace un minuto.
      'cache-control': 'no-store',
    },
  });

/**
 * Compara dos claves en tiempo constante.
 *
 * Por qué no `===`: la comparación de strings de JavaScript aborta en el primer
 * byte distinto. Eso hace que "a....." tarde mediblemente menos que "2367..",
 * y con suficientes muestras la clave se puede reconstruir carácter a carácter
 * midiendo tiempos de respuesta. El XOR recorre siempre todos los bytes.
 */
function clavesIguales(a, b) {
  const codificador = new TextEncoder();
  const ba = codificador.encode(String(a ?? ''));
  const bb = codificador.encode(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  let diferencia = 0;
  for (let i = 0; i < ba.length; i++) diferencia |= ba[i] ^ bb[i];
  return diferencia === 0;
}

/** Convierte texto UTF-8 a base64, que es lo que exige la API de GitHub. */
function aBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let binario = '';
  // En trozos, porque String.fromCharCode(...array) revienta la pila con
  // arrays grandes (un JSON de contenido puede tener cientos de KB).
  const TROZO = 0x8000;
  for (let i = 0; i < bytes.length; i += TROZO) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + TROZO));
  }
  return btoa(binario);
}

/** Cabeceras comunes de la API de GitHub. El User-Agent es obligatorio. */
function cabecerasGitHub(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'pulso-noticioso-panel',
    'content-type': 'application/json',
  };
}

/**
 * Devuelve el sha actual de un archivo, o null si no existe.
 *
 * GitHub exige el sha del blob anterior para sobrescribir un archivo: es su
 * control de concurrencia. Sin él, el PUT falla con 409. Con él, el commit
 * reemplaza limpiamente. Un 404 aquí no es un error: significa "archivo nuevo".
 */
async function shaOf(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${env.GITHUB_BRANCH}`;
  const respuesta = await fetch(url, { headers: cabecerasGitHub(env) });
  if (respuesta.status === 404) return null;
  if (!respuesta.ok) throw new Error(`GitHub ${respuesta.status} al leer el sha de ${path}`);
  const datos = await respuesta.json();
  return datos.sha || null;
}

/** PUT de un archivo (crear o sobrescribir). */
async function escribirArchivo(env, path, base64, mensaje) {
  const sha = await shaOf(env, path);
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;
  const respuesta = await fetch(url, {
    method: 'PUT',
    headers: cabecerasGitHub(env),
    body: JSON.stringify({
      message: mensaje,
      content: base64,
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}), // sin sha = crear; con sha = sobrescribir
    }),
  });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`GitHub ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }
  return respuesta.json();
}

/* =============================================================================
   RUTAS
   ========================================================================== */

/** POST /api/login — confirma que la clave sirve y que hay backend detrás. */
async function rutaLogin() {
  // La validación de la clave ya ocurrió en onRequest, común a todas las rutas.
  // Esta ruta no crea sesión ni devuelve token: solo un "sí".
  return json({ ok: true, publicacion: true });
}

/**
 * POST /api/list — lista los archivos publicados.
 *
 * POR QUÉ TREES Y NO /contents (esto es crítico, no lo cambies):
 * la API /contents devuelve como mucho 1000 entradas y NO pagina — corta en
 * silencio, sin error ni aviso. Como el panel reconstruye su vista del
 * contenido a partir de esta lista, una lista truncada le haría creer que las
 * imágenes que faltan no existen, y al publicar borraría contenido real del
 * cliente. Trees pagina de verdad y además avisa con `truncated`.
 */
async function rutaList(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/git/trees/${env.GITHUB_BRANCH}?recursive=1`;
  const respuesta = await fetch(url, { headers: cabecerasGitHub(env) });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    return json({ ok: false, error: `GitHub ${respuesta.status}: ${detalle.slice(0, 300)}` }, 502);
  }
  const arbol = await respuesta.json();

  // Fallo explícito y ruidoso. Un árbol truncado significa que la lista está
  // incompleta; seguir adelante con datos incompletos es peor que parar.
  if (arbol.truncated) {
    return json({
      ok: false,
      error: 'El árbol del repositorio viene truncado: la lista de archivos está incompleta. ' +
             'El panel se detiene para no publicar un estado que borraría contenido. ' +
             'Es señal de que el repo tiene demasiados archivos y hay que archivar imágenes antiguas.',
    }, 507);
  }

  const archivos = (arbol.tree || [])
    .filter((n) => n.type === 'blob' && RE_UPLOAD.test(n.path))
    .map((n) => ({ path: n.path, sha: n.sha, size: n.size }));

  return json({ ok: true, archivos });
}

/** POST /api/upload — sube una imagen en base64. */
async function rutaUpload(env, cuerpo) {
  // Saneado primero: cualquier carácter raro se neutraliza antes de validar.
  const path = String(cuerpo.path ?? '').replace(/[^\w.\-\/]/g, '_');

  if (!RE_UPLOAD.test(path)) {
    return json({
      ok: false,
      error: 'Ruta no permitida. Solo imágenes (.jpg, .jpeg, .png, .webp, .gif en minúsculas) dentro de contenido/imagenes/.',
    }, 400);
  }

  const base64 = String(cuerpo.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) return json({ ok: false, error: 'Falta el contenido de la imagen.' }, 400);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return json({ ok: false, error: 'El contenido no es base64 válido.' }, 400);
  }

  // Longitud real aproximada a partir del base64, sin decodificarlo en memoria.
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES_IMAGEN) {
    return json({
      ok: false,
      error: `La imagen pesa ${(bytes / 1048576).toFixed(1)} MB y el máximo son ${MAX_BYTES_IMAGEN / 1048576} MB. Redúcela antes de subirla.`,
    }, 413);
  }

  await escribirArchivo(env, path, base64, `Panel: sube ${path}`);
  return json({ ok: true, path });
}

/** POST /api/save — guarda un JSON de estado. */
async function rutaSave(env, cuerpo) {
  const path = String(cuerpo.path ?? '');

  // Coincidencia exacta contra la lista cerrada. Sin saneado previo a propósito:
  // si el path no es literalmente uno de los dos permitidos, es un error o un
  // ataque, y en ninguno de los dos casos queremos "arreglarlo".
  if (!RE_SAVE.test(path)) {
    return json({ ok: false, error: 'Ruta no permitida. Solo datos/contenido.json y datos/ajustes.json.' }, 400);
  }

  // Se valida que sea JSON parseable ANTES de commitearlo. Publicar un JSON
  // roto dejaría el sitio público tirando de fallback sin que nadie se entere.
  let texto;
  try {
    texto = JSON.stringify(cuerpo.contenido, null, 2);
    JSON.parse(texto);
  } catch {
    return json({ ok: false, error: 'El contenido no es un JSON válido.' }, 400);
  }

  await escribirArchivo(env, path, aBase64(texto + '\n'), `Panel: actualiza ${path}`);
  return json({ ok: true, path });
}

/** POST /api/delete — borra una imagen. */
async function rutaDelete(env, cuerpo) {
  const path = String(cuerpo.path ?? '').replace(/[^\w.\-\/]/g, '_');

  if (!RE_DELETE.test(path)) {
    return json({ ok: false, error: 'Ruta no permitida. Solo se pueden borrar imágenes de contenido/imagenes/.' }, 400);
  }

  const sha = await shaOf(env, path);
  if (!sha) return json({ ok: false, error: 'Ese archivo no existe.' }, 404);

  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;
  const respuesta = await fetch(url, {
    method: 'DELETE',
    headers: cabecerasGitHub(env),
    body: JSON.stringify({ message: `Panel: borra ${path}`, sha, branch: env.GITHUB_BRANCH }),
  });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    return json({ ok: false, error: `GitHub ${respuesta.status}: ${detalle.slice(0, 300)}` }, 502);
  }
  return json({ ok: true, path });
}

/* =============================================================================
   ENTRADA ÚNICA
   ========================================================================== */

export async function onRequest(contexto) {
  const { request, env, params } = contexto;

  // El panel se sirve desde el mismo origen, así que no hace falta CORS abierto.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Solo se admite POST.' }, 405);
  }

  // Sin variables no hay nada que hacer, y el mensaje debe decir exactamente
  // cuáles faltan: es el error nº1 al desplegar por primera vez.
  const requeridas = ['ADMIN_PASSWORD', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
  const faltan = requeridas.filter((v) => !env[v]);
  if (faltan.length) {
    return json({
      ok: false,
      error: `Faltan variables de entorno en Cloudflare: ${faltan.join(', ')}. ` +
             'Configúralas en Settings → Environment variables → Production y vuelve a desplegar.',
    }, 500);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'desconocida';
  if (estaBloqueada(ip)) {
    return json({ ok: false, error: 'Demasiados intentos fallidos. Espera un minuto.' }, 429);
  }

  let cuerpo;
  try {
    cuerpo = await request.json();
  } catch {
    return json({ ok: false, error: 'El cuerpo de la petición no es JSON válido.' }, 400);
  }

  // La clave se valida en TODAS las rutas, no solo en /api/login. Si solo se
  // validara en el login, /api/save quedaría abierta a cualquiera que supiera
  // la URL: el login no deja rastro de sesión que las demás rutas puedan mirar.
  if (!clavesIguales(cuerpo.clave, env.ADMIN_PASSWORD)) {
    apuntarFallo(ip);
    return json({ ok: false, error: 'Contraseña incorrecta.' }, 401);
  }
  limpiarFallos(ip);

  const ruta = (params.route || []).join('/');

  try {
    switch (ruta) {
      case 'login':  return await rutaLogin();
      case 'list':   return await rutaList(env);
      case 'upload': return await rutaUpload(env, cuerpo);
      case 'save':   return await rutaSave(env, cuerpo);
      case 'delete': return await rutaDelete(env, cuerpo);
      default:       return json({ ok: false, error: `Ruta desconocida: /api/${ruta}` }, 404);
    }
  } catch (error) {
    // Nunca se filtra el stack al navegador: podría revelar el repo o el token.
    return json({ ok: false, error: String(error.message || error).slice(0, 300) }, 502);
  }
}
