/**
 * PULSO NOTICIOSO — Worker de la API
 * =============================================================================
 * POR QUÉ ESTE ARCHIVO EXISTE Y NO ESTÁ EN EL REPO DEL SITIO
 * -----------------------------------------------------------------------------
 * El sitio vive en GitHub Pages (repo Q) porque el dominio pulsonoticioso.org
 * está apuntado desde GoDaddy hacia GitHub, y moverlo es un lío que no aporta.
 *
 * Pero GitHub Pages SOLO sirve archivos estáticos: no ejecuta código. Y el panel
 * necesita un servidor para dos cosas que no pueden vivir en el navegador:
 *   1. Guardar el token de GitHub sin que nadie lo vea.
 *   2. Validar la contraseña.
 *
 * La solución: este Worker vive aparte, en Cloudflare, con su propia URL
 * (...workers.dev). El panel, que sigue en pulsonoticioso.org, le habla por
 * HTTPS. El Worker hace los commits en el repo Q → GitHub Pages reconstruye →
 * el dominio se actualiza. El token nunca sale de Cloudflare.
 *
 *   navegador (pulsonoticioso.org/admin.html)
 *        │  POST con la contraseña
 *        ▼
 *   Worker (pulso-api.xxx.workers.dev)  ← ADMIN_PASSWORD + GITHUB_TOKEN cifrados
 *        │  API de GitHub con el token
 *        ▼
 *   commit en riosdigitali-create/Q → GitHub Pages → pulsonoticioso.org
 *
 * DIFERENCIA CLAVE CON UNA PAGES FUNCTION: al estar en OTRO dominio, el
 * navegador aplica CORS. Por eso este archivo tiene toda la parte de orígenes
 * permitidos que una función del mismo dominio no necesitaría.
 */

/* =============================================================================
   CORS — quién puede llamar a esta API
   -----------------------------------------------------------------------------
   Lista blanca cerrada. Sin esto, o con un "*", cualquier página de internet
   podría montar un formulario que llame a esta API. No les daría la contraseña,
   pero sí les dejaría probar contraseñas a fuerza bruta desde los navegadores de
   sus visitantes, saltándose el rate limiting por IP.
   ========================================================================== */
const ORIGENES_PERMITIDOS = new Set([
  'https://pulsonoticioso.org',
  'https://www.pulsonoticioso.org',
]);

/**
 * Devuelve las cabeceras CORS para un origen concreto, o null si no está permitido.
 * NUNCA se responde con Access-Control-Allow-Origin: * — con credenciales en el
 * body, eso sería abrir la API a todo internet.
 */
function cabecerasCORS(request) {
  const origen = request.headers.get('origin');
  if (!origen || !ORIGENES_PERMITIDOS.has(origen)) return null;
  return {
    'access-control-allow-origin': origen,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    // Le dice a las cachés que la respuesta cambia según el origen que la pidió.
    vary: 'Origin',
  };
}

/* =============================================================================
   ALLOWLIST DE RUTAS — la parte más importante del archivo
   -----------------------------------------------------------------------------
   Este Worker NO es un proxy genérico a GitHub. Con la contraseña correcta, sin
   estas tres regex, un atacante podría sobrescribir index.html o admin.html en
   el repo Q y ejecutar lo que quisiera en pulsonoticioso.org. La contraseña es
   UNA capa; la allowlist es la que limita el daño de verdad.
   ========================================================================== */

// Sin el flag /i a propósito: con /i, "CONTENIDO/IMAGENES/x.jpg" pasaría, y como
// Git distingue mayúsculas eso crearía una carpeta paralela real que el panel
// nunca listaría — archivos huérfanos e invisibles. Directorio y extensión en
// minúsculas; el panel ya los genera así. El nombre (\w) sí admite mayúsculas.
const RE_UPLOAD = /^contenido\/imagenes\/[\w.\-]+\.(?:jpe?g|png|webp|gif)$/;

