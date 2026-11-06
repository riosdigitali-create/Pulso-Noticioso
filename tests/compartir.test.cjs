const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const identidad = fs.readFileSync(path.join(root, 'notas.js'), 'utf8');

function lector(notas, href = 'https://pulsonoticioso.org/') {
  const elementos = new Map();
  const elemento = id => {
    if (!elementos.has(id)) elementos.set(id, {
      textContent: '', innerHTML: '', style: {},
      classList: { add() {}, remove() {} }, addEventListener() {}
    });
    return elementos.get(id);
  };
  const window = { location: { href }, history: {
    replaceState(_state, _title, url) { window.location.href = url; }
  }};
  const ctx = vm.createContext({
    URL, window, navigator: {}, TODAS: notas,
    document: { getElementById: elemento, body: { style: {} }, addEventListener() {} },
    arte: () => '', fotoHTML: () => '', esc: text => String(text || '')
  });
  vm.runInContext(identidad, ctx);
  vm.runInContext(index.slice(index.indexOf('const modal ='), index.indexOf('/* ===== Tabs de sección')), ctx);
  return { ctx, window, elemento };
}

test('los scripts del lector y del panel tienen sintaxis válida', () => {
  for (const html of [index, admin]) {
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    assert.match(html, /<script src="notas\.js"><\/script>/);
  }
  new vm.Script(identidad);
});

test('WhatsApp y Facebook reciben el enlace y al abrirlo aparece la nota correcta', async () => {
  const notas = [{ tit: 'México & Coahuila: ¿qué pasó?', cuerpo: ['Texto completo'] }, { tit: 'Otra noticia' }];
  const { ctx, window, elemento } = lector(notas, 'https://pulsonoticioso.org/?origen=prueba#inicio');
  vm.runInContext('abrirNota(0)', ctx);
  const enlace = window.location.href;
  assert.equal(new URL(enlace).hash, '');
  assert.equal(new URL(enlace).searchParams.has('origen'), false);
  const mensaje = new URL(elemento('mod-wa').href).searchParams.get('text');
  assert.ok(mensaje.includes(notas[0].tit));
  assert.ok(mensaje.includes(enlace));
  assert.equal(new URL(elemento('mod-fb').href).searchParams.get('u'), enlace);
  let copiado;
  ctx.navigator.clipboard = { writeText: async value => { copiado = value; } };
  await elemento('mod-copiar').onclick();
  assert.equal(copiado, enlace);
  assert.equal(elemento('mod-copiar').textContent, '¡Copiado!');
  const recarga = lector([...notas].reverse(), enlace);
  vm.runInContext('abrirNotaDesdeURL()', recarga.ctx);
  assert.equal(recarga.elemento('mod-tit').textContent, notas[0].tit);
  vm.runInContext('cerrarNota()', ctx);
  assert.equal(new URL(window.location.href).searchParams.has('nota'), false);
});

test('un fallo del portapapeles muestra un enlace para copiar manualmente', async () => {
  const { ctx, elemento, window } = lector([{ tit: 'Noticia' }]);
  vm.runInContext('abrirNota(0)', ctx);
  await elemento('mod-copiar').onclick();
  assert.equal(elemento('mod-copiar').textContent, 'Copiar enlace');
  assert.ok(elemento('mod-estado').textContent.includes(window.location.href));
  ctx.navigator.clipboard = { writeText: async () => { throw new Error('Permiso denegado'); } };
  await elemento('mod-copiar').onclick();
  assert.equal(elemento('mod-copiar').textContent, 'Copiar enlace');
});

test('editar el título mantiene el enlace anterior y las notas nuevas reciben identidad propia', () => {
  const original = { tit: 'Título anterior' };
  const lista = [original];
  const campos = { fTit: 'Título corregido', fImg: '', fCat: 'local', fEtq: '', fRes: '', fCuerpo: 'Texto', fMeta: '' };
  const ctx = vm.createContext({
    URL, window: {}, crypto: { randomUUID: () => 'uuid-nueva' },
    CONTENIDO: { destacada: { tit: 'Portada anterior' } },
    refColeccion: () => lista, $: id => ({ value: campos[id] }),
    toast() {}, guardarBorrador() {}, render() {}
  });
  vm.runInContext(identidad, ctx);
  const anterior = vm.runInContext('PulsoNotas.enlace(refColeccion()[0], "https://pulsonoticioso.org/")', ctx);
  vm.runInContext(admin.slice(admin.indexOf('window.guardarNota ='), admin.indexOf('window.moverNota =')), ctx);
  ctx.window.guardarNota('local', 0);
  assert.equal(original.tit, 'Título corregido');
  assert.equal(vm.runInContext('PulsoNotas.enlace(refColeccion()[0], "https://pulsonoticioso.org/")', ctx), anterior);
  const recarga = lector(lista, anterior);
  vm.runInContext('abrirNotaDesdeURL()', recarga.ctx);
  assert.equal(recarga.elemento('mod-tit').textContent, 'Título corregido');
  ctx.window.guardarNota('local', -2);
  assert.equal(lista[0].id, 'uuid-nueva');
  ctx.window.guardarNota('destacada', -1);
  assert.equal(ctx.CONTENIDO.destacada.id, 'titulo-Portada anterior');
});

test('un enlace de una nota eliminada no abre otra nota', () => {
  const { ctx, elemento } = lector([{ tit: 'Otra noticia' }], 'https://pulsonoticioso.org/?nota=eliminada');
  vm.runInContext('abrirNotaDesdeURL()', ctx);
  assert.equal(elemento('mod-tit').textContent, '');
});
