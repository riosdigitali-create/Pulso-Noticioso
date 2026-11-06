const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

function fuente(respuestas) {
  const peticiones = [];
  const ctx = vm.createContext({
    URL, AbortController, setTimeout: () => 1, clearTimeout() {},
    console: { warn() {} }, API_NOTICIAS: 'https://pulso-api.riosdigitali.workers.dev/api/noticias',
    document: { createElement: () => ({ set innerHTML(v) { this.value = v; } }) },
    fetch: async url => {
      peticiones.push(url);
      const r = respuestas.shift();
      if (!r) throw new Error('Petición inesperada');
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    }
  });
  vm.runInContext(index.slice(index.indexOf('function esEnlaceDiario('), index.indexOf('const CATMAP')), ctx);
  vm.runInContext(index.slice(index.indexOf('function tituloFuente('), index.indexOf('function resumenDe(')), ctx);
  vm.runInContext(index.slice(index.indexOf('async function fetchFeed('), index.indexOf('function cardVivo(')), ctx);
  return { ctx, peticiones };
}

test('la configuración publicada usa exclusivamente El Diario', () => {
  const ajustes = JSON.parse(fs.readFileSync(path.join(root, 'datos/ajustes.json'), 'utf8'));
  assert.equal(ajustes.vivo.fuentePrincipal, 'https://eldiariodecoahuila.com.mx/feed/');
  assert.equal(ajustes.vivo.respaldoGoogle, false);
  assert.ok(!index.includes('fetchFeed(CONFIG.vivo.fuentePrincipal)'));
  assert.ok(!index.includes('function feedsRespaldo('));
});

test('la consulta directa excluye enlaces de otros medios y dominios parecidos', async () => {
  const { ctx, peticiones } = fuente([{ status: 200, body: [
    { link: 'https://eldiariodecoahuila.com.mx/noticia/', title: { rendered: 'El Diario' } },
    { link: 'https://vanguardia.com.mx/noticia/', title: { rendered: 'Otro medio' } },
    { link: 'https://eldiariodecoahuila.com.mx.otro.com/noticia/' }
  ] }]);
  const data = await vm.runInContext('fetchFeed()', ctx);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].title, 'El Diario');
  assert.equal(peticiones.length, 1);
});

test('si El Diario bloquea la consulta, el respaldo exige su dominio y editor', async () => {
  const { ctx, peticiones } = fuente([
    { status: 502 },
    { status: 200, body: { status: 'ok', items: [
      { title: 'Noticia de Saltillo - El Diario de Coahuila', link: 'https://news.google.com/rss/articles/diario' },
      { title: 'Otra noticia - Vanguardia', link: 'https://news.google.com/rss/articles/otro' }
    ] } }
  ]);
  const data = await vm.runInContext('fetchFeed()', ctx);
  assert.equal(data.items.length, 1);
  assert.match(data.items[0].title, /El Diario de Coahuila$/);
  assert.equal(data.feed.title, 'El Diario de Coahuila');
  const rss = new URL(new URL(peticiones[1]).searchParams.get('rss_url'));
  assert.equal(rss.searchParams.get('q'), 'site:eldiariodecoahuila.com.mx');
});

test('si no hay notas verificadas no se sustituyen por otro medio', async () => {
  const { ctx, peticiones } = fuente([
    { status: 502 },
    { status: 200, body: { status: 'ok', items: [{ title: 'Noticia - Otro periódico' }] } }
  ]);
  await assert.rejects(vm.runInContext('fetchFeed()', ctx), /sin notas verificadas/);
  assert.equal(peticiones.length, 2);
});

test('restaurar un borrador antiguo corrige la fuente y conserva los demás ajustes', () => {
  const ctx = vm.createContext({
    clon: obj => JSON.parse(JSON.stringify(obj)),
    AJUSTES_RESPALDO: { vivo: { activo: true, tickerEnVivo: true } }
  });
  const start = admin.indexOf('function ajustesSoloDiario(');
  vm.runInContext(admin.slice(start, admin.indexOf('\n}', start) + 2), ctx);
  const ajustes = vm.runInContext('ajustesSoloDiario({radioStreamURL:"mi-radio",vivo:{fuentePrincipal:"https://vanguardia.com.mx/rss.xml",respaldoGoogle:true,activo:false}})', ctx);
  assert.equal(ajustes.vivo.fuentePrincipal, 'https://eldiariodecoahuila.com.mx/feed/');
  assert.equal(ajustes.vivo.respaldoGoogle, false);
  assert.equal(ajustes.vivo.activo, false);
  assert.equal(ajustes.radioStreamURL, 'mi-radio');
});