// Lista cerrada y explícita. Solo estos dos archivos son escribibles.
const RE_SAVE = /^datos\/(contenido|ajustes)\.json$/;

// Solo imágenes. Los JSON de estado no se borran nunca desde la API: si se
// pudieran borrar, un fallo del panel dejaría el sitio sin contenido.
const RE_DELETE = /^contenido\/imagenes\/[\w.\-]+\.(?:jpe?g|png|webp|gif)$/;

// GitHub admite hasta 100 MB por archivo, pero una foto de portada de más de
// 5 MB es siempre un error del usuario. Cortarlo aquí evita commits gigantes e
// irreversibles: Git guarda todas las versiones para siempre.
const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;

/* =============================================================================
   RATE LIMITING
   -----------------------------------------------------------------------------
   Vive en la memoria del isolate. Es un freno real pero imperfecto: no cuenta de
   forma global entre centros de datos ni sobrevive al reciclado del proceso.
   Convierte un ataque de miles de intentos por segundo en uno de unos pocos por
   minuto y por PoP. La defensa de verdad es una contraseña larga.
   ========================================================================== */
const intentosFallidos = new Map(); // ip -> { n, ultimo, bloqueadoHasta }
const MAX_INTENTOS = 8;
const BLOQUEO_MS = 60 * 1000;
const VENTANA_MS = 10 * 60 * 1000;
const MAX_IPS = 5000;

function estaBloqueada(ip) {
  const registro = intentosFallidos.get(ip);
  if (!registro) return false;
  if (registro.bloqueadoHasta > Date.now()) return true;

  // Ojo con esta condición: la versión ingenua era borrar el registro siempre que
  // la IP no estuviera bloqueada, y eso reseteaba el contador en CADA petición —
  // el bloqueo no se disparaba nunca. Solo se limpia si el bloqueo ya expiró, o
  // si la IP lleva callada más que la ventana.
  if (registro.bloqueadoHasta > 0 || Date.now() - registro.ultimo > VENTANA_MS) {
    intentosFallidos.delete(ip);
  }
  return false;
}

function apuntarFallo(ip) {
  // Techo defensivo: un atacante rotando IPs haría crecer el Map hasta agotar la
  // memoria. Vaciarlo entero solo relaja el freno, nunca abre una puerta.
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

/* =============================================================================
   UTILIDADES
   ========================================================================== */

function json(datos, estado, cors) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(cors || {}),
    },
  });
}

/**
 * Compara dos claves en tiempo constante.
 *
 * Por qué no `===`: la comparación de strings de JavaScript aborta en el primer
 * byte distinto. Eso hace que "a....." tarde mediblemente menos que "2367..", y
 * con suficientes muestras la clave se reconstruye carácter a carácter midiendo
 * tiempos de respuesta. El XOR recorre siempre todos los bytes.
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

/** Texto UTF-8 → base64, que es lo que exige la API de GitHub. */
function aBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let binario = '';
  // En trozos: String.fromCharCode(...array) revienta la pila con arrays grandes
  // y el JSON de contenido puede tener cientos de KB.
  const TROZO = 0x8000;
  for (let i = 0; i < bytes.length; i += TROZO) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + TROZO));
  }
  return btoa(binario);
}

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
 * GitHub exige el sha del blob anterior para sobrescribir: es su control de
 * concurrencia. Sin él, el PUT falla con 409. Un 404 aquí no es error: significa
 * "archivo nuevo".
 */
async function shaOf(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${env.GITHUB_BRANCH}`;
  const respuesta = await fetch(url, { headers: cabecerasGitHub(env) });
  if (respuesta.status === 404) return null;
  if (!respuesta.ok) throw new Error(`GitHub ${respuesta.status} al leer el sha de ${path}`);
  const datos = await respuesta.json();
  return datos.sha || null;
}

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
function rutaLogin(cors) {
  // La clave ya se validó en fetch(), común a todas las rutas. Esta ruta no crea
  // sesión ni devuelve token: solo un "sí".
  return json({ ok: true, publicacion: true }, 200, cors);
}

/**
 * POST /api/list — lista las imágenes publicadas.
 *
 * POR QUÉ TREES Y NO /contents (crítico, no lo cambies): /contents devuelve como
 * mucho 1000 entradas y NO pagina — corta en silencio, sin error ni aviso. Como
 * el panel reconstruye su vista del contenido a partir de esta lista, una lista
 * truncada le haría creer que las imágenes que faltan no existen, y al publicar
 * borraría contenido real. Trees pagina de verdad y avisa con `truncated`.
 */
async function rutaList(env, cors) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/git/trees/${env.GITHUB_BRANCH}?recursive=1`;
  const respuesta = await fetch(url, { headers: cabecerasGitHub(env) });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    return json({ ok: false, error: `GitHub ${respuesta.status}: ${detalle.slice(0, 300)}` }, 502, cors);
  }
  const arbol = await respuesta.json();

  // Fallo explícito y ruidoso. Seguir con datos incompletos es peor que parar.
  if (arbol.truncated) {
    return json({
      ok: false,
      error: 'El árbol del repositorio viene truncado: la lista de archivos está incompleta. ' +
             'El panel se detiene para no publicar un estado que borraría contenido. ' +
             'Hay demasiados archivos en el repo: archiva imágenes antiguas.',
    }, 507, cors);
  }

  const archivos = (arbol.tree || [])
    .filter((n) => n.type === 'blob' && RE_UPLOAD.test(n.path))
    .map((n) => ({ path: n.path, sha: n.sha, size: n.size }));

  return json({ ok: true, archivos }, 200, cors);
}

/** POST /api/upload — sube una imagen en base64. */
async function rutaUpload(env, cuerpo, cors) {
  // Saneado primero: cualquier carácter raro se neutraliza antes de validar.
  const path = String(cuerpo.path ?? '').replace(/[^\w.\-\/]/g, '_');

  if (!RE_UPLOAD.test(path)) {
    return json({
      ok: false,
      error: 'Ruta no permitida. Solo imágenes (.jpg, .jpeg, .png, .webp, .gif en minúsculas) dentro de contenido/imagenes/.',
    }, 400, cors);
  }

  const base64 = String(cuerpo.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) return json({ ok: false, error: 'Falta el contenido de la imagen.' }, 400, cors);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return json({ ok: false, error: 'El contenido no es base64 válido.' }, 400, cors);
  }

  // Longitud real aproximada desde el base64, sin decodificarlo en memoria.
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES_IMAGEN) {
    return json({
      ok: false,
      error: `La imagen pesa ${(bytes / 1048576).toFixed(1)} MB y el máximo son ${MAX_BYTES_IMAGEN / 1048576} MB. Redúcela antes de subirla.`,
    }, 413, cors);
  }

  await escribirArchivo(env, path, base64, `Panel: sube ${path}`);
  return json({ ok: true, path }, 200, cors);
}

/** POST /api/save — guarda un JSON de estado. */
async function rutaSave(env, cuerpo, cors) {
  const path = String(cuerpo.path ?? '');

  // Coincidencia exacta contra la lista cerrada. Sin saneado previo a propósito:
  // si el path no es literalmente uno de los dos permitidos es un error o un
  // ataque, y en ninguno de los dos casos queremos "arreglarlo".
  if (!RE_SAVE.test(path)) {
    return json({ ok: false, error: 'Ruta no permitida. Solo datos/contenido.json y datos/ajustes.json.' }, 400, cors);
  }

  // Se valida que sea JSON parseable ANTES de commitearlo: publicar un JSON roto
  // dejaría el sitio tirando de respaldo sin que nadie se entere.
  let texto;
  try {
    texto = JSON.stringify(cuerpo.contenido, null, 2);
    JSON.parse(texto);
  } catch {
    return json({ ok: false, error: 'El contenido no es un JSON válido.' }, 400, cors);
  }

  await escribirArchivo(env, path, aBase64(texto + '\n'), `Panel: actualiza ${path}`);
  return json({ ok: true, path }, 200, cors);
}

/** POST /api/delete — borra una imagen. */
async function rutaDelete(env, cuerpo, cors) {
  const path = String(cuerpo.path ?? '').replace(/[^\w.\-\/]/g, '_');

  if (!RE_DELETE.test(path)) {
    return json({ ok: false, error: 'Ruta no permitida. Solo se pueden borrar imágenes de contenido/imagenes/.' }, 400, cors);
  }

  const sha = await shaOf(env, path);
  if (!sha) return json({ ok: false, error: 'Ese archivo no existe.' }, 404, cors);

  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;
  const respuesta = await fetch(url, {
    method: 'DELETE',
    headers: cabecerasGitHub(env),
    body: JSON.stringify({ message: `Panel: borra ${path}`, sha, branch: env.GITHUB_BRANCH }),
  });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    return json({ ok: false, error: `GitHub ${respuesta.status}: ${detalle.slice(0, 300)}` }, 502, cors);
  }
  return json({ ok: true, path }, 200, cors);
}

/* =============================================================================
   ENTRADA ÚNICA
   ========================================================================== */

export default {
  async fetch(request, env) {
    const cors = cabecerasCORS(request);

    // Preflight. El navegador lo manda solo, antes del POST, para preguntar si
    // este origen tiene permiso. Si no está en la lista blanca, se le niega aquí
    // y el POST real ni llega a salir.
    if (request.method === 'OPTIONS') {
      if (!cors) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { ...cors, 'cache-control': 'no-store' } });
    }

    // Origen no permitido: se corta antes de mirar siquiera la contraseña.
    if (!cors) {
      return json({ ok: false, error: 'Origen no permitido.' }, 403, null);
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Solo se admite POST.' }, 405, cors);
    }

    // Sin variables no hay nada que hacer, y el mensaje debe decir exactamente
    // cuáles faltan: es el error nº1 al desplegar por primera vez.
    const requeridas = ['ADMIN_PASSWORD', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
    const faltan = requeridas.filter((v) => !env[v]);
    if (faltan.length) {
      return json({
        ok: false,
        error: `Faltan variables de entorno en el Worker: ${faltan.join(', ')}. ` +
               'Configúralas en Settings → Variables and Secrets y vuelve a desplegar.',
      }, 500, cors);
    }

    const ip = request.headers.get('cf-connecting-ip') || 'desconocida';
    if (estaBloqueada(ip)) {
      return json({ ok: false, error: 'Demasiados intentos fallidos. Espera un minuto.' }, 429, cors);
    }

    let cuerpo;
    try {
      cuerpo = await request.json();
    } catch {
      return json({ ok: false, error: 'El cuerpo de la petición no es JSON válido.' }, 400, cors);
    }

    // La clave se valida en TODAS las rutas, no solo en /api/login. Si solo se
    // validara en el login, /api/save quedaría abierta a cualquiera que supiera
    // la URL: el login no deja rastro de sesión que las demás rutas puedan mirar.
    if (!clavesIguales(cuerpo.clave, env.ADMIN_PASSWORD)) {
      apuntarFallo(ip);
      return json({ ok: false, error: 'Contraseña incorrecta.' }, 401, cors);
    }

    const ruta = new URL(request.url).pathname.replace(/^\/api\//, '').replace(/\/$/, '');

    try {
      switch (ruta) {
        case 'login':  return rutaLogin(cors);
        case 'list':   return await rutaList(env, cors);
        case 'upload': return await rutaUpload(env, cuerpo, cors);
        case 'save':   return await rutaSave(env, cuerpo, cors);
        case 'delete': return await rutaDelete(env, cuerpo, cors);
        default:       return json({ ok: false, error: `Ruta desconocida: /api/${ruta}` }, 404, cors);
      }
    } catch (error) {
      // Nunca se filtra el stack al navegador: podría revelar el repo o el token.
      return json({ ok: false, error: String(error.message || error).slice(0, 300) }, 502, cors);
    }
  },
};
